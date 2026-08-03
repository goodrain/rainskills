$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$platformScript = Join-Path $repositoryRoot "rainbond-platform-installer\scripts\windows-platform.ps1"
$browserScript = Join-Path $repositoryRoot "rainbond-platform-installer\scripts\windows-browser.ps1"

foreach ($scriptPath in @($platformScript, $browserScript)) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) {
    $errors | Format-List | Out-String | Write-Error
  }
}

$script:openedUrl = $null
function Start-Process {
  param([Parameter(Mandatory = $true)][string]$FilePath)
  $script:openedUrl = $FilePath
}

$expectedUrl = "https://run.rainbond.com/#/cli-auth?state=a&callback=http%3A%2F%2F127.0.0.1%3A43210%2Fcli-callback"
& $browserScript -Url $expectedUrl
if ($script:openedUrl -ne $expectedUrl) {
  throw "Browser helper changed or parsed the authorization URL"
}

foreach ($unsafeUrl in @(
  "file:///C:/Windows/System32/calc.exe",
  "https://user:password@example.com/",
  "https://example.com/`nnext"
)) {
  $failedClosed = $false
  try {
    & $browserScript -Url $unsafeUrl
  } catch {
    $failedClosed = $true
  }
  if (-not $failedClosed) { throw "Browser helper accepted an unsafe URL" }
}

Write-Host "Windows PowerShell contracts passed."
