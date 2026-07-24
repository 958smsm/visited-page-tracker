from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "nt", "Windows PowerShell installer tests")
class WindowsInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(__file__).resolve().parents[1]
        cls.powershell = str(Path(os.environ["SystemRoot"]) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")

    def test_installer_rejects_malformed_extension_id_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            install_directory = Path(temporary) / "install"
            database_directory = Path(temporary) / "database"
            result = subprocess.run([
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", str(self.root / "install-host.ps1"),
                "-ExtensionId", "invalid-id",
                "-InstallDirectory", str(install_directory),
                "-DatabaseDirectory", str(database_directory),
            ], capture_output=True, text=True, timeout=20, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(install_directory.exists())

    def test_exact_allowed_origin_helper(self) -> None:
        extension_id = "a" * 32
        common = str(self.root / "windows-host-common.ps1").replace("'", "''")
        command = f". '{common}'; Get-ChromeExtensionOrigin -ExtensionId '{extension_id}'"
        result = subprocess.run([
            self.powershell,
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-Command", command,
        ], capture_output=True, text=True, timeout=20, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), f"chrome-extension://{extension_id}/")


if __name__ == "__main__":
    unittest.main()
