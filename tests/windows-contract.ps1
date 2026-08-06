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

foreach ($functionName in @(
  "Convert-IdentityToSid",
  "Get-PropertyValue",
  "Get-MachineRoot",
  "Assert-ManagedMachineRoot",
  "Set-MachineItemAcl",
  "Set-MachineRootAcl",
  "ConvertTo-SafeDiagnosticLine",
  "Initialize-OperationDiagnosticLog",
  "Write-OperationDiagnosticLine",
  "ConvertFrom-PlatformProgressEvent",
  "Update-PlatformProgressState",
  "Format-StageElapsed",
  "Invoke-ProvisionStage"
)) {
  $functionAst = $platformAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq $functionName
  }, $true)
  if ($null -eq $functionAst) { throw "$functionName function is missing" }
  . ([ScriptBlock]::Create($functionAst.Extent.Text))
}

$safeDiagnostic = ConvertTo-SafeDiagnosticLine `
  'Authorization: Bearer secret.jwt.value password=hunter2 device_code=abc access_token=def refresh-token=ghi' 240
foreach ($secret in @("secret.jwt.value", "hunter2", "abc", "def", "ghi")) {
  if ($safeDiagnostic.Contains($secret)) { throw "Diagnostic sanitizer leaked a secret" }
}
$boundedDiagnostic = ConvertTo-SafeDiagnosticLine (("x" * 300) + [char]27 + "[31m") 240
if ($boundedDiagnostic.Length -ne 240 -or $boundedDiagnostic.Contains([char]27)) {
  throw "Diagnostic sanitizer did not bound or strip control sequences"
}

$validProgress = ConvertFrom-PlatformProgressEvent `
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"started","timestamp":"2026-08-06T02:08:27Z"}'
if ($null -eq $validProgress -or $validProgress.stage -ne "installing-rainbond") {
  throw "Valid platform progress was rejected"
}
foreach ($invalidProgress in @(
  '{"schema":"rainskills.platform-progress.v1","stage":"unknown","status":"started","timestamp":"2026-08-06T02:08:27Z"}',
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"unknown","timestamp":"2026-08-06T02:08:27Z"}',
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"started","timestamp":"not-a-time"}',
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"started","timestamp":"2026-08-06T02:08:27Z","detail":"untrusted"}',
  '{not-json}'
)) {
  if ($null -ne (ConvertFrom-PlatformProgressEvent $invalidProgress)) {
    throw "Invalid platform progress was accepted: $invalidProgress"
  }
}

$progressStates = @{}
if (-not (Update-PlatformProgressState $validProgress $progressStates)) {
  throw "Progress state machine rejected the initial start"
}
if (Update-PlatformProgressState $validProgress $progressStates) {
  throw "Progress state machine accepted a duplicate start"
}
$heartbeatProgress = ConvertFrom-PlatformProgressEvent `
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"heartbeat","timestamp":"2026-08-06T02:08:37Z"}'
if (-not (Update-PlatformProgressState $heartbeatProgress $progressStates)) {
  throw "Progress state machine rejected a valid heartbeat"
}
$completedProgress = ConvertFrom-PlatformProgressEvent `
  '{"schema":"rainskills.platform-progress.v1","stage":"installing-rainbond","status":"completed","timestamp":"2026-08-06T02:08:47Z"}'
if (-not (Update-PlatformProgressState $completedProgress $progressStates)) {
  throw "Progress state machine rejected valid completion"
}
if (Update-PlatformProgressState $heartbeatProgress $progressStates) {
  throw "Progress state machine accepted a heartbeat after completion"
}
$outOfOrderStates = @{}
if (Update-PlatformProgressState $heartbeatProgress $outOfOrderStates) {
  throw "Progress state machine accepted a heartbeat before start"
}

$script:stageOutput = @()
function Write-Host {
  param([object]$Object)
  $script:stageOutput += [string]$Object
}
try {
  $stageFailure = $null
  try {
    [void](Invoke-ProvisionStage 1 7 "Failing stage" { throw "expected stage failure" })
  } catch {
    $stageFailure = $_.Exception.Message
  }
  if ($stageFailure -ne "expected stage failure") { throw "Stage failure was not propagated" }
  if (@($script:stageOutput | Where-Object { $_ -match '^\[OK\]' }).Count -ne 0) {
    throw "Failed stage printed a premature completion"
  }
} finally {
  Remove-Item Function:\Write-Host -ErrorAction SilentlyContinue
}

