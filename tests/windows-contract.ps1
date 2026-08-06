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

$platformTokens = $null
$platformErrors = $null
$platformAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $platformScript,
  [ref]$platformTokens,
  [ref]$platformErrors
)
$originProbeAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Test-OriginReachability"
}, $true)
if ($null -eq $originProbeAst) { throw "Test-OriginReachability function is missing" }
. ([ScriptBlock]::Create($originProbeAst.Extent.Text))

function Invoke-WebRequest { throw [InvalidOperationException]::new("simulated transport failure") }
try {
  $originResult = Test-OriginReachability "https://unreachable.example" @("https://unreachable.example")
  if ($originResult.reachable -or $originResult.origin -ne "https://unreachable.example") {
    throw "Transport failure was not returned as an unreachable origin"
  }
} finally {
  Remove-Item Function:\Invoke-WebRequest
}

$keepaliveWaitAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Wait-ScheduledTaskRunning"
}, $true)
if ($null -eq $keepaliveWaitAst) { throw "Wait-ScheduledTaskRunning function is missing" }
. ([ScriptBlock]::Create($keepaliveWaitAst.Extent.Text))

$keepaliveSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable
if ($keepaliveSettings.DisallowStartIfOnBatteries -or
    $keepaliveSettings.StopIfGoingOnBatteries -or
    -not $keepaliveSettings.StartWhenAvailable) {
  throw "Managed keepalive task power settings are incompatible with Windows PowerShell 5.1"
}

$script:keepalivePollCount = 0
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  $script:keepalivePollCount += 1
  return [pscustomobject]@{ State = if ($script:keepalivePollCount -ge 2) { "Running" } else { "Ready" } }
}
function Get-ScheduledTaskInfo {
  [CmdletBinding()]
  param([string]$TaskName)
  return [pscustomobject]@{ LastTaskResult = 267009 }
}
function Start-Sleep {
  [CmdletBinding()]
  param([int]$Milliseconds)
}
try {
  $runningTask = Wait-ScheduledTaskRunning "RainSkills-Keepalive-contract" 1
  if ($runningTask.State -ne "Running" -or $script:keepalivePollCount -ne 2) {
    throw "Managed keepalive task running-state polling contract failed"
  }

  $script:keepalivePollCount = 0
  function Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    return [pscustomobject]@{ State = "Ready" }
  }
  $keepaliveFailure = $null
  try {
    [void](Wait-ScheduledTaskRunning "RainSkills-Keepalive-contract" 0)
  } catch {
    $keepaliveFailure = $_.Exception.Message
  }
  if ($keepaliveFailure -notmatch "state=Ready" -or $keepaliveFailure -notmatch "LastTaskResult=267009") {
    throw "Managed keepalive task failure did not include concrete task diagnostics: $keepaliveFailure"
  }
} finally {
  Remove-Item Function:\Get-ScheduledTask -ErrorAction SilentlyContinue
  Remove-Item Function:\Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  Remove-Item Function:\Start-Sleep -ErrorAction SilentlyContinue
}

$leaseWriterAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Write-MachineLease"
}, $true)
if ($null -eq $leaseWriterAst) { throw "Write-MachineLease function is missing" }
. ([ScriptBlock]::Create($leaseWriterAst.Extent.Text))
$machineItemAclAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Set-MachineItemAcl"
}, $true)
if ($null -eq $machineItemAclAst) { throw "Set-MachineItemAcl function is missing" }
. ([ScriptBlock]::Create($machineItemAclAst.Extent.Text))
$machineRootAclAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Set-MachineRootAcl"
}, $true)
if ($null -eq $machineRootAclAst) { throw "Set-MachineRootAcl function is missing" }
. ([ScriptBlock]::Create($machineRootAclAst.Extent.Text))

$distroBootstrapAst = $platformAst.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Invoke-DistroBootstrap"
}, $true)
if ($null -eq $distroBootstrapAst) { throw "Invoke-DistroBootstrap function is missing" }
. ([ScriptBlock]::Create($distroBootstrapAst.Extent.Text))

