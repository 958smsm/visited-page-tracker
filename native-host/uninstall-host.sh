#!/usr/bin/env sh
set -eu
BROWSER="chrome"
INSTALL_DIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --browser) BROWSER="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "Usage: $0 [--browser chrome|chromium] [--install-dir <path>]" >&2; exit 2 ;;
  esac
done
UNAME=$(uname -s)
if [ -z "$INSTALL_DIR" ]; then
  if [ "$UNAME" = "Darwin" ]; then INSTALL_DIR="$HOME/Library/Application Support/VisitedPageTrackerNativeHost"; else INSTALL_DIR="$HOME/.local/share/visited-page-tracker-native-host"; fi
fi
if [ "$UNAME" = "Darwin" ]; then
  if [ "$BROWSER" = "chromium" ]; then MANIFEST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; else MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"; fi
else
  if [ "$BROWSER" = "chromium" ]; then MANIFEST_DIR="$HOME/.config/chromium/NativeMessagingHosts"; else MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"; fi
fi
rm -f "$MANIFEST_DIR/com.visited_page_tracker.host.json"
rm -rf "$INSTALL_DIR"
echo "Native host removed. Custom SQLite databases were not deleted."