$originalProgramData = $env:ProgramData
$diagnosticProgramData = Join-Path ([IO.Path]::GetTempPath()) ("rainskills-diagnostic-contract-" + [Guid]::NewGuid().ToString("N"))
$diagnosticInstallationId = "33333333-3333-4333-8333-333333333333"
$diagnosticOperationId = "44444444-4444-4444-8444-444444444444"
$diagnosticRequest = [pscustomobject]@{
  operation_id = $diagnosticOperationId
  installation_id = $diagnosticInstallationId
  user_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
try {
  $env:ProgramData = $diagnosticProgramData
  $diagnosticMachineRoot = Join-Path (Join-Path $diagnosticProgramData "RainSkills") $diagnosticInstallationId
  [void](New-Item -ItemType Directory -Path $diagnosticMachineRoot -Force)
  $diagnosticLog = Initialize-OperationDiagnosticLog $diagnosticRequest
  $expectedDiagnosticLog = Join-Path (Join-Path $diagnosticMachineRoot "logs") ($diagnosticOperationId + ".log")
  if (-not $diagnosticLog.Equals($expectedDiagnosticLog, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Diagnostic log path is not operation-bound: $diagnosticLog"
  }
  Write-OperationDiagnosticLine $diagnosticLog (ConvertTo-SafeDiagnosticLine "password=secret" 240)
  $diagnosticContent = Get-Content -LiteralPath $diagnosticLog -Raw -Encoding UTF8
  if ($diagnosticContent.Contains("secret") -or -not $diagnosticContent.Contains("[REDACTED]")) {
    throw "Diagnostic log persisted an unredacted secret"
  }
  $diagnosticAcl = Get-Acl -LiteralPath $diagnosticLog
  $diagnosticWriterSids = @($diagnosticAcl.Access | ForEach-Object {
    try { Convert-IdentityToSid $_.IdentityReference } catch { [string]$_.IdentityReference }
  })
  if ($diagnosticWriterSids -notcontains $diagnosticRequest.user_sid) {
    throw "Diagnostic log ACL does not preserve the original user identity"
  }

  $unsafeRequest = [pscustomobject]@{
    operation_id = "..\outside"
    installation_id = $diagnosticInstallationId
    user_sid = $diagnosticRequest.user_sid
  }
  $unsafeOperationRejected = $false
  try { [void](Initialize-OperationDiagnosticLog $unsafeRequest) } catch { $unsafeOperationRejected = $true }
  if (-not $unsafeOperationRejected) { throw "Diagnostic log accepted an unsafe operation id" }

  Remove-Item -LiteralPath $diagnosticProgramData -Recurse -Force
  [void](New-Item -ItemType Directory -Path (Join-Path $diagnosticProgramData "RainSkills") -Force)
  $machineTarget = Join-Path $diagnosticProgramData "machine-target"
  [void](New-Item -ItemType Directory -Path $machineTarget)
  [void](New-Item -ItemType Junction -Path $diagnosticMachineRoot -Target $machineTarget)
  $machineJunctionRejected = $false
  try { [void](Initialize-OperationDiagnosticLog $diagnosticRequest) } catch { $machineJunctionRejected = $true }
  if (-not $machineJunctionRejected) { throw "Diagnostic log accepted a machine-root junction" }

  Remove-Item -LiteralPath $diagnosticProgramData -Recurse -Force
  [void](New-Item -ItemType Directory -Path $diagnosticMachineRoot -Force)
  $logTarget = Join-Path $diagnosticProgramData "log-target"
  [void](New-Item -ItemType Directory -Path $logTarget)
  [void](New-Item -ItemType Junction -Path (Join-Path $diagnosticMachineRoot "logs") -Target $logTarget)
  $logJunctionRejected = $false
  try { [void](Initialize-OperationDiagnosticLog $diagnosticRequest) } catch { $logJunctionRejected = $true }
  if (-not $logJunctionRejected) { throw "Diagnostic log accepted a log-directory junction" }

  Remove-Item -LiteralPath (Join-Path $diagnosticMachineRoot "logs") -Force
  $regularLogRoot = Join-Path $diagnosticMachineRoot "logs"
  [void](New-Item -ItemType Directory -Path $regularLogRoot)
  $fileTarget = Join-Path $diagnosticProgramData "file-target"
  [void](New-Item -ItemType Directory -Path $fileTarget)
  [void](New-Item -ItemType Junction -Path (Join-Path $regularLogRoot ($diagnosticOperationId + ".log")) -Target $fileTarget)
  $fileJunctionRejected = $false
  try { [void](Initialize-OperationDiagnosticLog $diagnosticRequest) } catch { $fileJunctionRejected = $true }
  if (-not $fileJunctionRejected) { throw "Diagnostic log accepted an existing log-file junction" }
} finally {
  $env:ProgramData = $originalProgramData
  if (Test-Path -LiteralPath $diagnosticProgramData) {
    Remove-Item -LiteralPath $diagnosticProgramData -Recurse -Force -ErrorAction SilentlyContinue
  }
}

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

  $readinessRoot = Join-Path ([IO.Path]::GetTempPath()) ("rainskills-keepalive-contract-" + [Guid]::NewGuid().ToString("N"))
  [void](New-Item -ItemType Directory -Path $readinessRoot)
  try {
    $readinessPath = Join-Path $readinessRoot "result.json"
    [IO.File]::WriteAllText($readinessPath, (@{
      schema = "rainskills.windows-result.v1"
      action = "WslKeepalive"
      operation_id = "11111111-1111-4111-8111-111111111111"
      installation_id = "22222222-2222-4222-8222-222222222222"
      nonce = ("a" * 64)
      status = "error"
      facts = @{ failureMessage = "simulated wrapped WSL failure" }
    } | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $readinessRequest = [pscustomobject]@{
      operation_id = "11111111-1111-4111-8111-111111111111"
      installation_id = "22222222-2222-4222-8222-222222222222"
    }
    $wrappedFailure = $null
    try {
      [void](Wait-ScheduledTaskRunning "RainSkills-Keepalive-contract" 0 $readinessPath $readinessRequest ("a" * 64))
    } catch {
      $wrappedFailure = $_.Exception.Message
    }
    if ($wrappedFailure -notmatch "simulated wrapped WSL failure") {
      throw "Managed keepalive wrapper failure was hidden by task state: $wrappedFailure"
    }
  } finally {
    Remove-Item -LiteralPath $readinessRoot -Recurse -Force -ErrorAction SilentlyContinue
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
function Initialize-OperationDiagnosticLog {
  return (Join-Path $script:nativeProbeRoot "operation.log")
}
function Write-OperationDiagnosticLine {
  param([string]$LogPath, [string]$Line)
  [IO.File]::AppendAllText($LogPath, $Line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

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
  $expectedBootstrapFailure = "Managed WSL bootstrap action failed: VerifyRainbond: concrete WSL failure. Diagnostic log: " +
    (Join-Path $nativeProbeRoot "operation.log")
  if ($bootstrapFailure -ne $expectedBootstrapFailure) {
    throw "Invoke-DistroBootstrap did not preserve the native exit failure: $bootstrapFailure"
  }
  if ($ErrorActionPreference -ne $originalPreference) {
    throw "Invoke-DistroBootstrap did not restore ErrorActionPreference after a native failure"
  }

  [IO.File]::WriteAllLines($script:nativeProbePath, @(
    "@echo off",
    "echo password=supersecret access_token=token-value 1>&2",
    "exit /b 24"
  ), [Text.Encoding]::ASCII)
  $redactedBootstrapFailure = $null
  try {
    Invoke-DistroBootstrap ([pscustomobject]@{
      installation_id = "22222222-2222-4222-8222-222222222222"
    }) "VerifyRainbond"
  } catch {
    $redactedBootstrapFailure = $_.Exception.Message
  }
  if ($redactedBootstrapFailure -notmatch "\[REDACTED\]" -or
      $redactedBootstrapFailure -match "supersecret|token-value") {
    throw "Invoke-DistroBootstrap leaked a secret in its failure summary: $redactedBootstrapFailure"
  }
  $nativeDiagnosticContent = Get-Content -LiteralPath (Join-Path $nativeProbeRoot "operation.log") -Raw -Encoding UTF8
  if ($nativeDiagnosticContent -match "supersecret|token-value") {
    throw "Invoke-DistroBootstrap leaked a secret in its diagnostic log"
  }

  function Initialize-OperationDiagnosticLog { throw "safe diagnostic log is unavailable" }
  $noLogFailure = $null
  try {
    Invoke-DistroBootstrap ([pscustomobject]@{
      installation_id = "22222222-2222-4222-8222-222222222222"
    }) "VerifyRainbond"
  } catch {
    $noLogFailure = $_.Exception.Message
  }
  if ($noLogFailure -ne "safe diagnostic log is unavailable" -or $noLogFailure -match "Diagnostic log:") {
    throw "Failure before log creation reported an unsafe diagnostic path: $noLogFailure"
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
