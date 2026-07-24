from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from schemas import HostError
from visited_page_tracker_host import dispatch


class HostDispatchTests(unittest.TestCase):
    def test_ping_returns_one_matching_success_response(self) -> None:
        response = dispatch({"id": "ping-1", "action": "ping", "payload": {}})
        self.assertEqual(response["id"], "ping-1")
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["host"], "com.visited_page_tracker.host")

    def test_configure_database_returns_resolved_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            response = dispatch({
                "id": "configure-1",
                "action": "configureDatabase",
                "database": {"directory": directory, "filename": "shared.sqlite3"},
                "payload": {},
            })
        self.assertTrue(response["ok"])
        self.assertEqual(response["id"], "configure-1")
        self.assertTrue(response["result"]["path"].endswith("shared.sqlite3"))

    def test_permission_error_is_structured_and_next_request_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch(
            "visited_page_tracker_host.SharedVisitDatabase.configure",
            side_effect=HostError("PERMISSION_DENIED", "Directory is not writable."),
        ):
            response = dispatch({
                "id": "permission-1",
                "action": "configureDatabase",
                "database": {"directory": directory, "filename": "shared.sqlite3"},
                "payload": {},
            })
        self.assertEqual(response, {
            "id": "permission-1",
            "ok": False,
            "error": {"code": "PERMISSION_DENIED", "message": "Directory is not writable."},
        })
        self.assertTrue(dispatch({"id": "ping-2", "action": "ping", "payload": {}})["ok"])


if __name__ == "__main__":
    unittest.main()
