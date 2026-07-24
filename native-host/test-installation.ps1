[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$DatabaseDirectory = "$env:LOCALAPPDATA\Google\Chrome\User Data\Global\VisitedPageTracker"
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.visited_page_tracker.host'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $SourceDirectory 'windows-host-common.ps1')
Assert-ChromeExtensionId -ExtensionId $ExtensionId
$ExpectedOrigin = Get-ChromeExtensionOrigin -ExtensionId $ExtensionId
$Failures = [Collections.Generic.List[string]]::new()

function Write-Check {
    param([string]$Name, [bool]$Passed, [string]$Details)
    $Label = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1}: {2}" -f $Label, $Name, $Details)
    if (-not $Passed) { $script:Failures.Add("$Name - $Details") }
}

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$RegistryExists = Test-Path -LiteralPath $RegistryPath
Write-Check 'Host registry key exists' $RegistryExists $RegistryPath

$ManifestPath = $null
if ($RegistryExists) {
    try { $ManifestPath = (Get-Item -LiteralPath $RegistryPath).GetValue('') }
    catch { $Failures.Add("Registered manifest path - $($_.Exception.Message)") }
}
$ManifestPathValid = $ManifestPath -is [string] -and -not [string]::IsNullOrWhiteSpace($ManifestPath)
Write-Check 'Registered manifest path' $ManifestPathValid $(if ($ManifestPathValid) { $ManifestPath } else { 'Unavailable' })
$ManifestPathAbsolute = $ManifestPathValid -and [IO.Path]::IsPathRooted($ManifestPath)
Write-Check 'Registered manifest path is absolute' $ManifestPathAbsolute $(if ($ManifestPathAbsolute) { $ManifestPath } else { 'The registry value must contain an absolute manifest path.' })

$ManifestExists = $ManifestPathAbsolute -and (Test-Path -LiteralPath $ManifestPath -PathType Leaf)
Write-Check 'Manifest file exists' $ManifestExists $(if ($ManifestExists) { $ManifestPath } else { 'Manifest file was not found.' })

$Manifest = $null
if ($ManifestExists) {
    try { $Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json }
    catch { $Failures.Add("Manifest JSON - $($_.Exception.Message)") }
}

$HostPath = if ($Manifest -and $Manifest.PSObject.Properties['path']) { [string]$Manifest.path } else { '' }
$HostExists = -not [string]::IsNullOrWhiteSpace($HostPath) -and (Test-Path -LiteralPath $HostPath -PathType Leaf)
Write-Check 'Host executable or launcher exists' $HostExists $(if ($HostExists) { $HostPath } else { 'Unavailable' })

$ActualOrigins = @()
if ($Manifest -and $Manifest.PSObject.Properties['allowed_origins']) { $ActualOrigins = @($Manifest.allowed_origins) }
Write-Host "Expected extension origin: $ExpectedOrigin"
Write-Host "Actual allowed_origins: $($ActualOrigins -join ', ')"
$OriginMatches = $ActualOrigins.Count -eq 1 -and $ActualOrigins[0] -eq $ExpectedOrigin
Write-Check 'Expected origin matches' $OriginMatches $(if ($OriginMatches) { $ExpectedOrigin } else { 'Reinstall the host with the ID from the exact loaded extension.' })

$InstallDirectory = if ($ManifestPathValid) { Split-Path -Parent $ManifestPath } else { '' }
$MetadataPath = if ($InstallDirectory) { Join-Path $InstallDirectory 'installation.json' } else { '' }
$Metadata = $null
if ($MetadataPath -and (Test-Path -LiteralPath $MetadataPath -PathType Leaf)) {
    try { $Metadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json }
    catch { $Failures.Add("Installation metadata - $($_.Exception.Message)") }
}

$PythonExecutable = if ($Metadata -and $Metadata.PSObject.Properties['python'] -and $Metadata.python) { [string]$Metadata.python } else { '' }
if (-not $PythonExecutable) {
    try { $PythonExecutable = Find-PythonExecutable }
    catch { $Failures.Add("Python executable - $($_.Exception.Message)") }
}
$PythonPathExists = $PythonExecutable -and (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)
Write-Check 'Python executable path' $PythonPathExists $(if ($PythonExecutable) { $PythonExecutable } else { 'Unavailable' })

$PythonAvailable = $false
$PythonVersion = 'Unavailable'
if ($PythonExecutable) {
    try {
        $PythonVersion = & $PythonExecutable -c "import sys; print(sys.version.split()[0]); raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
        $PythonAvailable = $LASTEXITCODE -eq 0
    } catch { $PythonVersion = $_.Exception.Message }
}
Write-Check 'Python availability' $PythonAvailable $PythonVersion

$ResolvedDatabaseDirectory = Resolve-AbsoluteHostPath -Path $DatabaseDirectory
Write-Host "Default shared directory: $ResolvedDatabaseDirectory"
$DirectoryWritable = $false
$DirectoryDetails = $ResolvedDatabaseDirectory
try {
    New-Item -ItemType Directory -Force -Path $ResolvedDatabaseDirectory | Out-Null
    $ProbePath = Join-Path $ResolvedDatabaseDirectory ('.write-test-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($ProbePath, 'ok')
    Remove-Item -LiteralPath $ProbePath -Force
    $DirectoryWritable = $true
} catch { $DirectoryDetails = $_.Exception.Message }
Write-Check 'Shared directory can be created and written' $DirectoryWritable $DirectoryDetails

$DatabasePath = Join-Path $ResolvedDatabaseDirectory 'visited_page_tracker.sqlite3'
$SqliteAvailable = $false
$SqliteDetails = $DatabasePath
if ($PythonAvailable -and $DirectoryWritable) {
    try {
        & $PythonExecutable -c "import sqlite3,sys; connection=sqlite3.connect(sys.argv[1], timeout=2); connection.execute('PRAGMA foreign_keys=ON'); connection.execute('SELECT 1').fetchone(); connection.close()" $DatabasePath
        $SqliteAvailable = $LASTEXITCODE -eq 0
        if (-not $SqliteAvailable) { $SqliteDetails = "Python SQLite probe exited with code $LASTEXITCODE." }
    } catch { $SqliteDetails = $_.Exception.Message }
}
Write-Check 'SQLite database can be opened' $SqliteAvailable $SqliteDetails

$DirectHostTestPassed = $false
$DirectHostTestDetails = 'Host or Python is unavailable.'
$DirectTestScript = if ($InstallDirectory) { Join-Path $InstallDirectory 'test_host.py' } else { '' }
if ($HostExists -and $PythonAvailable -and (Test-Path -LiteralPath $DirectTestScript -PathType Leaf)) {
    try {
        $DirectOutput = & $PythonExecutable $DirectTestScript --host $HostPath --database-directory $ResolvedDatabaseDirectory 2>&1
        $DirectHostTestPassed = $LASTEXITCODE -eq 0
        $DirectHostTestDetails = ($DirectOutput | Out-String).Trim()
    } catch { $DirectHostTestDetails = $_.Exception.Message }
}
Write-Check 'Direct Native Messaging host ping/configure result' $DirectHostTestPassed $DirectHostTestDetails

if ($Failures.Count -gt 0) {
    Write-Error ("Installation diagnostic failed with {0} required check(s)." -f $Failures.Count) -ErrorAction Continue
    foreach ($Failure in $Failures) { Write-Host " - $Failure" }
    exit 1
}

Write-Host 'All native messaging installation checks passed.'
exit 0
