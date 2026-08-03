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

$global:rainskillsContractOpenedUrl = $null
function Start-Process {
  param([Parameter(Mandatory = $true)][string]$FilePath)
  $global:rainskillsContractOpenedUrl = $FilePath
}

$expectedUrl = "https://run.rainbond.com/#/cli-auth?state=a&callback=http%3A%2F%2F127.0.0.1%3A43210%2Fcli-callback"
& $browserScript -Url $expectedUrl
if ($global:rainskillsContractOpenedUrl -ne $expectedUrl) {
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

$stateRoot = Join-Path ([IO.Path]::GetTempPath()) ("rainskills-acl-contract-" + [Guid]::NewGuid().ToString("N"))
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
  [void](New-Item -ItemType Directory -Path $stateRoot)
  & $platformScript -Action ProtectState -TargetPath $stateRoot -ExpectedKind directory `
    -UserSid $currentSid -UserHome ([IO.Path]::GetTempPath())
  $aclFacts = & $platformScript -Action InspectState -TargetPath $stateRoot -ExpectedKind directory `
    -UserSid $currentSid -UserHome ([IO.Path]::GetTempPath()) | ConvertFrom-Json
  if ($aclFacts.ownerSid -ne $currentSid -or $aclFacts.reparsePoint) {
    throw "Windows state ACL contract returned invalid ownership facts"
  }
} finally {
  Remove-Item -LiteralPath $stateRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Windows PowerShell contracts passed."
