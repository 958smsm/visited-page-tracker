[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$InstallDirectory = "$env:LOCALAPPDATA\VisitedPageTrackerNativeHost",

    [string]$DatabaseDirectory = "$env:LOCALAPPDATA\Google\Chrome\User Data\Global\VisitedPageTracker"
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.visited_page_tracker.host'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $SourceDirectory 'windows-host-common.ps1')
Assert-ChromeExtensionId -ExtensionId $ExtensionId
$ExpectedOrigin = Get-ChromeExtensionOrigin -ExtensionId $ExtensionId
$InstallDirectory = Resolve-AbsoluteHostPath -Path $InstallDirectory
$DatabaseDirectory = Resolve-AbsoluteHostPath -Path $DatabaseDirectory

$PythonExecutable = Find-PythonExecutable
Write-Host "Using Python: $PythonExecutable"
New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $DatabaseDirectory | Out-Null
$DatabaseDirectory = (Resolve-Path $DatabaseDirectory).Path
Write-Host "Shared database directory: $DatabaseDirectory"

$PythonFiles = @('visited_page_tracker_host.py', 'database.py', 'protocol.py', 'schemas.py', 'test_host.py')
foreach ($File in $PythonFiles) {
    Copy-Item -Force -LiteralPath (Join-Path $SourceDirectory $File) -Destination (Join-Path $InstallDirectory $File)
}

$HostScript = Join-Path $InstallDirectory 'visited_page_tracker_host.py'
$LauncherSource = Get-Content -Raw (Join-Path $SourceDirectory 'host_launcher.cs')
$LauncherSource = $LauncherSource.Replace('__PYTHON_EXECUTABLE__', $PythonExecutable.Replace('"', '""'))
$LauncherSource = $LauncherSource.Replace('__HOST_SCRIPT__', $HostScript.Replace('"', '""'))
$LauncherToken = [Guid]::NewGuid().ToString('N')
$LauncherSource = $LauncherSource.Replace('__CLASS_NAME__', ('VisitedPageTrackerLauncher_' + $LauncherToken))
$GeneratedSource = Join-Path $InstallDirectory 'host_launcher.generated.cs'
$LauncherPath = Join-Path $InstallDirectory ("visited_page_tracker_host-$LauncherToken.exe")
[System.IO.File]::WriteAllText($GeneratedSource, $LauncherSource, (New-Object System.Text.UTF8Encoding($false)))
Add-Type -TypeDefinition $LauncherSource -Language CSharp -OutputAssembly $LauncherPath -OutputType ConsoleApplication

$ManifestPath = Join-Path $InstallDirectory "$HostName.json"
$Manifest = [ordered]@{
    name = $HostName
    description = 'Visited Page Tracker shared SQLite native messaging host'
    path = $LauncherPath
    type = 'stdio'
    allowed_origins = @($ExpectedOrigin)
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 4
$TemporaryManifestPath = "$ManifestPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    [System.IO.File]::WriteAllText($TemporaryManifestPath, $ManifestJson, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $TemporaryManifestPath -Destination $ManifestPath -Force
} finally {
    if (Test-Path -LiteralPath $TemporaryManifestPath) { Remove-Item -LiteralPath $TemporaryManifestPath -Force }
}

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Force -Path $RegistryPath | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

$RegisteredManifestPath = (Get-Item -LiteralPath $RegistryPath).GetValue('')
if ($RegisteredManifestPath -ne $ManifestPath) {
    throw "Native host registry verification failed. Expected '$ManifestPath' but found '$RegisteredManifestPath'."
}
if (-not [IO.Path]::IsPathRooted($RegisteredManifestPath) -or -not (Test-Path -LiteralPath $RegisteredManifestPath -PathType Leaf)) {
    throw "The registered native host manifest path is not an existing absolute file: '$RegisteredManifestPath'."
}
$WrittenManifest = Get-Content -Raw -LiteralPath $RegisteredManifestPath | ConvertFrom-Json
$ActualOrigins = @($WrittenManifest.allowed_origins)
if ($WrittenManifest.name -ne $HostName) {
    throw "Native host manifest name mismatch. Expected '$HostName' but found '$($WrittenManifest.name)'."
}
if ($ActualOrigins.Count -ne 1 -or $ActualOrigins[0] -ne $ExpectedOrigin) {
    throw "Native host allowed_origins mismatch. Expected only '$ExpectedOrigin' but found '$($ActualOrigins -join ', ')'."
}
if ($WrittenManifest.path -ne $LauncherPath -or -not (Test-Path -LiteralPath $WrittenManifest.path -PathType Leaf)) {
    throw "Native host launcher verification failed for '$($WrittenManifest.path)'."
}

$InstallationMetadata = [ordered]@{
    python = $PythonExecutable
    database_directory = $DatabaseDirectory
    extension_id = $ExtensionId
    expected_origin = $ExpectedOrigin
}
$MetadataJson = $InstallationMetadata | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText((Join-Path $InstallDirectory 'installation.json'), $MetadataJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Registered native host for extension $ExtensionId"
Write-Host "Allowed origin: $ExpectedOrigin"
& $PythonExecutable (Join-Path $InstallDirectory 'test_host.py') --host $LauncherPath --database-directory $DatabaseDirectory
if ($LASTEXITCODE -ne 0) { throw 'The native-host connectivity test failed.' }
$OldLaunchers = Get-ChildItem -LiteralPath $InstallDirectory -Filter 'visited_page_tracker_host*.exe' -File |
    Where-Object { $_.FullName -ne $LauncherPath }
foreach ($OldLauncher in $OldLaunchers) {
    try { Remove-Item -LiteralPath $OldLauncher.FullName -Force -ErrorAction Stop }
    catch { Write-Verbose "Older launcher remains in use and will be cleaned by a later install: $($OldLauncher.FullName)" }
}
Write-Host "Installation complete. Manifest: $ManifestPath"
Write-Host "Shared database: $(Join-Path $DatabaseDirectory 'visited_page_tracker.sqlite3')"
