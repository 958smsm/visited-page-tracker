#!/usr/bin/env python3
"""Connectivity test for an installed native host executable or script."""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True, help="Path to native host executable/script")
    parser.add_argument("--database-directory", help="Optional shared database directory to create and test")
    args = parser.parse_args()
    host = Path(args.host).expanduser().resolve()
    if not host.exists():
        print(f"Host does not exist: {host}", file=sys.stderr)
        return 2
    requests = [{"id": "connectivity-test", "action": "ping", "payload": {}}]
    if args.database_directory:
        requests.append({
            "id": "database-test",
            "action": "configureDatabase",
            "database": {
                "directory": args.database_directory,
                "filename": "visited_page_tracker.sqlite3",
            },
            "payload": {},
        })

    for request in requests:
        payload = json.dumps(request).encode("utf-8")
        process = subprocess.Popen([str(host)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            stdout, stderr = process.communicate(struct.pack("<I", len(payload)) + payload, timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            _, stderr = process.communicate()
            print(f"Native host timed out for {request['action']}.", file=sys.stderr)
            if stderr:
                print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
            return 5
        if len(stdout) < 4:
            print(stderr.decode("utf-8", errors="replace"), file=sys.stderr)
            return 3
        (length,) = struct.unpack("<I", stdout[:4])
        if len(stdout) != 4 + length:
            print("Native host stdout contained an invalid frame or non-protocol diagnostics.", file=sys.stderr)
            return 3
        response = json.loads(stdout[4:4 + length].decode("utf-8"))
        if response.get("id") != request["id"] or not response.get("ok"):
            print(json.dumps(response, indent=2), file=sys.stderr)
            return 4
        print(json.dumps(response, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
