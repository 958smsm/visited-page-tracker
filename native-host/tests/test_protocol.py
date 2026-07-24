from __future__ import annotations

import io
import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from protocol import ProtocolError, read_message, write_message


class ProtocolTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        stream = io.BytesIO()
        write_message({"id": "1", "ok": True}, stream)
        stream.seek(0)
        self.assertEqual(read_message(stream), {"id": "1", "ok": True})

    def test_rejects_incomplete_payload(self) -> None:
        stream = io.BytesIO(struct.pack("<I", 10) + b"{}")
        with self.assertRaises(ProtocolError):
            read_message(stream)

    def test_reader_accepts_partial_pipe_reads(self) -> None:
        payload = json.dumps({"id": "partial", "action": "ping", "payload": {}}).encode("utf-8")
        raw = struct.pack("<I", len(payload)) + payload

        class PartialReader(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                return super().read(1 if size < 0 else min(size, 1))

        self.assertEqual(read_message(PartialReader(raw))["id"], "partial")


if __name__ == "__main__":
    unittest.main()
