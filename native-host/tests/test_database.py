from __future__ import annotations

import concurrent.futures
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from database import LOCK_RETRIES, SharedVisitDatabase, with_lock_retry
from visited_page_tracker_host import handle_import
from schemas import HostError


def visit(at: int, event_id: str | None = None, url: str = "https://example.com/") -> dict:
    return {
        "normalizedUrl": url,
        "originalUrl": url,
        "hostname": "example.com" if "example.com" in url else "other.test",
        "title": "Example",
        "visitedAt": at,
        "transitionType": "link",
        "tabId": 1,
        "incognito": False,
        "eventId": event_id,
        "storageSource": "shared",
    }


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name)
        self.db = SharedVisitDatabase({"directory": str(path), "filename": "test.sqlite3", "path": str(path / "test.sqlite3")})
        self.db.configure()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_first_repeat_and_visit_history(self) -> None:
        first = self.db.record_visit(visit(1000, "a"))
        second = self.db.record_visit(visit(2000, "b"))
        self.assertFalse(first["wasSeen"])
        self.assertTrue(second["wasSeen"])
        self.assertEqual(second["visitCount"], 2)
        events = self.db.get_visit_events("https://example.com/", 0, 10)
        self.assertEqual([item["visitedAt"] for item in events], [2000, 1000])

    def test_duplicate_event_rolls_back_page_increment(self) -> None:
        self.db.record_visit(visit(1000, "duplicate"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.record_visit(visit(2000, "duplicate"))
        self.assertEqual(self.db.get_page("https://example.com/")["visitCount"], 1)

    def test_title_suppression_removes_existing_title(self) -> None:
        self.db.record_visit(visit(1000, "title-1"))
        suppressed = visit(2000, "title-2")
        suppressed["suppressTitle"] = True
        suppressed["title"] = None
        self.db.record_visit(suppressed)
        self.assertIsNone(self.db.get_page("https://example.com/")["title"])

    def test_simultaneous_writes(self) -> None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda index: self.db.record_visit(visit(10_000 + index, f"event-{index}")), range(20)))
        self.assertEqual(len(results), 20)
        self.assertEqual(self.db.get_page("https://example.com/")["visitCount"], 20)

    def test_lock_retry_helper(self) -> None:
        attempts = {"count": 0}
        def operation() -> str:
            attempts["count"] += 1
            if attempts["count"] < 4:
                raise sqlite3.OperationalError("database is locked")
            return "ok"
        self.assertEqual(with_lock_retry(operation), "ok")
        self.assertEqual(attempts["count"], 4)

    def test_lock_retry_is_bounded(self) -> None:
        attempts = {"count": 0}
        def operation() -> None:
            attempts["count"] += 1
            raise sqlite3.OperationalError("database is locked")
        with patch("database.time.sleep", return_value=None), self.assertRaises(HostError) as raised:
            with_lock_retry(operation)
        self.assertEqual(raised.exception.code, "DATABASE_LOCKED")
        self.assertEqual(attempts["count"], LOCK_RETRIES)

    def test_configure_creates_missing_directories(self) -> None:
        directory = Path(self.temp.name) / "missing" / "nested"
        database = SharedVisitDatabase({
            "directory": str(directory),
            "filename": "created.sqlite3",
            "path": str(directory / "created.sqlite3"),
        })
        status = database.configure()
        self.assertTrue(directory.is_dir())
        self.assertTrue(Path(status["path"]).is_file())

    def test_permission_errors_are_structured(self) -> None:
        directory = Path(self.temp.name) / "denied"
        database = SharedVisitDatabase({
            "directory": str(directory),
            "filename": "denied.sqlite3",
            "path": str(directory / "denied.sqlite3"),
        })
        with patch.object(Path, "mkdir", side_effect=PermissionError("denied")), self.assertRaises(HostError) as raised:
            database.configure()
        self.assertEqual(raised.exception.code, "PERMISSION_DENIED")

    def test_import_merge_migration_and_backup(self) -> None:
        self.db.record_visit(visit(1000, "a"))
        bundle = {
            "schemaVersion": 1,
            "exportedAt": 2000,
            "storageMode": "perProfile",
            "pages": [{
                "normalizedUrl": "https://example.com/", "lastOriginalUrl": "https://example.com/", "hostname": "example.com", "title": "Example",
                "visitCount": 2, "firstVisitedAt": 1000, "lastVisitedAt": 2000, "createdAt": 1000, "updatedAt": 2000, "storageSource": "per-profile"
            }],
            "visits": [
                {"id":"a","normalizedUrl":"https://example.com/","originalUrl":"https://example.com/","visitedAt":1000,"transitionType":"link","tabId":1,"incognito":False,"storageSource":"per-profile"},
                {"id":"b","normalizedUrl":"https://example.com/","originalUrl":"https://example.com/","visitedAt":2000,"transitionType":"link","tabId":1,"incognito":False,"storageSource":"per-profile"}
            ]
        }
        merged = self.db.import_data(bundle, "merge")
        self.assertEqual(merged["skippedVisits"], 1)
        self.assertEqual(self.db.get_page("https://example.com/")["visitCount"], 2)
        replaced = self.db.import_data(bundle, "replace")
        self.assertTrue(Path(replaced["backupPath"]).exists())


    def test_chunked_export_and_staged_import_commit_atomically(self) -> None:
        for index in range(6):
            self.db.record_visit(visit(1000 + index, f"chunk-{index}", f"https://example.com/{index}"))
        page_offset = 0
        visit_offset = 0
        pages = []
        visits = []
        while True:
            chunk = self.db.export_data_chunk(page_offset, visit_offset, 128_000)
            pages.extend(chunk["pages"])
            visits.extend(chunk["visits"])
            page_offset = chunk["nextPageOffset"]
            visit_offset = chunk["nextVisitOffset"]
            if chunk["done"]:
                break
        self.assertEqual(len(pages), 6)
        self.assertEqual(len(visits), 6)

        other_path = Path(self.temp.name) / "imported.sqlite3"
        target = SharedVisitDatabase({"directory": self.temp.name, "filename": "imported.sqlite3", "path": str(other_path)})
        target.configure()
        metadata = {"schemaVersion": 1, "exportedAt": 9999, "storageMode": "shared"}
        handle_import(target, {"phase":"begin","sessionId":"s1","mode":"replace","metadata":metadata,"totalPages":len(pages),"totalVisits":len(visits)})
        handle_import(target, {"phase":"chunk","sessionId":"s1","pages":pages[:3],"visits":visits[:2]})
        self.assertEqual(target.get_statistics()["totalVisits"], 0)
        handle_import(target, {"phase":"chunk","sessionId":"s1","pages":pages[3:],"visits":visits[2:]})
        result = handle_import(target, {"phase":"commit","sessionId":"s1"})
        self.assertEqual(result["importedVisits"], 6)
        self.assertEqual(target.get_statistics()["totalVisits"], 6)

    def test_delete_page_domain_clear_and_retention(self) -> None:
        self.db.record_visit(visit(1000, "a", "https://example.com/a"))
        self.db.record_visit(visit(2000, "b", "https://example.com/b"))
        self.db.record_visit(visit(3000, "c", "https://other.test/"))
        self.db.delete_page("https://example.com/a")
        self.assertIsNone(self.db.get_page("https://example.com/a"))
        self.assertEqual(self.db.delete_domain("example.com"), 1)
        self.assertEqual(self.db.get_statistics()["totalTrackedPages"], 1)
        self.assertEqual(self.db.remove_visits_older_than(4000), 1)
        self.assertEqual(self.db.get_statistics()["totalVisits"], 0)
        self.db.clear_history()
        self.assertEqual(self.db.get_statistics()["totalTrackedPages"], 0)


if __name__ == "__main__":
    unittest.main()
