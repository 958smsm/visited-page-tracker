from __future__ import annotations

import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schemas import HostError, validate_database_config, validate_import_bundle, validate_request


class SchemaTests(unittest.TestCase):
    def test_database_path_must_be_absolute_and_filename_safe(self) -> None:
        with self.assertRaises(HostError):
            validate_database_config({"directory": "relative", "filename": "db.sqlite3"})
        with tempfile.TemporaryDirectory() as directory:
            result = validate_database_config({"directory": directory, "filename": "db.sqlite3"})
            self.assertTrue(result["path"].endswith("db.sqlite3"))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(HostError):
                validate_database_config({"directory": directory, "filename": "../db.sqlite3"})

    def test_localappdata_expands_to_an_absolute_normalized_path(self) -> None:
        with tempfile.TemporaryDirectory() as local_app_data:
            with patch.dict("os.environ", {"LOCALAPPDATA": local_app_data}):
                result = validate_database_config({
                    "directory": r"%LOCALAPPDATA%\Google\Chrome\User Data\Global\VisitedPageTracker",
                    "filename": "visited_page_tracker.sqlite3",
                })
            self.assertTrue(Path(result["directory"]).is_absolute())
            self.assertNotIn("%LOCALAPPDATA%", result["directory"])
            self.assertTrue(result["path"].endswith("visited_page_tracker.sqlite3"))

    def test_windows_unsafe_database_filenames_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for filename in ("..", "../db.sqlite3", "sub/db.sqlite3", r"sub\db.sqlite3", "NUL.sqlite3", "bad?.sqlite3", "trailing. "):
                with self.subTest(filename=filename), self.assertRaises(HostError) as raised:
                    validate_database_config({"directory": directory, "filename": filename})
                self.assertEqual(raised.exception.code, "INVALID_DATABASE_FILENAME")

    def test_unknown_actions_are_rejected(self) -> None:
        with self.assertRaises(HostError):
            validate_request({"id": "1", "action": "unknown", "payload": {}})

    def test_unknown_percent_environment_variable_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            unresolved = str(Path(directory) / "%VISITED_PAGE_TRACKER_UNKNOWN%" / "shared")
            with self.assertRaises(HostError) as raised:
                validate_database_config({"directory": unresolved, "filename": "shared.sqlite3"})
            self.assertEqual(raised.exception.code, "INVALID_DATABASE_DIRECTORY")

    def test_invalid_import_is_rejected_before_application(self) -> None:
        with self.assertRaises(HostError):
            validate_import_bundle({"schemaVersion": 1, "storageMode": "shared", "pages": [{}], "visits": []})


if __name__ == "__main__":
    unittest.main()