$nativeProbeRoot = Join-Path ([IO.Path]::GetTempPath()) ("rainskills-native-stderr-" + [Guid]::NewGuid().ToString("N"))
$script:nativeProbePath = Join-Path $nativeProbeRoot "native-stderr.cmd"
$script:nativeProbeRoot = $nativeProbeRoot
function Get-TrustedWslPath { return $script:nativeProbePath }
function Get-MachineRoot { return $script:nativeProbeRoot }
function Assert-MachineManifest {
  return [pscustomobject]@{ bootstrap_sha256 = ("a" * 64) }
}
function Assert-FileDigest { return $true }
function Convert-WindowsPathForDistro { return "/tmp/wsl-bootstrap.sh" }

try {
  [void](New-Item -ItemType Directory -Path $nativeProbeRoot)
  [IO.File]::WriteAllLines($script:nativeProbePath, @(
    "@echo off",
    "echo curl: (56) Recv failure: Connection reset by peer 1>&2",
    "exit /b 0"
  ), [Text.Encoding]::ASCII)
  $originalPreference = $ErrorActionPreference
  Invoke-DistroBootstrap ([pscustomobject]@{
    installation_id = "22222222-2222-4222-8222-222222222222"
  }) "VerifyRainbond"
  if ($ErrorActionPreference -ne $originalPreference) {
    throw "Invoke-DistroBootstrap did not restore ErrorActionPreference"
  }

  [IO.File]::WriteAllLines($script:nativeProbePath, @(
    "@echo off",
    "echo concrete WSL failure 1>&2",
    "exit /b 23"
  ), [Text.Encoding]::ASCII)
  $bootstrapFailure = $null
  try {
    Invoke-DistroBootstrap ([pscustomobject]@{
      installation_id = "22222222-2222-4222-8222-222222222222"
    }) "VerifyRainbond"
  } catch {
    $bootstrapFailure = $_.Exception.Message
  }
  if ($bootstrapFailure -ne "Managed WSL bootstrap action failed: VerifyRainbond: concrete WSL failure") {
    throw "Invoke-DistroBootstrap did not preserve the native exit failure: $bootstrapFailure"
  }
  if ($ErrorActionPreference -ne $originalPreference) {
    throw "Invoke-DistroBootstrap did not restore ErrorActionPreference after a native failure"
  }
} finally {
  Remove-Item -LiteralPath $nativeProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
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

$leaseRoot = Join-Path ([IO.Path]::GetTempPath()) ("rainskills-lease-contract-" + [Guid]::NewGuid().ToString("N"))
try {
  [void](New-Item -ItemType Directory -Path $leaseRoot)
  $leasePath = Join-Path $leaseRoot "lease.json"
  [IO.File]::WriteAllText($leasePath, "stale", [Text.UTF8Encoding]::new($false))
  $leaseAcl = [Security.AccessControl.FileSecurity]::new()
  $leaseAcl.SetOwner([Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))
  $leaseAcl.SetAccessRuleProtection($true, $false)
  [IO.File]::SetAccessControl($leasePath, $leaseAcl)
  $inPlaceWriteDenied = $false
  try {
    [IO.File]::WriteAllText($leasePath, "must fail", [Text.UTF8Encoding]::new($false))
  } catch [UnauthorizedAccessException] {
    $inPlaceWriteDenied = $true
  }
  if (-not $inPlaceWriteDenied) { throw "Lease contract did not reproduce an access denied overwrite" }
  Set-MachineRootAcl $leaseRoot $currentSid
  $leaseRequest = [pscustomobject]@{
    operation_id = "11111111-1111-4111-8111-111111111111"
    installation_id = "22222222-2222-4222-8222-222222222222"
    user_sid = $currentSid
    nonce = ("a" * 64)
  }
  Write-MachineLease $leaseRoot $leaseRequest
  $lease = Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($lease.schema -ne "rainskills.windows-machine-lease.v1" -or
      $lease.operation_id -ne $leaseRequest.operation_id -or
      $lease.installation_id -ne $leaseRequest.installation_id -or
      $lease.nonce -ne $leaseRequest.nonce -or
      (Get-Item -LiteralPath $leasePath).IsReadOnly) {
    throw "Machine lease replacement contract failed"
  }
} finally {
  if (Test-Path -LiteralPath $leaseRoot) {
    Get-ChildItem -LiteralPath $leaseRoot -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.IsReadOnly = $false }
    Remove-Item -LiteralPath $leaseRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Windows PowerShell contracts passed."
