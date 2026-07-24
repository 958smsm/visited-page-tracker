#!/usr/bin/env sh
set -eu

usage() {
  echo "Usage: $0 --extension-id <32-character-id> [--browser chrome|chromium] [--install-dir <absolute-path>]" >&2
  exit 2
}

EXTENSION_ID=""
BROWSER="chrome"
INSTALL_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --extension-id) [ "$#" -ge 2 ] || usage; EXTENSION_ID="$2"; shift 2 ;;
    --browser) [ "$#" -ge 2 ] || usage; BROWSER="$2"; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || usage; INSTALL_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done

printf '%s' "$EXTENSION_ID" | grep -Eq '^[a-p]{32}$' || { echo "Invalid Chrome extension ID." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required." >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,9)' || { echo "Python 3.9 or newer is required." >&2; exit 1; }

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UNAME=$(uname -s)
if [ -z "$INSTALL_DIR" ]; then
  if [ "$UNAME" = "Darwin" ]; then
    INSTALL_DIR="$HOME/Library/Application Support/VisitedPageTrackerNativeHost"
  else
    INSTALL_DIR="$HOME/.local/share/visited-page-tracker-native-host"
  fi
fi
case "$INSTALL_DIR" in /*) ;; *) echo "--install-dir must be absolute." >&2; exit 2 ;; esac

mkdir -p "$INSTALL_DIR"
for file in visited_page_tracker_host.py database.py protocol.py schemas.py test_host.py; do
  cp "$SCRIPT_DIR/$file" "$INSTALL_DIR/$file"
done
chmod 700 "$INSTALL_DIR/visited_page_tracker_host.py" "$INSTALL_DIR/test_host.py"
HOST_PATH="$INSTALL_DIR/visited_page_tracker_host.py"

if [ "$UNAME" = "Darwin" ]; then
  case "$BROWSER" in
    chrome) MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    chromium) MANIFEST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
    *) echo "Unsupported browser: $BROWSER" >&2; exit 2 ;;
  esac
else
  case "$BROWSER" in
    chrome) MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
    chromium) MANIFEST_DIR="$HOME/.config/chromium/NativeMessagingHosts" ;;
    *) echo "Unsupported browser: $BROWSER" >&2; exit 2 ;;
  esac
fi
mkdir -p "$MANIFEST_DIR"
MANIFEST_PATH="$MANIFEST_DIR/com.visited_page_tracker.host.json"
python3 - "$MANIFEST_PATH" "$HOST_PATH" "$EXTENSION_ID" <<'PY'
import json, pathlib, sys
path, host, extension_id = sys.argv[1:]
manifest = {
    "name": "com.visited_page_tracker.host",
    "description": "Visited Page Tracker shared SQLite native messaging host",
    "path": host,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"],
}
pathlib.Path(path).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$MANIFEST_PATH"
python3 "$INSTALL_DIR/test_host.py" --host "$HOST_PATH"
echo "Installed native host manifest: $MANIFEST_PATH"
