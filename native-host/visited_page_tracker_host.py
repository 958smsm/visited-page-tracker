#!/usr/bin/env python3
"""Native messaging host for Visited Page Tracker."""
from __future__ import annotations
import os
import sqlite3
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any
# --- TEMPORARY DEBUG LOGGING ---
_DEBUG_LOG = Path(os.environ.get("LOCALAPPDATA", "")) / "VisitedPageTrackerNativeHost" / "debug.log"
_DEBUG_LOG.parent.mkdir(parents=True, exist_ok=True)
def _dbg(msg: str) -> None:
    try:
        with open(_DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat()}] {msg}\n")
    except Exception:
        pass
_dbg(f"HOST STARTED pid={os.getpid()} python={sys.executable} argv={sys.argv}")
# --- END TEMPORARY DEBUG LOGGING ---
from database import SharedVisitDatabase
from protocol import ProtocolError, read_message, write_message
from schemas import (
    HostError,
    error_response,
    require_number,
    require_string,
    success_response,
    validate_import_bundle,
    validate_record_visit,
    validate_request,
)
def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
IMPORT_SESSIONS: dict[str, dict[str, Any]] = {}
def handle_import(database: SharedVisitDatabase, payload: dict[str, Any]) -> dict[str, Any]:
    phase = payload.get("phase")
    if phase is None:
        return database.import_data(validate_import_bundle(payload.get("bundle")), require_string(payload.get("mode"), "mode"))
    session_id = require_string(payload.get("sessionId"), "sessionId", max_length=200)
    if phase == "begin":
        mode = require_string(payload.get("mode"), "mode")
        if mode not in {"merge", "replace"}:
            raise HostError("INVALID_REQUEST", "Import mode must be merge or replace.")
        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            raise HostError("INVALID_REQUEST", "Import metadata must be an object.")
        if metadata.get("schemaVersion") != 1 or metadata.get("storageMode") not in {"perProfile", "shared"}:
            raise HostError("INVALID_IMPORT", "Invalid staged import metadata.")
        IMPORT_SESSIONS[session_id] = {
            "mode": mode,
            "metadata": metadata,
            "totalPages": int(require_number(payload.get("totalPages"), "totalPages", minimum=0)),
            "totalVisits": int(require_number(payload.get("totalVisits"), "totalVisits", minimum=0)),
            "pages": [],
            "visits": [],
            "databasePath": str(database.path),
        }
        return {"sessionId": session_id, "accepted": True}
    session = IMPORT_SESSIONS.get(session_id)
    if not session:
        raise HostError("IMPORT_SESSION_NOT_FOUND", "The staged import session does not exist.")
    if session["databasePath"] != str(database.path):
        IMPORT_SESSIONS.pop(session_id, None)
        raise HostError("INVALID_REQUEST", "The database changed during a staged import.")
    if phase == "abort":
        IMPORT_SESSIONS.pop(session_id, None)
        return {"aborted": True}
    if phase == "chunk":
        pages = payload.get("pages", [])
        visits = payload.get("visits", [])
        partial = {
            "schemaVersion": 1,
            "exportedAt": session["metadata"].get("exportedAt", 0),
            "storageMode": session["metadata"]["storageMode"],
            "pages": pages,
            "visits": visits,
        }
        try:
            validate_import_bundle(partial)
        except Exception:
            IMPORT_SESSIONS.pop(session_id, None)
            raise
        session["pages"].extend(pages)
        session["visits"].extend(visits)
        if len(session["pages"]) > session["totalPages"] or len(session["visits"]) > session["totalVisits"]:
            IMPORT_SESSIONS.pop(session_id, None)
            raise HostError("INVALID_IMPORT", "The staged import contains more records than declared.")
        return {"receivedPages": len(session["pages"]), "receivedVisits": len(session["visits"])}
    if phase == "commit":
        try:
            if len(session["pages"]) != session["totalPages"] or len(session["visits"]) != session["totalVisits"]:
                raise HostError("INVALID_IMPORT", "The staged import record counts do not match the declared totals.")
            bundle = {
                "schemaVersion": 1,
                "exportedAt": session["metadata"].get("exportedAt", 0),
                "storageMode": session["metadata"]["storageMode"],
                "pages": session["pages"],
                "visits": session["visits"],
            }
            return database.import_data(validate_import_bundle(bundle), session["mode"])
        finally:
            IMPORT_SESSIONS.pop(session_id, None)
    raise HostError("INVALID_REQUEST", f"Unknown import phase: {phase}")
