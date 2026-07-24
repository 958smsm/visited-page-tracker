# Auto-Hiding SEEN Tag — 1.0.5

- The red webpage tag now uses the wording **SEEN 3 times**.
- The tag automatically hides five seconds after it appears.
- A new page or SPA navigation resets the timer, so the latest tag receives a full five-second display period.
- Manual dismissal and background hide commands cancel any pending timer.

# Visit Count in SEEN Tag — 1.0.4

- The red webpage tag now displays the total recorded visit count in the compact format **SEEN 3×**.
- The tag tooltip and accessible label now announce the total number of visits.
- Detailed tooltips also show how many visits occurred before the current navigation.

# Exact Page Tracking Exclusions — 1.0.3

- Added **Disable tracking for current page** to the extension popup.
- Exact page exclusions use the current normalized URL, so they follow the configured query-string, fragment, HTTP/HTTPS, and `www` normalization rules.
- Exact exclusions are stored separately from wildcard patterns, avoiding accidental wildcard behavior from `?` characters in query strings.
- Added an **Excluded exact pages** list under Settings → Privacy for reviewing, editing, or removing page exclusions.
- Disabling a page or domain now clears the current tab badge and hides the SEEN tag immediately.
- Existing visit history is preserved; use **Forget current page** separately when the stored history should also be deleted.

# Shared Storage Connection Reliability — 1.0.2

- Replaced the fragile `C:\Users\%username%\...` default with `%LOCALAPPDATA%\Google\Chrome\User Data\Global\VisitedPageTracker`.
- Existing settings using the old `%username%` placeholder are upgraded automatically.
- The Windows installer creates the shared directory and `visited_page_tracker.sqlite3` for the current user.
- The installer now tests both Native Messaging connectivity and SQLite database access.
- Shared-mode save errors now include the native host's actual error message.
- Every native-port request now has a 10-second timeout and settles on matching response, host error, disconnect, Chrome `lastError`, invalid response, mismatched ID, or timeout.
- The Options connection button is always restored in `finally`; Shared mode is not retained or saved after a failed test, and there is no IndexedDB fallback.
- The installer now verifies the absolute HKCU manifest registration and exact `chrome-extension://<id>/` origin after writing it.
- `test-installation.ps1` diagnoses registry, manifest, launcher, origin, Python, directory, SQLite, and direct framed host connectivity.
- Windows path expansion, filename validation, SQLite busy bounds, protocol framing, tests, and build output were hardened.

After rebuilding/reloading `extension/dist`, rerun `install-host.ps1` with the exact ID shown for that loaded extension and then run `test-installation.ps1` with the same ID.
