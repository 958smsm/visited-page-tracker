"""Validation and request/response contracts for the native host."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

HOST_ACTIONS = {
    "ping",
    "configureDatabase",
    "getDatabaseStatus",
    "recordVisit",
    "getPage",
    "searchPages",
    "getVisitEvents",
    "deletePage",
    "deleteDomain",
    "clearHistory",
    "getStatistics",
    "exportData",
    "importData",
    "migrateData",
    "openStorageDirectory",
}
DATABASE_ACTIONS = HOST_ACTIONS - {"ping"}
DEFAULT_FILENAME = "visited_page_tracker.sqlite3"
WINDOWS_RESERVED_FILENAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


def expand_database_directory(directory_raw: str) -> str:
    """Expand environment variables without executing the configured path."""
    value = directory_raw.strip()
    environment = {key.upper(): item for key, item in os.environ.items()}
    if os.name == "nt":
        environment.setdefault("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        environment.setdefault("USERNAME", Path.home().name)
    value = re.sub(
        r"%([^%]+)%",
        lambda match: environment.get(match.group(1).upper(), match.group(0)),
        value,
    )
    return os.path.expandvars(os.path.expanduser(value))


class HostError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def require_string(value: Any, field: str, *, allow_empty: bool = False, max_length: int = 100_000) -> str:
    if not isinstance(value, str):
        raise HostError("INVALID_REQUEST", f"{field} must be a string.")
    if not allow_empty and not value.strip():
        raise HostError("INVALID_REQUEST", f"{field} must not be empty.")
    if len(value) > max_length:
        raise HostError("INVALID_REQUEST", f"{field} is too long.")
    return value


def require_number(value: Any, field: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HostError("INVALID_REQUEST", f"{field} must be a number.")
    number = float(value)
    if minimum is not None and number < minimum:
        raise HostError("INVALID_REQUEST", f"{field} must be at least {minimum}.")
    return number


def validate_database_config(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise HostError("INVALID_DATABASE_CONFIG", "A database configuration object is required.")
    directory_raw = require_string(value.get("directory"), "database.directory", max_length=4096)
    filename = require_string(value.get("filename", DEFAULT_FILENAME), "database.filename", max_length=255).strip()
    filename_stem = filename.split(".", 1)[0].upper()
    if filename.endswith((" ", ".")) or any(character in filename for character in '<>:"|?*') \
            or filename_stem in WINDOWS_RESERVED_FILENAMES:
        raise HostError("INVALID_DATABASE_FILENAME", "Database filename is not safe on Windows.")
    if filename in {".", ".."} or filename != os.path.basename(filename) or any(separator in filename for separator in ("/", "\\", "\x00")):
        raise HostError("INVALID_DATABASE_FILENAME", "Database filename must be a simple filename without path separators.")
    expanded = expand_database_directory(directory_raw)
    if re.search(r"%[^%]+%", expanded):
        raise HostError("INVALID_DATABASE_DIRECTORY", "The shared database directory contains an unknown environment variable.")
    path = Path(expanded)
    if not path.is_absolute():
        raise HostError("INVALID_DATABASE_DIRECTORY", "The shared database directory must be an absolute path.")
    try:
        normalized = path.resolve(strict=False)
    except OSError as exc:
        raise HostError("INVALID_DATABASE_DIRECTORY", f"The database directory could not be normalized: {exc}") from exc
    return {"directory": str(normalized), "filename": filename, "path": str(normalized / filename)}


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HostError("INVALID_REQUEST", "Request must be a JSON object.")
    request_id = require_string(value.get("id"), "id", max_length=200)
    action = require_string(value.get("action"), "action", max_length=100)
    if action not in HOST_ACTIONS:
        raise HostError("UNKNOWN_ACTION", f"Unknown native-host action: {action}")
    payload = value.get("payload", {})
    if not isinstance(payload, dict):
        raise HostError("INVALID_REQUEST", "payload must be a JSON object.")
    request = {"id": request_id, "action": action, "payload": payload}
    if action in DATABASE_ACTIONS:
        request["database"] = validate_database_config(value.get("database"))
    return request


def validate_record_visit(payload: dict[str, Any]) -> dict[str, Any]:
    normalized_url = require_string(payload.get("normalizedUrl"), "normalizedUrl")
    original_url = require_string(payload.get("originalUrl"), "originalUrl")
    hostname = require_string(payload.get("hostname"), "hostname", max_length=253).lower()
    for field, url in (("normalizedUrl", normalized_url), ("originalUrl", original_url)):
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https", "file"}:
            raise HostError("INVALID_URL", f"{field} must use http, https, or file.")
    title = payload.get("title")
    if title is not None:
        title = require_string(title, "title", allow_empty=True, max_length=20_000)
    transition = payload.get("transitionType")
    if transition is not None:
        transition = require_string(transition, "transitionType", allow_empty=True, max_length=200)
    tab_id = payload.get("tabId")
    if tab_id is not None:
        tab_id = int(require_number(tab_id, "tabId"))
    incognito = payload.get("incognito")
    if not isinstance(incognito, bool):
        raise HostError("INVALID_REQUEST", "incognito must be a boolean.")
    event_id = payload.get("eventId")
    if event_id is not None:
        event_id = require_string(event_id, "eventId", max_length=200)
    storage_source = payload.get("storageSource", "shared")
    storage_source = require_string(storage_source, "storageSource", max_length=200)
    suppress_title = payload.get("suppressTitle", False)
    if not isinstance(suppress_title, bool):
        raise HostError("INVALID_REQUEST", "suppressTitle must be a boolean.")
    return {
        "normalizedUrl": normalized_url,
        "originalUrl": original_url,
        "hostname": hostname,
        "title": title,
        "suppressTitle": suppress_title,
        "visitedAt": int(require_number(payload.get("visitedAt"), "visitedAt", minimum=0)),
        "transitionType": transition,
        "tabId": tab_id,
        "incognito": incognito,
        "eventId": event_id,
        "storageSource": storage_source,
    }


def _valid_page(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    required_strings = ("normalizedUrl", "lastOriginalUrl", "hostname", "storageSource")
    required_numbers = ("visitCount", "firstVisitedAt", "lastVisitedAt", "createdAt", "updatedAt")
    return all(isinstance(item.get(key), str) for key in required_strings) \
        and all(isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool) for key in required_numbers) \
        and (isinstance(item.get("title"), str) or item.get("title") is None)


def _valid_visit(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    return isinstance(item.get("id"), str) \
        and isinstance(item.get("normalizedUrl"), str) \
        and isinstance(item.get("originalUrl"), str) \
        and isinstance(item.get("visitedAt"), (int, float)) and not isinstance(item.get("visitedAt"), bool) \
        and (isinstance(item.get("transitionType"), str) or item.get("transitionType") is None) \
        and (isinstance(item.get("tabId"), (int, float)) or item.get("tabId") is None) \
        and isinstance(item.get("incognito"), bool) \
        and isinstance(item.get("storageSource"), str)


def validate_import_bundle(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise HostError("INVALID_IMPORT", "Import schemaVersion must be 1.")
    pages = value.get("pages")
    visits = value.get("visits")
    if not isinstance(pages, list) or not isinstance(visits, list):
        raise HostError("INVALID_IMPORT", "Import pages and visits must be arrays.")
    malformed_pages = sum(1 for item in pages if not _valid_page(item))
    malformed_visits = sum(1 for item in visits if not _valid_visit(item))
    if malformed_pages or malformed_visits:
        raise HostError("INVALID_IMPORT", f"Import contains {malformed_pages} malformed pages and {malformed_visits} malformed visits.")
    storage_mode = value.get("storageMode")
    if storage_mode not in {"perProfile", "shared"}:
        raise HostError("INVALID_IMPORT", "Import storageMode must be perProfile or shared.")
    return value


def success_response(request_id: str, result: Any) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def error_response(request_id: str, code: str, message: str) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}