def dispatch(raw: dict[str, Any]) -> dict[str, Any]:
    request_id = raw.get("id") if isinstance(raw.get("id"), str) else "unknown"
    try:
        request = validate_request(raw)
        request_id = request["id"]
        action = request["action"]
        payload = request["payload"]
        if action == "ping":
            return success_response(request_id, {"host": "com.visited_page_tracker.host", "version": "1.0.0", "python": sys.version.split()[0]})
        database = SharedVisitDatabase(request["database"])
        if action == "configureDatabase":
            result = database.configure()
        elif action == "getDatabaseStatus":
            result = database.get_status()
        elif action == "recordVisit":
            result = database.record_visit(validate_record_visit(payload))
        elif action == "getPage":
            result = database.get_page(require_string(payload.get("normalizedUrl"), "normalizedUrl"))
        elif action == "searchPages":
            query = payload.get("query", {})
            if not isinstance(query, dict):
                raise HostError("INVALID_REQUEST", "query must be an object.")
            result = database.search_pages(query)
        elif action == "getVisitEvents":
            result = database.get_visit_events(
                require_string(payload.get("normalizedUrl"), "normalizedUrl"),
                int(require_number(payload.get("offset", 0), "offset", minimum=0)),
                int(require_number(payload.get("limit", 200), "limit", minimum=1)),
            )
        elif action == "deletePage":
            database.delete_page(require_string(payload.get("normalizedUrl"), "normalizedUrl"))
            result = {"deleted": True}
        elif action == "deleteDomain":
            result = {"deleted": database.delete_domain(require_string(payload.get("hostname"), "hostname", max_length=253))}
        elif action == "clearHistory":
            database.clear_history()
            result = {"cleared": True}
        elif action == "getStatistics":
            result = database.get_statistics()
        elif action == "exportData":
            if payload.get("chunked") is True:
                result = database.export_data_chunk(
                    int(require_number(payload.get("pageOffset", 0), "pageOffset", minimum=0)),
                    int(require_number(payload.get("visitOffset", 0), "visitOffset", minimum=0)),
                    int(require_number(payload.get("maxBytes", 450000), "maxBytes", minimum=1)),
                )
            else:
                result = database.export_data()
        elif action == "importData":
            result = handle_import(database, payload)
        elif action == "migrateData":
            if payload.get("operation") == "retention":
                result = {"removed": database.remove_visits_older_than(int(require_number(payload.get("cutoff"), "cutoff", minimum=0)))}
            elif "bundle" in payload:
                result = database.import_data(validate_import_bundle(payload.get("bundle")), require_string(payload.get("mode", "merge"), "mode"))
            else:
                raise HostError("INVALID_REQUEST", "migrateData requires a supported operation or an import bundle.")
        elif action == "openStorageDirectory":
            database.open_directory()
            result = {"opened": True, "path": str(database.directory)}
        else:
            raise HostError("UNKNOWN_ACTION", f"Unknown action: {action}")
        return success_response(request_id, result)
    except HostError as exc:
        return error_response(request_id, exc.code, exc.message)
    except sqlite3.DatabaseError as exc:
        text = str(exc).lower()
        code = "DATABASE_CORRUPT" if "malformed" in text or "not a database" in text else "DATABASE_ERROR"
        log(f"SQLite error: {exc}")
        return error_response(request_id, code, str(exc))
    except Exception as exc:  # defensive boundary: never write diagnostics to stdout
        log("Unhandled native host error:\n" + traceback.format_exc())
        return error_response(request_id, "INTERNAL_ERROR", str(exc))
def main() -> int:
    _dbg("main() entered, waiting for first message...")
    while True:
        try:
            message = read_message()
            if message is None:
                _dbg("read_message() returned None (stdin closed)")
                return 0
            _dbg(f"Received message action={message.get('action')} id={message.get('id')}")
            response = dispatch(message)
            _dbg(f"Dispatched, sending response ok={response.get('ok')}")
            write_message(response)
            _dbg("Response sent successfully")
        except ProtocolError as exc:
            _dbg(f"Protocol error: {exc}")
            log(f"Protocol error: {exc}")
            try:
                write_message(error_response("unknown", "PROTOCOL_ERROR", str(exc)))
            except Exception:
                pass
            return 1
        except BrokenPipeError:
            _dbg("BrokenPipeError, exiting")
            return 0
if __name__ == "__main__":
    raise SystemExit(main())
