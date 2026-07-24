"""SQLite storage implementation for Visited Page Tracker."""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator, TypeVar

from schemas import HostError, validate_import_bundle

T = TypeVar("T")
LOCK_RETRIES = 5
BUSY_TIMEOUT_MS = 750

SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    normalized_url TEXT PRIMARY KEY,
    last_original_url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    title TEXT,
    visit_count INTEGER NOT NULL DEFAULT 0,
    first_visited_at INTEGER NOT NULL,
    last_visited_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    storage_source TEXT NOT NULL DEFAULT 'shared'
);
CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    normalized_url TEXT NOT NULL,
    original_url TEXT NOT NULL,
    visited_at INTEGER NOT NULL,
    transition_type TEXT,
    tab_id INTEGER,
    incognito INTEGER NOT NULL DEFAULT 0,
    storage_source TEXT NOT NULL DEFAULT 'shared',
    FOREIGN KEY(normalized_url) REFERENCES pages(normalized_url) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pages_hostname ON pages(hostname);
CREATE INDEX IF NOT EXISTS idx_pages_last_visited ON pages(last_visited_at);
CREATE INDEX IF NOT EXISTS idx_pages_visit_count ON pages(visit_count);
CREATE INDEX IF NOT EXISTS idx_visits_url_time ON visits(normalized_url, visited_at);
"""


def _is_lock_error(exc: sqlite3.OperationalError) -> bool:
    text = str(exc).lower()
    return "locked" in text or "busy" in text


def with_lock_retry(operation: Callable[[], T]) -> T:
    delay = 0.05
    last: Exception | None = None
    for attempt in range(LOCK_RETRIES):
        try:
            return operation()
        except sqlite3.OperationalError as exc:
            if not _is_lock_error(exc):
                raise
            last = exc
            if attempt == LOCK_RETRIES - 1:
                break
            time.sleep(delay)
            delay = min(delay * 2, 0.8)
    raise HostError("DATABASE_LOCKED", f"The shared database remained locked after {LOCK_RETRIES} attempts: {last}")


class SharedVisitDatabase:
    def __init__(self, config: dict[str, str]):
        self.directory = Path(config["directory"])
        self.filename = config["filename"]
        self.path = Path(config["path"])

    def _ensure_directory(self) -> None:
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
        except PermissionError as exc:
            raise HostError("PERMISSION_DENIED", f"Cannot create the shared database directory: {exc}") from exc
        except OSError as exc:
            raise HostError("DATABASE_UNAVAILABLE", f"Cannot create the shared database directory: {exc}") from exc
        if not self.directory.is_dir():
            raise HostError("DATABASE_UNAVAILABLE", "The configured database directory is not a directory.")
        probe = self.directory / f".visited-page-tracker-write-test-{uuid.uuid4().hex}"
        try:
            with probe.open("xb") as stream:
                stream.write(b"ok")
        except PermissionError as exc:
            raise HostError("PERMISSION_DENIED", f"The shared database directory is not writable: {exc}") from exc
        except OSError as exc:
            raise HostError("DATABASE_UNAVAILABLE", f"The shared database directory cannot be written: {exc}") from exc
        finally:
            try:
                probe.unlink(missing_ok=True)
            except OSError:
                pass

    def _connect(self, *, allow_create: bool = False) -> sqlite3.Connection:
        self._ensure_directory()
        if not self.path.exists() and not allow_create:
            raise HostError("DATABASE_MISSING", "The configured shared database is missing. Use Test Connection to recreate it explicitly.")
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
            connection.execute("PRAGMA synchronous=NORMAL")
            try:
                connection.execute("PRAGMA journal_mode=WAL").fetchone()
            except sqlite3.OperationalError as exc:
                if _is_lock_error(exc):
                    raise
                connection.execute("PRAGMA journal_mode=DELETE").fetchone()
            connection.executescript(SCHEMA)
            return connection
        except Exception as exc:
            if connection is not None:
                connection.close()
            if isinstance(exc, PermissionError):
                raise HostError("PERMISSION_DENIED", f"The shared database cannot be opened: {exc}") from exc
            if isinstance(exc, sqlite3.OperationalError) and _is_lock_error(exc):
                raise
            if isinstance(exc, sqlite3.DatabaseError):
                text = str(exc).lower()
                if any(fragment in text for fragment in ("permission denied", "readonly", "read-only")):
                    code = "PERMISSION_DENIED"
                elif "malformed" in text or "not a database" in text:
                    code = "DATABASE_CORRUPT"
                else:
                    code = "DATABASE_UNAVAILABLE"
                raise HostError(code, f"The shared database cannot be opened: {exc}") from exc
            if isinstance(exc, OSError):
                raise HostError("DATABASE_UNAVAILABLE", f"The shared database cannot be opened: {exc}") from exc
            raise

    @contextmanager
    def connection(self, *, allow_create: bool = False) -> Iterator[sqlite3.Connection]:
        connection = self._connect(allow_create=allow_create)
        try:
            yield connection
        finally:
            connection.close()

    def configure(self) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            with self.connection(allow_create=True) as connection:
                journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
                connection.execute("SELECT 1").fetchone()
                return {
                    "available": True,
                    "path": str(self.path),
                    "errorCode": None,
                    "errorMessage": None,
                    "journalMode": str(journal).upper(),
                }
        return with_lock_retry(operation)

    def get_status(self) -> dict[str, Any]:
        return self.configure()

    @staticmethod
    def _page(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "normalizedUrl": row["normalized_url"],
            "lastOriginalUrl": row["last_original_url"],
            "hostname": row["hostname"],
            "title": row["title"],
            "visitCount": row["visit_count"],
            "firstVisitedAt": row["first_visited_at"],
            "lastVisitedAt": row["last_visited_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "storageSource": row["storage_source"],
        }

    @staticmethod
    def _visit(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "normalizedUrl": row["normalized_url"],
            "originalUrl": row["original_url"],
            "visitedAt": row["visited_at"],
            "transitionType": row["transition_type"],
            "tabId": row["tab_id"],
            "incognito": bool(row["incognito"]),
            "storageSource": row["storage_source"],
        }

    def record_visit(self, payload: dict[str, Any]) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            with self.connection() as connection:
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    previous = connection.execute("SELECT * FROM pages WHERE normalized_url=?", (payload["normalizedUrl"],)).fetchone()
                    event_id = payload.get("eventId") or str(uuid.uuid4())
                    now = payload["visitedAt"]
                    if previous is None:
                        connection.execute(
                            """INSERT INTO pages(normalized_url,last_original_url,hostname,title,visit_count,first_visited_at,last_visited_at,created_at,updated_at,storage_source)
                               VALUES(?,?,?,?,1,?,?,?,?,?)""",
                            (payload["normalizedUrl"], payload["originalUrl"], payload["hostname"], None if payload.get("suppressTitle") else payload["title"], now, now, now, now, "shared"),
                        )
                        first = now
                        count = 1
                    else:
                        connection.execute(
                            """UPDATE pages SET last_original_url=?, hostname=?, title=CASE WHEN ? THEN NULL ELSE COALESCE(?,title) END, visit_count=visit_count+1,
                               last_visited_at=?, updated_at=?, storage_source='shared' WHERE normalized_url=?""",
                            (payload["originalUrl"], payload["hostname"], 1 if payload.get("suppressTitle") else 0, payload["title"], now, now, payload["normalizedUrl"]),
                        )
                        first = previous["first_visited_at"]
                        count = previous["visit_count"] + 1
                    connection.execute(
                        """INSERT INTO visits(id,normalized_url,original_url,visited_at,transition_type,tab_id,incognito,storage_source)
                           VALUES(?,?,?,?,?,?,?,'shared')""",
                        (event_id, payload["normalizedUrl"], payload["originalUrl"], now, payload["transitionType"], payload["tabId"], 1 if payload["incognito"] else 0),
                    )
                    connection.commit()
                    return {
                        "wasSeen": previous is not None,
                        "previousVisitCount": previous["visit_count"] if previous else 0,
                        "visitCount": count,
                        "firstVisitedAt": first,
                        "previousLastVisitedAt": previous["last_visited_at"] if previous else None,
                        "lastVisitedAt": now,
                    }
                except Exception:
                    connection.rollback()
                    raise
        return with_lock_retry(operation)

    def get_page(self, normalized_url: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            return self._page(connection.execute("SELECT * FROM pages WHERE normalized_url=?", (normalized_url,)).fetchone())

    def search_pages(self, query: dict[str, Any]) -> dict[str, Any]:
        where: list[str] = []
        parameters: list[Any] = []
        search = query.get("search")
        if isinstance(search, str) and search.strip():
            needle = f"%{search.strip()}%"
            where.append("(normalized_url LIKE ? OR last_original_url LIKE ? OR hostname LIKE ? OR COALESCE(title,'') LIKE ?)")
            parameters.extend([needle] * 4)
        mapping = (("url", "normalized_url"), ("domain", "hostname"), ("storageSource", "storage_source"))
        for key, column in mapping:
            item = query.get(key)
            if isinstance(item, str) and item.strip():
                if key == "storageSource":
                    where.append(f"{column}=?")
                    parameters.append(item.strip())
                else:
                    where.append(f"{column} LIKE ?")
                    parameters.append(f"%{item.strip()}%")
        numeric = (("dateFrom", "last_visited_at", ">="), ("dateTo", "last_visited_at", "<="), ("minCount", "visit_count", ">="), ("maxCount", "visit_count", "<="))
        for key, column, operator in numeric:
            item = query.get(key)
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                where.append(f"{column}{operator}?")
                parameters.append(int(item))
        where_sql = f" WHERE {' AND '.join(where)}" if where else ""
        sort_map = {"url": "normalized_url", "domain": "hostname", "count": "visit_count", "firstVisit": "first_visited_at", "lastVisit": "last_visited_at"}
        sort_column = sort_map.get(query.get("sortField"), "last_visited_at")
        direction = "ASC" if query.get("sortDirection") == "asc" else "DESC"
        limit = max(1, min(500, int(query.get("limit", 25))))
        offset = max(0, int(query.get("offset", 0)))
        with self.connection() as connection:
            total = connection.execute(f"SELECT COUNT(*) FROM pages{where_sql}", parameters).fetchone()[0]
            rows = connection.execute(
                f"SELECT * FROM pages{where_sql} ORDER BY {sort_column} {direction}, normalized_url ASC LIMIT ? OFFSET ?",
                [*parameters, limit, offset],
            ).fetchall()
            return {"records": [self._page(row) for row in rows], "total": total}

    def get_visit_events(self, normalized_url: str, offset: int, limit: int) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM visits WHERE normalized_url=? ORDER BY visited_at DESC, id DESC LIMIT ? OFFSET ?",
                (normalized_url, max(1, min(100_000, limit)), max(0, offset)),
            ).fetchall()
            return [self._visit(row) for row in rows]

    def delete_page(self, normalized_url: str) -> None:
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM pages WHERE normalized_url=?", (normalized_url,))
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def delete_domain(self, hostname: str) -> int:
        def operation() -> int:
            with self.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    cursor = connection.execute("DELETE FROM pages WHERE hostname=?", (hostname.lower(),))
                    deleted = cursor.rowcount
                    connection.commit()
                    return deleted
                except Exception:
                    connection.rollback()
                    raise
        return with_lock_retry(operation)

    def clear_history(self) -> None:
        def operation() -> None:
            with self.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.execute("DELETE FROM visits")
                    connection.execute("DELETE FROM pages")
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
        with_lock_retry(operation)

    def get_statistics(self) -> dict[str, Any]:
        start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        start_ms = int(start.timestamp() * 1000)
        with self.connection() as connection:
            total_pages = connection.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
            total_visits = connection.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
            today = connection.execute("SELECT COUNT(*) FROM pages WHERE last_visited_at>=?", (start_ms,)).fetchone()[0]
            domain = connection.execute("SELECT hostname,SUM(visit_count) AS visits FROM pages GROUP BY hostname ORDER BY visits DESC,hostname ASC LIMIT 1").fetchone()
            page = connection.execute("SELECT * FROM pages ORDER BY visit_count DESC,last_visited_at DESC LIMIT 1").fetchone()
            per_day = connection.execute(
                "SELECT date(visited_at/1000,'unixepoch','localtime') AS day,COUNT(*) AS visits FROM visits GROUP BY day ORDER BY day ASC"
            ).fetchall()
            return {
                "totalTrackedPages": total_pages,
                "totalVisits": total_visits,
                "pagesVisitedToday": today,
                "mostVisitedDomain": {"hostname": domain["hostname"], "visits": domain["visits"]} if domain else None,
                "mostVisitedPage": self._page(page),
                "perDayVisitTotals": [{"date": row["day"], "visits": row["visits"]} for row in per_day],
            }

    def export_data(self) -> dict[str, Any]:
        with self.connection() as connection:
            pages = [self._page(row) for row in connection.execute("SELECT * FROM pages ORDER BY normalized_url").fetchall()]
            visits = [self._visit(row) for row in connection.execute("SELECT * FROM visits ORDER BY visited_at,id").fetchall()]
            return {"schemaVersion": 1, "exportedAt": int(time.time() * 1000), "storageMode": "shared", "pages": pages, "visits": visits}


    def export_data_chunk(self, page_offset: int, visit_offset: int, max_bytes: int) -> dict[str, Any]:
        import json
        max_bytes = max(128_000, min(700_000, int(max_bytes)))
        page_offset = max(0, int(page_offset))
        visit_offset = max(0, int(visit_offset))
        with self.connection() as connection:
            total_pages = connection.execute("SELECT COUNT(*) FROM pages").fetchone()[0]
            total_visits = connection.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
            pages: list[dict[str, Any]] = []
            visits: list[dict[str, Any]] = []
            current_bytes = 512
            page_rows = connection.execute("SELECT * FROM pages ORDER BY normalized_url LIMIT 100 OFFSET ?", (page_offset,)).fetchall()
            for row in page_rows:
                item = self._page(row)
                encoded = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                if (pages or visits) and current_bytes + encoded > max_bytes:
                    break
                pages.append(item)
                current_bytes += encoded
            next_page_offset = page_offset + len(pages)
            if next_page_offset >= total_pages:
                visit_rows = connection.execute("SELECT * FROM visits ORDER BY visited_at,id LIMIT 250 OFFSET ?", (visit_offset,)).fetchall()
                for row in visit_rows:
                    item = self._visit(row)
                    encoded = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                    if (pages or visits) and current_bytes + encoded > max_bytes:
                        break
                    visits.append(item)
                    current_bytes += encoded
            next_visit_offset = visit_offset + len(visits)
            return {
                "schemaVersion": 1,
                "exportedAt": int(time.time() * 1000),
                "storageMode": "shared",
                "pages": pages,
                "visits": visits,
                "nextPageOffset": next_page_offset,
                "nextVisitOffset": next_visit_offset,
                "totalPages": total_pages,
                "totalVisits": total_visits,
                "done": next_page_offset >= total_pages and next_visit_offset >= total_visits,
            }

    def _backup(self) -> str:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = self.path.with_name(f"{self.path.stem}.backup-{timestamp}{self.path.suffix}")
        with self.connection() as source:
            target = sqlite3.connect(backup_path)
            try:
                source.backup(target)
            finally:
                target.close()
        return str(backup_path)

    def import_data(self, bundle_value: Any, mode: str) -> dict[str, Any]:
        bundle = validate_import_bundle(bundle_value)
        if mode not in {"merge", "replace"}:
            raise HostError("INVALID_REQUEST", "Import mode must be merge or replace.")
        backup_path = self._backup() if mode == "replace" and self.path.exists() else None

        def operation() -> dict[str, Any]:
            with self.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                skipped_visits = 0
                try:
                    if mode == "replace":
                        connection.execute("DELETE FROM visits")
                        connection.execute("DELETE FROM pages")
                    for page in bundle["pages"]:
                        connection.execute(
                            """INSERT INTO pages(normalized_url,last_original_url,hostname,title,visit_count,first_visited_at,last_visited_at,created_at,updated_at,storage_source)
                               VALUES(?,?,?,?,?,?,?,?,?,'shared')
                               ON CONFLICT(normalized_url) DO UPDATE SET
                                 last_original_url=CASE WHEN excluded.last_visited_at>=pages.last_visited_at THEN excluded.last_original_url ELSE pages.last_original_url END,
                                 hostname=CASE WHEN excluded.last_visited_at>=pages.last_visited_at THEN excluded.hostname ELSE pages.hostname END,
                                 title=CASE WHEN excluded.last_visited_at>=pages.last_visited_at AND excluded.title IS NOT NULL THEN excluded.title ELSE pages.title END,
                                 visit_count=MAX(pages.visit_count,excluded.visit_count),
                                 first_visited_at=MIN(pages.first_visited_at,excluded.first_visited_at),
                                 last_visited_at=MAX(pages.last_visited_at,excluded.last_visited_at),
                                 created_at=MIN(pages.created_at,excluded.created_at),
                                 updated_at=MAX(pages.updated_at,excluded.updated_at),
                                 storage_source='shared'""",
                            (page["normalizedUrl"], page["lastOriginalUrl"], page["hostname"], page["title"], int(page["visitCount"]), int(page["firstVisitedAt"]), int(page["lastVisitedAt"]), int(page["createdAt"]), int(page["updatedAt"])),
                        )
                    affected = {page["normalizedUrl"] for page in bundle["pages"]}
                    for visit in bundle["visits"]:
                        affected.add(visit["normalizedUrl"])
                        cursor = connection.execute(
                            """INSERT OR IGNORE INTO visits(id,normalized_url,original_url,visited_at,transition_type,tab_id,incognito,storage_source)
                               VALUES(?,?,?,?,?,?,?,'shared')""",
                            (visit["id"], visit["normalizedUrl"], visit["originalUrl"], int(visit["visitedAt"]), visit["transitionType"], int(visit["tabId"]) if visit["tabId"] is not None else None, 1 if visit["incognito"] else 0),
                        )
                        if cursor.rowcount == 0:
                            skipped_visits += 1
                    for normalized_url in affected:
                        summary = connection.execute("SELECT COUNT(*) AS c,MIN(visited_at) AS first,MAX(visited_at) AS last FROM visits WHERE normalized_url=?", (normalized_url,)).fetchone()
                        if summary["c"]:
                            latest = connection.execute("SELECT original_url FROM visits WHERE normalized_url=? ORDER BY visited_at DESC,id DESC LIMIT 1", (normalized_url,)).fetchone()
                            connection.execute(
                                "UPDATE pages SET visit_count=?,first_visited_at=?,last_visited_at=?,last_original_url=?,updated_at=MAX(updated_at,?),storage_source='shared' WHERE normalized_url=?",
                                (summary["c"], summary["first"], summary["last"], latest["original_url"], summary["last"], normalized_url),
                            )
                    connection.commit()
                    return {
                        "pages": len(bundle["pages"]), "visits": len(bundle["visits"]),
                        "malformedPages": 0, "malformedVisits": 0,
                        "importedPages": len(bundle["pages"]),
                        "importedVisits": len(bundle["visits"]) - skipped_visits,
                        "skippedPages": 0, "skippedVisits": skipped_visits,
                        **({"backupPath": backup_path} if backup_path else {}),
                    }
                except Exception:
                    connection.rollback()
                    raise
        return with_lock_retry(operation)

    def remove_visits_older_than(self, cutoff: int) -> int:
        def operation() -> int:
            with self.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    affected_rows = connection.execute("SELECT DISTINCT normalized_url FROM visits WHERE visited_at<?", (cutoff,)).fetchall()
                    affected = [row[0] for row in affected_rows]
                    removed = connection.execute("DELETE FROM visits WHERE visited_at<?", (cutoff,)).rowcount
                    for normalized_url in affected:
                        summary = connection.execute("SELECT COUNT(*) AS c,MIN(visited_at) AS first,MAX(visited_at) AS last FROM visits WHERE normalized_url=?", (normalized_url,)).fetchone()
                        if summary["c"] == 0:
                            connection.execute("DELETE FROM pages WHERE normalized_url=?", (normalized_url,))
                        else:
                            latest = connection.execute("SELECT original_url FROM visits WHERE normalized_url=? ORDER BY visited_at DESC,id DESC LIMIT 1", (normalized_url,)).fetchone()
                            connection.execute("UPDATE pages SET visit_count=?,first_visited_at=?,last_visited_at=?,last_original_url=?,updated_at=? WHERE normalized_url=?", (summary["c"], summary["first"], summary["last"], latest["original_url"], summary["last"], normalized_url))
                    connection.commit()
                    return removed
                except Exception:
                    connection.rollback()
                    raise
        return with_lock_retry(operation)

    def open_directory(self) -> None:
        self._ensure_directory()
        try:
            if sys.platform == "win32":
                os.startfile(self.directory)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(self.directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
            else:
                subprocess.Popen(["xdg-open", str(self.directory)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        except OSError as exc:
            raise HostError("OPEN_DIRECTORY_FAILED", f"The storage directory could not be opened: {exc}") from exc
