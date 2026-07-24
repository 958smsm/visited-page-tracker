[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstallDirectory = "$env:LOCALAPPDATA\VisitedPageTrackerNativeHost"
)

$ErrorActionPreference = 'Stop'
$RegistryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.visited_page_tracker.host'
if (Test-Path $RegistryPath) {
    if ($PSCmdlet.ShouldProcess($RegistryPath, 'Remove native messaging registry registration')) {
        Remove-Item -Recurse -Force $RegistryPath
    }
}
if (Test-Path $InstallDirectory) {
    if ($PSCmdlet.ShouldProcess($InstallDirectory, 'Remove native host program files')) {
        Remove-Item -Recurse -Force $InstallDirectory
    }
}
Write-Host 'Visited Page Tracker native host uninstalled. Custom SQLite databases were not deleted.'
