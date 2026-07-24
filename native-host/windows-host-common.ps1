Set-StrictMode -Version Latest

function Assert-ChromeExtensionId {
    param([Parameter(Mandatory = $true)][string]$ExtensionId)
    if ($ExtensionId -notmatch '^[a-p]{32}$') {
        throw "Invalid Chrome extension ID '$ExtensionId'. Copy the 32-character ID (letters a-p only) from chrome://extensions for the exact loaded extension."
    }
}

function Get-ChromeExtensionOrigin {
    param([Parameter(Mandatory = $true)][string]$ExtensionId)
    Assert-ChromeExtensionId -ExtensionId $ExtensionId
    return "chrome-extension://$ExtensionId/"
}

function Resolve-AbsoluteHostPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $Expanded = [Environment]::ExpandEnvironmentVariables($Path)
    if ([string]::IsNullOrWhiteSpace($Expanded)) {
        throw 'A non-empty path is required.'
    }
    return [IO.Path]::GetFullPath($Expanded)
}

function Find-PythonExecutable {
    $Python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Python) {
        & $Python.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
        if ($LASTEXITCODE -eq 0) { return $Python.Source }
    }
    $Py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Py) {
        $Resolved = & $Py.Source -3 -c "import sys; raise SystemExit(1) if sys.version_info < (3, 9) else print(sys.executable)"
        if ($LASTEXITCODE -eq 0 -and $Resolved) { return $Resolved.Trim() }
    }
    throw 'Python 3.9 or newer was not found. Install Python for the current user and rerun this command.'
}
