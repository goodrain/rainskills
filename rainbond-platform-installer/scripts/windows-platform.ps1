[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "InspectState", "ProtectState", "PrepareWsl", "ProvisionRainbond", "InstallMachineBundle", "EnableWsl", "UpdateWsl", "VerifyWsl", "RegisterResume", "RegisterFinalize", "RequestReboot", "Finalize", "ImportDistro", "PrepareRuntime", "ConfigureNetwork", "VerifyNetwork", "PrepareDocker", "InstallRainbond", "VerifyDeployment")]
  [string]$Action,

  [string]$RequestPath = "",

  [string]$ResultPath = "",

  [string]$TargetPath = "",

  [ValidateSet("file", "directory")]
  [string]$ExpectedKind = "file",

  [string]$UserSid = "",

  [string]$UserHome = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-PathInsideRoot([string]$Candidate, [string]$Root) {
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd("\")
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -and
      -not $candidateFull.StartsWith($rootFull + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "TargetPath must stay inside UserHome"
  }
  return $candidateFull
}

function Convert-IdentityToSid($IdentityReference) {
  if ([string]$IdentityReference -match "^S-\d-") { return [string]$IdentityReference }
  return $IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
}

function Get-StateAclFacts([string]$PathValue, [string]$Kind, [string]$HomeValue) {
  $fullPath = Assert-PathInsideRoot $PathValue $HomeValue
  $item = Get-Item -LiteralPath $fullPath -Force
  if (($Kind -eq "file" -and $item.PSIsContainer) -or ($Kind -eq "directory" -and -not $item.PSIsContainer)) {
    throw "TargetPath kind mismatch"
  }
  $reparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  $acl = Get-Acl -LiteralPath $fullPath
  $writeMask = [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::CreateFiles -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  $writableSids = @($acl.Access |
    Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      ([int64]$_.FileSystemRights -band [int64]$writeMask) -ne 0
    } |
    ForEach-Object { Convert-IdentityToSid $_.IdentityReference } |
    Sort-Object -Unique)
  return [ordered]@{
    ownerSid = Convert-IdentityToSid $acl.Owner
    writableSids = $writableSids
    reparsePoint = $reparsePoint
  }
}

function Protect-StatePath([string]$PathValue, [string]$Kind, [string]$Sid, [string]$HomeValue) {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $Sid) {
    throw "ProtectState SID does not match the current user"
  }
  $fullPath = Assert-PathInsideRoot $PathValue $HomeValue
  $item = Get-Item -LiteralPath $fullPath -Force
  if (($Kind -eq "file" -and $item.PSIsContainer) -or ($Kind -eq "directory" -and -not $item.PSIsContainer)) {
    throw "TargetPath kind mismatch"
  }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "TargetPath may not be a reparse point" }

  $acl = Get-Acl -LiteralPath $fullPath
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $owner = [Security.Principal.SecurityIdentifier]::new($Sid)
  $acl.SetOwner($owner)
  $inheritance = if ($Kind -eq "directory") {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($writerSid in @($Sid, "S-1-5-18", "S-1-5-32-544")) {
    $identity = [Security.Principal.SecurityIdentifier]::new($writerSid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $fullPath -AclObject $acl
}

if ($Action -eq "InspectState" -or $Action -eq "ProtectState") {
  if ([string]::IsNullOrWhiteSpace($TargetPath) -or [string]::IsNullOrWhiteSpace($UserHome) -or
      [string]$UserSid -notmatch "^S-\d-(?:\d+-)+\d+$") {
    throw "State action parameters are invalid"
  }
  if ($Action -eq "ProtectState") { Protect-StatePath $TargetPath $ExpectedKind $UserSid $UserHome }
  $aclFacts = Get-StateAclFacts $TargetPath $ExpectedKind $UserHome
  if ($Action -eq "InspectState") { $aclFacts | ConvertTo-Json -Depth 4 -Compress }
  exit 0
}

function Get-Origin([string]$Value) {
  return ([System.Uri]$Value).GetLeftPart([System.UriPartial]::Authority)
}

function Test-OriginReachability([string]$Origin, [string[]]$AllowedOrigins) {
  $current = $Origin
  $redirects = @()
  for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $current -Method Head -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 15
      return [ordered]@{ origin = $Origin; reachable = $true; redirectOrigins = $redirects }
    } catch {
      $webResponse = $_.Exception.Response
      if ($null -eq $webResponse) {
        return [ordered]@{ origin = $Origin; reachable = $false; redirectOrigins = $redirects }
      }
      $statusCode = [int]$webResponse.StatusCode
      if ($statusCode -ge 400 -and $statusCode -lt 500) {
        return [ordered]@{ origin = $Origin; reachable = $true; redirectOrigins = $redirects }
      }
      if ($statusCode -lt 300 -or $statusCode -ge 500) {
        return [ordered]@{ origin = $Origin; reachable = $false; redirectOrigins = $redirects }
      }
      $location = [string]$webResponse.Headers["Location"]
      if ([string]::IsNullOrWhiteSpace($location)) {
        return [ordered]@{ origin = $Origin; reachable = $false; redirectOrigins = $redirects }
      }
      $next = [System.Uri]::new([System.Uri]$current, $location)
      $nextOrigin = $next.GetLeftPart([System.UriPartial]::Authority)
      $redirects += $nextOrigin
      if ($AllowedOrigins -notcontains $nextOrigin) {
        return [ordered]@{ origin = $Origin; reachable = $true; redirectOrigins = $redirects }
      }
      $current = $next.AbsoluteUri
    }
  }
  return [ordered]@{ origin = $Origin; reachable = $false; redirectOrigins = $redirects }
}

function Convert-IPv4ToInteger([string]$Address) {
  $parts = @($Address.Split(".") | ForEach-Object { [uint64][int]$_ })
  if ($parts.Count -ne 4 -or @($parts | Where-Object { $_ -gt 255 }).Count -gt 0) {
    throw "Invalid IPv4 address: $Address"
  }
  return ($parts[0] * 16777216) + ($parts[1] * 65536) + ($parts[2] * 256) + $parts[3]
}

function Get-CidrRange([string]$Prefix) {
  $values = $Prefix.Split("/", 2)
  if ($values.Count -ne 2) { throw "Invalid IPv4 prefix: $Prefix" }
  $prefixLength = [int]$values[1]
  if ($prefixLength -lt 0 -or $prefixLength -gt 32) { throw "Invalid IPv4 prefix: $Prefix" }
  $address = Convert-IPv4ToInteger $values[0]
  $hostBits = 32 - $prefixLength
  $size = [uint64][Math]::Pow(2, $hostBits)
  $start = [uint64]([Math]::Floor($address / $size) * $size)
  return [ordered]@{ start = $start; end = $start + $size - 1; prefixLength = $prefixLength }
}

function Test-CidrOverlap([string]$Left, [string]$Right) {
  $leftRange = Get-CidrRange $Left
  $rightRange = Get-CidrRange $Right
  return $leftRange.start -le $rightRange.end -and $rightRange.start -le $leftRange.end
}

function Get-AvailableSubnet {
  $routePrefixes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    ForEach-Object { [string]$_.DestinationPrefix } |
    Where-Object { $_ -and $_ -ne "0.0.0.0/0" })
  for ($octet = 255; $octet -ge 1; $octet -= 1) {
    $candidate = "172.31.$octet.0/30"
    $overlaps = @($routePrefixes | Where-Object { Test-CidrOverlap $candidate $_ })
    if ($overlaps.Count -eq 0) { return $candidate }
  }
  return $null
}

function Get-PortProxyTuples {
  $tuples = @()
  foreach ($line in @(netsh.exe interface portproxy show v4tov4 2>$null)) {
    if ([string]$line -match "^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$") {
      $tuples += [ordered]@{
        listenAddress = $Matches[1]
        listenPort = [int]$Matches[2]
        connectAddress = $Matches[3]
        connectPort = [int]$Matches[4]
      }
    }
  }
  return $tuples
}

function Invoke-Preflight($Request) {
  $operatingSystem = Get-CimInstance Win32_OperatingSystem
  $computer = Get-CimInstance Win32_ComputerSystem
  $processors = @(Get-CimInstance Win32_Processor)
  $systemDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($operatingSystem.SystemDrive)'"
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $tokenElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $groupOutput = (& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh 2>$null | Out-String)
  $isAdministrator = $groupOutput -match "S-1-5-32-544"
  $uacValue = Get-ItemPropertyValue -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name EnableLUA -ErrorAction SilentlyContinue
  $wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
  $vmpFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
  $wslCommand = Get-Command "$env:SystemRoot\System32\wsl.exe" -ErrorAction SilentlyContinue
  $wslInstalled = $null -ne $wslCommand
  $wslStatus = ""
  $distroNames = @()
  if ($wslInstalled) {
    $wslStatus = (& $wslCommand.Source --status 2>&1 | Out-String)
    $distroNames = @(& $wslCommand.Source --list --quiet 2>$null | ForEach-Object { [string]$_ -replace "\u0000", "" } | Where-Object { $_ })
  }
  $networkingMode = "nat"
  $wslConfig = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".wslconfig"
  if (Test-Path -LiteralPath $wslConfig -PathType Leaf) {
    $networkLine = Get-Content -LiteralPath $wslConfig | Where-Object { $_ -match "^\s*networkingMode\s*=" } | Select-Object -Last 1
    if ($networkLine) { $networkingMode = (($networkLine -split "=", 2)[1]).Trim().ToLowerInvariant() }
  }

  $managedPorts = @($Request.policy.windows.managed_ports | ForEach-Object { [int]$_ })
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    [ordered]@{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
  })
  $occupiedPorts = @($listeners | Where-Object { $managedPorts -contains $_.port } | ForEach-Object { $_.port } | Sort-Object -Unique)
  $portProxyTuples = @(Get-PortProxyTuples)
  $scheduledTasks = @(Get-ScheduledTask -TaskName "RainSkills-*" -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
  $programDataRoot = Join-Path $env:ProgramData "RainSkills"
  $unknownObjects = @()
  if ($distroNames -contains [string]$Request.policy.windows.distro_name) { $unknownObjects += "distro:$($Request.policy.windows.distro_name)" }
  if ($scheduledTasks.Count -gt 0) { $unknownObjects += @($scheduledTasks | ForEach-Object { "task:$_" }) }
  if (Test-Path -LiteralPath $programDataRoot) { $unknownObjects += "directory:$programDataRoot" }

  $allowedOrigins = @($Request.policy.windows.preflight_allowed_origins | ForEach-Object { Get-Origin ([string]$_) })
  $originChecks = @($allowedOrigins | ForEach-Object { Test-OriginReachability $_ $allowedOrigins })
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") { "x64" } else { $env:PROCESSOR_ARCHITECTURE.ToLowerInvariant() }
  $rebootPending = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
    (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")

  return [ordered]@{
    productType = if ([int]$operatingSystem.ProductType -eq 1) { "workstation" } else { "server" }
    buildNumber = [int]$operatingSystem.BuildNumber
    architecture = $architecture
    currentUserSid = $identity.User.Value
    localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    isAdministrator = [bool]$isAdministrator
    uacEnabled = [bool]([int]$uacValue -eq 1)
    cpuCores = [int]$computer.NumberOfLogicalProcessors
    memoryBytes = [long]$computer.TotalPhysicalMemory
    diskBytes = [long]$systemDrive.FreeSpace
    virtualizationEnabled = [bool]($computer.HypervisorPresent -or @($processors | Where-Object { $_.VirtualizationFirmwareEnabled }).Count -gt 0)
    tokenElevated = [bool]$tokenElevated
    wslFeatureState = [string]$wslFeature.State
    virtualMachinePlatformFeatureState = [string]$vmpFeature.State
    rebootPending = [bool]$rebootPending
    wslInstalled = [bool]$wslInstalled
    wslDefaultVersion = if ($wslStatus -match "(?im)default version:\s*(\d+)") { [int]$Matches[1] } else { $null }
    wslNetworkingMode = $networkingMode
    occupiedPorts = $occupiedPorts
    unknownManagedObjects = $unknownObjects
    availableSubnet = Get-AvailableSubnet
    originChecks = $originChecks
    listeners = $listeners
    portProxyTuples = $portProxyTuples
    distroNames = $distroNames
    scheduledTasks = $scheduledTasks
  }
}

function Test-IsElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PropertyValue($Object, [string]$Name, $DefaultValue = $null) {
  if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $DefaultValue
}

function Assert-NoExecutableFields($Value) {
  if ($null -eq $Value -or $Value -is [string] -or $Value.GetType().IsPrimitive) { return }
  if ($Value -is [Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      if ([string]$key -match "^(?i:command|script)$") { throw "Request may not contain command or script" }
      Assert-NoExecutableFields $Value[$key]
    }
    return
  }
  if ($Value -is [Collections.IEnumerable]) {
    foreach ($item in $Value) { Assert-NoExecutableFields $item }
    return
  }
  foreach ($property in @($Value.PSObject.Properties)) {
    if ($property.Name -match "^(?i:command|script)$") { throw "Request may not contain command or script" }
    Assert-NoExecutableFields $property.Value
  }
}

function Write-ActionResult($Request, $Facts, [string]$Status = "ok") {
  $result = [ordered]@{
    schema = "rainskills.windows-result.v1"
    action = $Action
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    nonce = $Request.nonce
    status = $Status
    facts = $Facts
  }
  $json = $result | ConvertTo-Json -Depth 16
  [IO.File]::WriteAllText($ResultPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Invoke-ElevatedSelf {
  foreach ($value in @($PSCommandPath, $RequestPath, $ResultPath)) {
    if ([string]$value -match '"') { throw "Elevated helper paths may not contain quotes" }
  }
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath +
    '" -Action ' + $Action + ' -RequestPath "' + $RequestPath + '" -ResultPath "' + $ResultPath + '"'
  $process = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Elevated Windows helper failed with exit code $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) { throw "Elevated Windows helper did not write a result" }
}

function Get-MachineRoot($Request) {
  return Join-Path (Join-Path $env:ProgramData "RainSkills") ([string]$Request.installation_id)
}

function Set-MachineRootAcl([string]$MachineRoot, [string]$OriginalSid) {
  $result = & "$env:SystemRoot\System32\icacls.exe" $MachineRoot /inheritance:r `
    /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*$OriginalSid`:(OI)(CI)RX" /t /c 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to protect ProgramData machine bundle: $($result -join ' ')" }
}

function Assert-FileDigest([string]$FilePath, [string]$ExpectedDigest) {
  $item = Get-Item -LiteralPath $FilePath -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Digest source must be a regular non-reparse file"
  }
  $actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne ([string]$ExpectedDigest).ToLowerInvariant()) { throw "SHA-256 mismatch for $FilePath" }
  return $actual
}

function Invoke-InstallMachineBundle($Request) {
  $payload = $Request.payload
  $sourceHelper = [string](Get-PropertyValue $payload "helper_path")
  $expectedHelperDigest = [string](Get-PropertyValue $payload "helper_sha256")
  $recoveryRoot = [string](Get-PropertyValue $payload "recovery_root")
  $recoveryManifestDigest = [string](Get-PropertyValue $payload "recovery_manifest_sha256")
  $nodePath = [string](Get-PropertyValue $payload "node_path")
  $recoveryEntry = [string](Get-PropertyValue $payload "recovery_entry")
  $bootstrapSource = [string](Get-PropertyValue $payload "bootstrap_path")
  $bootstrapDigest = [string](Get-PropertyValue $payload "bootstrap_sha256")
  $controlMode = [string](Get-PropertyValue $payload "control_mode" "windows-native")
  $controlDistro = Get-PropertyValue $payload "control_distro"
  $controlNodePath = Get-PropertyValue $payload "control_node_path"
  $controlRecoveryEntry = Get-PropertyValue $payload "control_recovery_entry"
  if ($controlMode -notin @("windows-native", "wsl")) { throw "Unsupported control_mode" }
  if ($controlMode -eq "wsl") {
    foreach ($value in @($controlDistro, $controlNodePath, $controlRecoveryEntry)) {
      if ([string]::IsNullOrWhiteSpace([string]$value) -or [string]$value -match '[\x00-\x1f\x7f"]') {
        throw "Invalid WSL control path or distro"
      }
    }
    if (-not ([string]$controlNodePath).StartsWith("/") -or
        -not ([string]$controlRecoveryEntry).StartsWith("/")) {
      throw "WSL control paths must be absolute Linux paths"
    }
  }
  if (-not (Test-Path -LiteralPath $recoveryRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $recoveryEntry -PathType Leaf)) {
    throw "Recovery bundle or Node runtime is missing"
  }
  [void](Assert-FileDigest $sourceHelper $expectedHelperDigest)
  [void](Assert-FileDigest $bootstrapSource $bootstrapDigest)
  [void](Assert-FileDigest (Join-Path $recoveryRoot "manifest.json") $recoveryManifestDigest)

  $machineRoot = Get-MachineRoot $Request
  $machineHelper = Join-Path $machineRoot "windows-platform.ps1"
  $manifestPath = Join-Path $machineRoot "machine-manifest.json"
  if (Test-Path -LiteralPath $machineRoot) {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Unknown existing RainSkills machine directory" }
    $existing = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($existing.installation_id -ne $Request.installation_id -or $existing.helper_sha256 -ne $expectedHelperDigest) {
      throw "Existing RainSkills machine bundle belongs to another installation"
    }
  } else {
    New-Item -ItemType Directory -Path $machineRoot | Out-Null
  }
  Copy-Item -LiteralPath $sourceHelper -Destination $machineHelper -Force
  $machineBootstrap = Join-Path $machineRoot "wsl-bootstrap.sh"
  Copy-Item -LiteralPath $bootstrapSource -Destination $machineBootstrap -Force
  [void](Assert-FileDigest $machineHelper $expectedHelperDigest)
  [void](Assert-FileDigest $machineBootstrap $bootstrapDigest)
  $manifest = [ordered]@{
    schema = "rainskills.windows-machine-bundle.v1"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    original_user_sid = $Request.user_sid
    helper_sha256 = $expectedHelperDigest
    bootstrap_sha256 = $bootstrapDigest
    recovery_root = $recoveryRoot
    recovery_manifest_sha256 = $recoveryManifestDigest
    recovery_entry = $recoveryEntry
    node_path = $nodePath
    control_mode = $controlMode
    control_distro = if ($controlMode -eq "wsl") { [string]$controlDistro } else { $null }
    control_node_path = if ($controlMode -eq "wsl") { [string]$controlNodePath } else { $null }
    control_recovery_entry = if ($controlMode -eq "wsl") { [string]$controlRecoveryEntry } else { $null }
  }
  [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 6) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $lease = [ordered]@{
    schema = "rainskills.windows-machine-lease.v1"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    original_user_sid = $Request.user_sid
    nonce = $Request.nonce
    updated_at = [DateTime]::UtcNow.ToString("o")
  }
  [IO.File]::WriteAllText((Join-Path $machineRoot "lease.json"), (($lease | ConvertTo-Json -Depth 4) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Set-MachineRootAcl $machineRoot $Request.user_sid
  [void](Assert-FileDigest $machineHelper $expectedHelperDigest)
  return [ordered]@{ machineBundleVerified = $true; machineRoot = $machineRoot; helperPath = $machineHelper }
}

function Get-TrustedWslPath {
  $wslPath = "$env:SystemRoot\System32\wsl.exe"
  if (-not (Test-Path -LiteralPath $wslPath -PathType Leaf)) { return $null }
  $signature = Get-AuthenticodeSignature -LiteralPath $wslPath
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      [string]$signature.SignerCertificate.Subject -notmatch "Microsoft") {
    throw "wsl.exe does not have a valid Microsoft Authenticode signature"
  }
  return $wslPath
}

function Get-WslRuntimeFacts {
  $wslFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux
  $vmpFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
  $wslPath = Get-TrustedWslPath
  $versionOutput = ""
  $statusOutput = ""
  if ($wslPath) {
    $versionOutput = (& $wslPath --version 2>&1 | Out-String)
    $versionExitCode = $LASTEXITCODE
    $statusOutput = (& $wslPath --status 2>&1 | Out-String)
  } else {
    $versionExitCode = 1
  }
  $defaultVersion = Get-ItemPropertyValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss" `
    -Name DefaultVersion -ErrorAction SilentlyContinue
  $rebootPending = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
    (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
  return [ordered]@{
    wslFeatureState = [string]$wslFeature.State
    virtualMachinePlatformFeatureState = [string]$vmpFeature.State
    wslPath = $wslPath
    wslVersion = if ($versionOutput -match "(?m)(\d+\.\d+(?:\.\d+){0,2})") { $Matches[1] } else { $null }
    wslVersionCommandSucceeded = [bool]($versionExitCode -eq 0)
    wslDefaultVersion = if ($null -ne $defaultVersion) { [int]$defaultVersion } elseif ($statusOutput -match "(?im)default version:\s*(\d+)") { [int]$Matches[1] } else { $null }
    rebootPending = [bool]$rebootPending
  }
}

function Install-LegacyWslKernel($Request) {
  $machineRoot = Get-MachineRoot $Request
  $msiPath = Join-Path $machineRoot "wsl_update_x64.msi"
  $artifact = $Request.policy.windows.legacy_wsl_kernel
  Invoke-WebRequest -Uri $artifact.url -OutFile $msiPath -UseBasicParsing
  [void](Assert-FileDigest $msiPath $artifact.sha256)
  $signature = Get-AuthenticodeSignature -LiteralPath $msiPath
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      [string]$signature.SignerCertificate.Subject -notmatch "Microsoft") {
    throw "Legacy WSL kernel MSI does not have a valid Microsoft Authenticode signature"
  }
  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList @("/i", $msiPath, "/quiet", "/norestart") -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) { throw "Legacy WSL kernel installation failed: $($process.ExitCode)" }
}

function Invoke-EnableWsl($Request) {
  $facts = Get-WslRuntimeFacts
  $restartNeeded = $false
  if ($facts.wslFeatureState -ne "Enabled") {
    $featureResult = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -All -NoRestart
    $restartNeeded = $restartNeeded -or [bool]$featureResult.RestartNeeded
  }
  if ($facts.virtualMachinePlatformFeatureState -ne "Enabled") {
    $featureResult = Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
    $restartNeeded = $restartNeeded -or [bool]$featureResult.RestartNeeded
  }
  if ($restartNeeded) {
    $pendingFacts = Get-WslRuntimeFacts
    $pendingFacts["rebootPending"] = $true
    return $pendingFacts
  }
  $wslPath = "$env:SystemRoot\System32\wsl.exe"
  if (Test-Path -LiteralPath $wslPath -PathType Leaf) {
    & $wslPath --version *> $null
    if ($LASTEXITCODE -ne 0) {
      & $wslPath --update --web-download | ForEach-Object { Write-Host $_ }
      if ($LASTEXITCODE -ne 0) { Install-LegacyWslKernel $Request }
    }
  } else {
    throw "wsl.exe is unavailable after enabling Windows features; reboot and resume are required"
  }
  & $wslPath --set-default-version 2 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "Failed to set WSL default version 2" }
  return Get-WslRuntimeFacts
}

function Invoke-UpdateWsl($Request) {
  $wslPath = Get-TrustedWslPath
  if (-not $wslPath) { throw "wsl.exe is not installed" }
  & $wslPath --update --web-download | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { Install-LegacyWslKernel $Request }
  return Get-WslRuntimeFacts
}

function Get-ManagedDistroNames {
  $wslPath = Get-TrustedWslPath
  if (-not $wslPath) { throw "wsl.exe is not installed" }
  return @(& $wslPath --list --quiet 2>$null |
    ForEach-Object { ([string]$_ -replace "\u0000", "").Trim() } |
    Where-Object { $_ })
}

function Convert-WindowsPathForDistro([string]$WindowsPath) {
  $wslPath = Get-TrustedWslPath
  $converted = (& $wslPath -d Rainbond -u root -- wslpath -u $WindowsPath 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $converted -notmatch "^/mnt/[a-zA-Z]/") {
    throw "wslpath -u failed for the managed helper path"
  }
  return $converted
}

function Invoke-DistroBootstrap($Request, [string]$BootstrapAction, [string]$HostAddress = "", [string]$GuestAddress = "", [string]$InstallerPath = "", [string]$InstallerDigest = "") {
  $wslPath = Get-TrustedWslPath
  $machineRoot = Get-MachineRoot $Request
  $manifest = Assert-MachineManifest $Request
  $bootstrapPath = Join-Path $machineRoot "wsl-bootstrap.sh"
  [void](Assert-FileDigest $bootstrapPath $manifest.bootstrap_sha256)
  $linuxBootstrap = Convert-WindowsPathForDistro $bootstrapPath
  $arguments = @("-d", "Rainbond", "-u", "root", "--", "/bin/bash", $linuxBootstrap,
    "--action", $BootstrapAction, "--installation-id", [string]$Request.installation_id)
  if ($HostAddress) { $arguments += @("--host-address", $HostAddress) }
  if ($GuestAddress) { $arguments += @("--guest-address", $GuestAddress) }
  if ($InstallerPath) { $arguments += @("--installer-path", $InstallerPath) }
  if ($InstallerDigest) { $arguments += @("--installer-sha256", $InstallerDigest) }
  & $wslPath @arguments 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "Managed WSL bootstrap action failed: $BootstrapAction" }
}

function Get-DistroIdentity($Request) {
  $wslPath = Get-TrustedWslPath
  $identity = (& $wslPath -d Rainbond -u root -- cat /etc/rainskills-installation-id 2>$null | Out-String).Trim()
  return $identity
}

function Assert-SystemdPidOne($Request) {
  $wslPath = Get-TrustedWslPath
  & $wslPath -d Rainbond -u root -- /bin/true | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to start the managed Rainbond distro" }
  $pidOne = (& $wslPath -d Rainbond -u root -- ps -p 1 -o comm= 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $pidOne -ne "systemd") { throw "PID 1 in the managed Rainbond distro is not systemd" }
  if ((Get-DistroIdentity $Request) -ne $Request.installation_id) { throw "Managed distro identity mismatch" }
  return $true
}

function Invoke-ImportDistro($Request) {
  if ([string]$Request.policy.windows.distro_name -ne "Rainbond") { throw "The policy distro name must be Rainbond" }
  $payload = $Request.payload
  $rootfsPath = Assert-PathInsideRoot ([string](Get-PropertyValue $payload "rootfs_path")) ([Environment]::GetFolderPath("UserProfile"))
  $distroRoot = [IO.Path]::GetFullPath([string](Get-PropertyValue $payload "distro_root")).TrimEnd("\")
  $expectedDistroRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "RainSkills\Distros\$($Request.installation_id)")).TrimEnd("\")
  if (-not $distroRoot.Equals($expectedDistroRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Managed distro root is outside the installation-specific LocalAppData path"
  }
  [void](Assert-FileDigest $rootfsPath $Request.policy.windows.ubuntu_rootfs.sha256)
  $distroNames = Get-ManagedDistroNames
  if ($distroNames -contains "Rainbond") {
    if ((Get-DistroIdentity $Request) -ne $Request.installation_id) {
      throw "An existing Rainbond WSL distro is not owned by this installation"
    }
  } else {
    if (Test-Path -LiteralPath $distroRoot) { throw "Unknown existing Rainbond distro directory" }
    New-Item -ItemType Directory -Path $distroRoot -Force | Out-Null
    $wslPath = Get-TrustedWslPath
    & $wslPath --import Rainbond $distroRoot $rootfsPath --version 2 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
      if ((Get-ManagedDistroNames) -notcontains "Rainbond" -and (Test-Path -LiteralPath $distroRoot)) {
        Remove-Item -LiteralPath $distroRoot -Recurse -Force
      }
      throw "wsl --import Rainbond failed"
    }
    Invoke-DistroBootstrap $Request "PrepareRuntime"
    & $wslPath --terminate Rainbond | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to terminate the managed Rainbond distro after enabling systemd" }
  }
  [void](Assert-SystemdPidOne $Request)
  return [ordered]@{
    distroIdentityVerified = $true
    systemdReady = $true
    distroName = "Rainbond"
    distroRoot = $distroRoot
  }
}

function Invoke-PrepareRuntime($Request) {
  if ((Get-ManagedDistroNames) -notcontains "Rainbond" -or (Get-DistroIdentity $Request) -ne $Request.installation_id) {
    throw "The managed Rainbond distro is missing or has the wrong identity"
  }
  Invoke-DistroBootstrap $Request "PrepareRuntime"
  $wslPath = Get-TrustedWslPath
  & $wslPath --terminate Rainbond | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to restart the managed Rainbond distro" }
  [void](Assert-SystemdPidOne $Request)
  return [ordered]@{ distroIdentityVerified = $true; systemdReady = $true }
}

function Get-WslNetworkingMode {
  $configPath = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".wslconfig"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return "nat" }
  $line = Get-Content -LiteralPath $configPath |
    Where-Object { $_ -match "^\s*networkingMode\s*=" } |
    Select-Object -Last 1
  if (-not $line) { return "nat" }
  return (($line -split "=", 2)[1]).Trim().ToLowerInvariant()
}

function Get-WslAdapter {
  $adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq "Up" -and ($_.Name -like "*WSL*" -or $_.InterfaceDescription -like "*Hyper-V Virtual Ethernet*") })
  if ($adapters.Count -ne 1) { throw "Unable to identify exactly one active WSL NAT adapter" }
  return $adapters[0]
}

function Get-WslHnsNetworkId($Adapter) {
  if (Get-Command Get-HnsNetwork -ErrorAction SilentlyContinue) {
    $networks = @(Get-HnsNetwork | Where-Object { $_.Name -eq "WSL" -or $_.Name -eq "WSL (Hyper-V firewall)" })
    if ($networks.Count -eq 1) { return [string]$networks[0].ID }
  }
  return [string]$Adapter.InterfaceGuid
}

function Get-NetworkManifestPath($Request) {
  return Join-Path (Get-MachineRoot $Request) "managed-network.json"
}

function New-SecureNonce {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Assert-NetworkManifestDigest($Request) {
  $manifestPath = Get-NetworkManifestPath $Request
  $digestPath = Join-Path (Get-MachineRoot $Request) "managed-network.sha256"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $digestPath -PathType Leaf)) {
    throw "Managed network manifest or digest is missing"
  }
  $expected = (Get-Content -LiteralPath $digestPath -Raw).Trim().ToLowerInvariant()
  [void](Assert-FileDigest $manifestPath $expected)
}

function Register-NetworkMaintenance($Request, $Manifest) {
  $machineRoot = Get-MachineRoot $Request
  $machineHelper = Join-Path $machineRoot "windows-platform.ps1"
  $nonce = [string]$Manifest.maintenance_nonce
  $maintenanceRequest = Join-Path $machineRoot "request-$nonce.json"
  $maintenanceResult = Join-Path $machineRoot "result-$nonce.json"
  $requestValue = [ordered]@{
    schema = "rainskills.windows-request.v1"
    action = "ConfigureNetwork"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    nonce = $nonce
    user_sid = $Request.user_sid
    policy = $Request.policy
    payload = [ordered]@{
      subnet = $Manifest.subnet
      host_address = $Manifest.host_address
      guest_address = $Manifest.guest_address
      maintenance = $true
    }
  }
  [IO.File]::WriteAllText($maintenanceRequest, (($requestValue | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Set-MachineRootAcl $machineRoot $Request.user_sid
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $machineHelper +
    '" -Action ConfigureNetwork -RequestPath "' + $maintenanceRequest + '" -ResultPath "' + $maintenanceResult + '"'
  $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Request.user_sid
  $trigger.Delay = "PT10S"
  $principal = New-ScheduledTaskPrincipal -UserId $Request.user_sid -LogonType Interactive -RunLevel Highest
  $taskName = "RainSkills-Network-$($Request.installation_id)"
  Register-VerifiedTask $taskName $taskAction $trigger $principal
  return $taskName
}

function Test-ExpectedPortProxy($Tuples, [string]$GuestAddress, [int[]]$Ports) {
  foreach ($port in $Ports) {
    $matches = @($Tuples | Where-Object {
      $_.listenAddress -eq "127.0.0.1" -and $_.listenPort -eq $port -and
      $_.connectAddress -eq $GuestAddress -and $_.connectPort -eq $port
    })
    if ($matches.Count -ne 1) { return $false }
  }
  $managed = @($Tuples | Where-Object { $Ports -contains $_.listenPort })
  return $managed.Count -eq $Ports.Count
}

function Invoke-ConfigureNetwork($Request) {
  if ((Get-WslNetworkingMode) -ne "nat") { throw "WSL networkingMode must remain nat" }
  if ((Get-DistroIdentity $Request) -ne $Request.installation_id) { throw "Managed distro identity mismatch" }
  $payload = $Request.payload
  $subnet = [string](Get-PropertyValue $payload "subnet")
  $hostAddress = [string](Get-PropertyValue $payload "host_address")
  $guestAddress = [string](Get-PropertyValue $payload "guest_address")
  if ($subnet -notmatch "^172\.31\.(\d{1,3})\.0/30$") {
    throw "Managed network addresses are invalid"
  }
  $thirdOctet = $Matches[1]
  if ($hostAddress -ne "172.31.$thirdOctet.1" -or $guestAddress -ne "172.31.$thirdOctet.2") {
    throw "Managed host and guest addresses do not belong to the selected /30"
  }
  $adapter = Get-WslAdapter
  $hnsNetworkId = Get-WslHnsNetworkId $adapter
  $manifestPath = Get-NetworkManifestPath $Request
  $existing = $null
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    Assert-NetworkManifestDigest $Request
    $existing = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($existing.installation_id -ne $Request.installation_id -or $existing.subnet -ne $subnet -or
        $existing.adapter_ifindex -ne $adapter.ifIndex -or $existing.hns_network_id -ne $hnsNetworkId) {
      throw "Managed network manifest does not match current WSL facts"
    }
  }
  $existingAddress = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $hostAddress -ErrorAction SilentlyContinue)
  if ($existingAddress.Count -gt 0 -and @($existingAddress | Where-Object { $_.InterfaceIndex -ne $adapter.ifIndex }).Count -gt 0) {
    throw "The managed host address is owned by another interface"
  }
  if ($existingAddress.Count -eq 0) {
    New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $hostAddress -PrefixLength 30 -AddressFamily IPv4 | Out-Null
  }
  Invoke-DistroBootstrap $Request "ConfigureGuestNetwork" $hostAddress $guestAddress

  $ports = @($Request.policy.windows.managed_ports | ForEach-Object { [int]$_ })
  $currentTuples = @(Get-PortProxyTuples)
  $conflicts = @($currentTuples | Where-Object {
    $ports -contains $_.listenPort -and -not (
      $_.listenAddress -eq "127.0.0.1" -and $_.connectAddress -eq $guestAddress -and $_.connectPort -eq $_.listenPort
    )
  })
  if ($conflicts.Count -gt 0) { throw "Unknown or externally changed portproxy rules use RainSkills managed ports" }
  foreach ($port in $ports) {
    $present = @($currentTuples | Where-Object {
      $_.listenAddress -eq "127.0.0.1" -and $_.listenPort -eq $port -and
      $_.connectAddress -eq $guestAddress -and $_.connectPort -eq $port
    }).Count -eq 1
    if (-not $present) {
      & "$env:SystemRoot\System32\netsh.exe" interface portproxy add v4tov4 `
        listenaddress=127.0.0.1 listenport=$port connectaddress=$guestAddress connectport=$port | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Failed to create managed loopback portproxy for port $port" }
    }
  }
  $tuples = @(Get-PortProxyTuples)
  if (-not (Test-ExpectedPortProxy $tuples $guestAddress $ports)) { throw "Managed portproxy read-back mismatch" }
  $maintenanceNonce = if ($existing) { [string](Get-PropertyValue $existing "maintenance_nonce") } else { "" }
  if ([string]::IsNullOrWhiteSpace($maintenanceNonce)) { $maintenanceNonce = New-SecureNonce }
  $manifest = [ordered]@{
    schema = "rainskills.windows-managed-network.v1"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    hns_network_id = $hnsNetworkId
    adapter_ifindex = [int]$adapter.ifIndex
    subnet = $subnet
    host_address = $hostAddress
    guest_address = $guestAddress
    portproxy = @($tuples | Where-Object { $ports -contains $_.listenPort })
    maintenance_nonce = $maintenanceNonce
    acl_owner = "S-1-5-32-544"
    writable_sids = @("S-1-5-18", "S-1-5-32-544")
  }
  [IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $manifestDigest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path (Get-MachineRoot $Request) "managed-network.sha256"), $manifestDigest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Set-MachineRootAcl (Get-MachineRoot $Request) $Request.user_sid
  $maintenanceTask = Register-NetworkMaintenance $Request $manifest
  return [ordered]@{
    networkManifestVerified = $true
    portproxyVerified = $true
    subnet = $subnet
    hostAddress = $hostAddress
    guestAddress = $guestAddress
    hnsNetworkId = $hnsNetworkId
    adapterIfIndex = [int]$adapter.ifIndex
    maintenanceTask = $maintenanceTask
  }
}

function Invoke-VerifyNetwork($Request) {
  $manifestPath = Get-NetworkManifestPath $Request
  Assert-NetworkManifestDigest $Request
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $adapter = Get-WslAdapter
  if ($manifest.operation_id -ne $Request.operation_id -or $manifest.installation_id -ne $Request.installation_id -or
      $manifest.adapter_ifindex -ne $adapter.ifIndex -or $manifest.hns_network_id -ne (Get-WslHnsNetworkId $adapter)) {
    throw "Managed network identity changed"
  }
  $ports = @($Request.policy.windows.managed_ports | ForEach-Object { [int]$_ })
  if (-not (Test-ExpectedPortProxy @(Get-PortProxyTuples) $manifest.guest_address $ports)) {
    throw "Managed portproxy snapshot changed"
  }
  $hostAddress = @(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $manifest.host_address -ErrorAction SilentlyContinue)
  if ($hostAddress.Count -ne 1) { throw "Managed host address is missing" }
  if ((Get-DistroIdentity $Request) -ne $Request.installation_id) { throw "Managed distro identity mismatch" }
  return [ordered]@{
    networkManifestVerified = $true
    portproxyVerified = $true
    subnet = $manifest.subnet
    hostAddress = $manifest.host_address
    guestAddress = $manifest.guest_address
  }
}

function Get-VerifiedManagedNetwork($Request) {
  [void](Invoke-VerifyNetwork $Request)
  $manifest = Get-Content -LiteralPath (Get-NetworkManifestPath $Request) -Raw | ConvertFrom-Json
  return $manifest
}

function Invoke-PrepareDocker($Request) {
  $network = Get-VerifiedManagedNetwork $Request
  Invoke-DistroBootstrap $Request "PrepareDocker" ([string]$network.host_address) ([string]$network.guest_address)
  $wslPath = Get-TrustedWslPath
  & $wslPath -d Rainbond -u root -- docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw "Docker is not ready in the managed Rainbond distro" }
  return [ordered]@{ dockerReady = $true; networkGateReady = $true; systemdReady = $true }
}

function Invoke-InstallRainbond($Request) {
  $network = Get-VerifiedManagedNetwork $Request
  $installerPath = Assert-PathInsideRoot ([string](Get-PropertyValue $Request.payload "installer_path")) ([Environment]::GetFolderPath("UserProfile"))
  [void](Assert-FileDigest $installerPath $Request.policy.installer.sha256)
  $linuxInstaller = Convert-WindowsPathForDistro $installerPath
  Invoke-DistroBootstrap $Request "InstallRainbond" ([string]$network.host_address) `
    ([string]$network.guest_address) $linuxInstaller ([string]$Request.policy.installer.sha256)
  $wslPath = Get-TrustedWslPath
  $status = (& $wslPath -d Rainbond -u root -- docker inspect rainbond --format "{{.State.Status}}" 2>$null | Out-String).Trim()
  if ($status -ne "running") { throw "Rainbond outer container is not running after installation" }
  return [ordered]@{ dockerReady = $true; rainbondRuntimeVerified = $true; containerRunning = $true }
}

function Invoke-VerifyDeployment($Request) {
  $network = Get-VerifiedManagedNetwork $Request
  Invoke-DistroBootstrap $Request "VerifyRainbond" ([string]$network.host_address) ([string]$network.guest_address)
  $windowsReachable = $false
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:7070/" -UseBasicParsing -TimeoutSec 15
    $windowsReachable = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    $windowsReachable = $false
  }
  $ports = @($Request.policy.windows.managed_ports | ForEach-Object { [int]$_ })
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
  $portsListening = @($ports | Where-Object { $port = $_; @($listeners | Where-Object { $_.LocalPort -eq $port }).Count -gt 0 })
  return [ordered]@{
    installationId = [string]$Request.installation_id
    containerRunning = $true
    nodeReady = $true
    componentsReady = $true
    wslConsoleReachable = $true
    windowsConsoleReachable = [bool]$windowsReachable
    portsListening = $portsListening
    guestAddress = [string]$network.guest_address
    windowsConsoleUrl = "http://127.0.0.1:7070"
    controlConsoleUrl = "http://127.0.0.1:7070"
  }
}

function Get-TaskNames($Request) {
  return [ordered]@{
    machine = "RainSkills-Machine-$($Request.installation_id)"
    user = "RainSkills-User-$($Request.installation_id)"
    finalizer = "RainSkills-Finalize-$($Request.installation_id)"
  }
}

function Assert-MachineManifest($Request) {
  $machineRoot = Get-MachineRoot $Request
  $manifestPath = Join-Path $machineRoot "machine-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Machine manifest is missing" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.operation_id -ne $Request.operation_id -or
      $manifest.installation_id -ne $Request.installation_id -or
      $manifest.original_user_sid -ne $Request.user_sid) {
    throw "Machine manifest identity mismatch"
  }
  [void](Assert-FileDigest (Join-Path $machineRoot "windows-platform.ps1") $manifest.helper_sha256)
  [void](Assert-FileDigest (Join-Path $machineRoot "wsl-bootstrap.sh") $manifest.bootstrap_sha256)
  [void](Assert-FileDigest (Join-Path $manifest.recovery_root "manifest.json") $manifest.recovery_manifest_sha256)
  return $manifest
}

function Register-VerifiedTask([string]$TaskName, $ActionValue, $Trigger, $Principal) {
  Register-ScheduledTask -TaskName $TaskName -Action $ActionValue -Trigger $Trigger -Principal $Principal -Force | Out-Null
  $task = Get-ScheduledTask -TaskName $TaskName
  if ($task.Principal.UserId -ne $Principal.UserId -or $task.Principal.RunLevel -ne $Principal.RunLevel -or
      $task.Actions.Execute -ne $ActionValue.Execute -or $task.Actions.Arguments -ne $ActionValue.Arguments) {
    throw "Scheduled task read-back mismatch: $TaskName"
  }
}

function Invoke-RegisterResume($Request) {
  $manifest = Assert-MachineManifest $Request
  $names = Get-TaskNames $Request
  $machineRoot = Get-MachineRoot $Request
  $machineHelper = Join-Path $machineRoot "windows-platform.ps1"
  $machineRequest = Join-Path $machineRoot "request-$($Request.nonce).json"
  $machineResult = Join-Path $machineRoot "result-$($Request.nonce).json"
  $machineRequestValue = [ordered]@{
    schema = "rainskills.windows-request.v1"
    action = "VerifyWsl"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    nonce = $Request.nonce
    user_sid = $Request.user_sid
    policy = $Request.policy
    payload = [ordered]@{ resume = $true }
  }
  [IO.File]::WriteAllText($machineRequest, (($machineRequestValue | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Set-MachineRootAcl $machineRoot $Request.user_sid
  $powershellPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $machineArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $machineHelper +
    '" -Action VerifyWsl -RequestPath "' + $machineRequest + '" -ResultPath "' + $machineResult + '"'
  $machineAction = New-ScheduledTaskAction -Execute $powershellPath -Argument $machineArguments
  $machineTrigger = New-ScheduledTaskTrigger -AtLogOn -User $Request.user_sid
  $machineTrigger.Delay = "PT15S"
  $machinePrincipal = New-ScheduledTaskPrincipal -UserId $Request.user_sid -LogonType Interactive -RunLevel Highest
  Register-VerifiedTask $names.machine $machineAction $machineTrigger $machinePrincipal

  if ($manifest.control_mode -eq "wsl") {
    $wslExecutable = "$env:SystemRoot\System32\wsl.exe"
    $userArguments = '-d "' + $manifest.control_distro + '" --exec "' + $manifest.control_node_path +
      '" "' + $manifest.control_recovery_entry + '" platform install --onboarding-id ' +
      $Request.operation_id + ' --target local-windows --yes'
    $userAction = New-ScheduledTaskAction -Execute $wslExecutable -Argument $userArguments
  } else {
    $userArguments = '"' + $manifest.recovery_entry + '" platform install --onboarding-id ' +
      $Request.operation_id + ' --target local-windows --yes'
    $userAction = New-ScheduledTaskAction -Execute $manifest.node_path -Argument $userArguments
  }
  $userTrigger = New-ScheduledTaskTrigger -AtLogOn -User $Request.user_sid
  $userTrigger.Delay = "PT45S"
  $userPrincipal = New-ScheduledTaskPrincipal -UserId $Request.user_sid -LogonType Interactive
  Register-VerifiedTask $names.user $userAction $userTrigger $userPrincipal
  return [ordered]@{ recoveryTasksVerified = $true; machineTask = $names.machine; userTask = $names.user }
}

function Invoke-RegisterFinalize($Request) {
  $manifest = Assert-MachineManifest $Request
  $names = Get-TaskNames $Request
  $machineRoot = Get-MachineRoot $Request
  $machineHelper = Join-Path $machineRoot "windows-platform.ps1"
  $nonceBytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($nonceBytes)
  $finalizerNonce = -join ($nonceBytes | ForEach-Object { $_.ToString("x2") })
  $finalizerRequest = Join-Path $machineRoot "request-$finalizerNonce.json"
  $finalizerResult = Join-Path $machineRoot "result-$finalizerNonce.json"
  $finalizerRequestValue = [ordered]@{
    schema = "rainskills.windows-request.v1"
    action = "Finalize"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    nonce = $finalizerNonce
    user_sid = $Request.user_sid
    policy = $Request.policy
    payload = [ordered]@{ terminal_nonce = $finalizerNonce }
  }
  [IO.File]::WriteAllText($finalizerRequest, (($finalizerRequestValue | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $machineHelper +
    '" -Action Finalize -RequestPath "' + $finalizerRequest + '" -ResultPath "' + $finalizerResult + '"'
  $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Request.user_sid
  $trigger.Delay = "PT2M"
  $principal = New-ScheduledTaskPrincipal -UserId $Request.user_sid -LogonType Interactive -RunLevel Highest
  Register-VerifiedTask $names.finalizer $taskAction $trigger $principal
  Set-MachineRootAcl $machineRoot $Request.user_sid
  return [ordered]@{
    finalizerTaskVerified = $true
    finalizerTask = $names.finalizer
    finalizerNonce = $finalizerNonce
    recoveryRoot = $manifest.recovery_root
  }
}

function Invoke-RequestReboot($Request) {
  $names = Get-TaskNames $Request
  foreach ($name in @($names.machine, $names.user, $names.finalizer)) {
    if (-not (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) { throw "Recovery task is missing: $name" }
  }
  return [ordered]@{ restartRequested = $true; recoveryTasksVerified = $true }
}

function Invoke-Finalize($Request) {
  $machineRoot = Get-MachineRoot $Request
  $requestedStatus = [string](Get-PropertyValue $Request.payload "status")
  if ($requestedStatus -eq "success") {
    $fresh = Invoke-VerifyDeployment $Request
    if (-not $fresh.windowsConsoleReachable) { throw "Cannot finalize before fresh deployment verification passes" }
    $names = Get-TaskNames $Request
    foreach ($name in @($names.machine, $names.user, $names.finalizer)) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $machineRoot "lease.json") -Force -ErrorAction SilentlyContinue
    return [ordered]@{ finalized = $true; verified = $true }
  }
  $terminalMarker = Join-Path $machineRoot "terminal-result.json"
  if (-not (Test-Path -LiteralPath $terminalMarker -PathType Leaf)) {
    return [ordered]@{ finalized = $false; waitingForTerminalMarker = $true }
  }
  $terminal = Get-Content -LiteralPath $terminalMarker -Raw | ConvertFrom-Json
  if ($terminal.operation_id -ne $Request.operation_id -or $terminal.installation_id -ne $Request.installation_id -or
      $terminal.nonce -ne $Request.nonce -or $terminal.status -notin @("success", "cancelled", "failed")) {
    throw "Terminal marker identity mismatch"
  }
  $names = Get-TaskNames $Request
  foreach ($name in @($names.machine, $names.user, $names.finalizer)) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath (Join-Path $machineRoot "lease.json") -Force -ErrorAction SilentlyContinue
  return [ordered]@{ finalized = $true }
}

function Invoke-PrepareWsl($Request) {
  Write-Host "[1/2] Preparing the protected RainSkills recovery bundle..."
  $bundle = Invoke-InstallMachineBundle $Request
  Write-Host "[2/2] Enabling and verifying WSL 2..."
  $wsl = Invoke-EnableWsl $Request
  $facts = [ordered]@{
    machineBundleVerified = [bool]$bundle.machineBundleVerified
    machineRoot = [string]$bundle.machineRoot
    helperPath = [string]$bundle.helperPath
    wslFeatureState = [string]$wsl.wslFeatureState
    virtualMachinePlatformFeatureState = [string]$wsl.virtualMachinePlatformFeatureState
    wslPath = $wsl.wslPath
    wslVersion = $wsl.wslVersion
    wslVersionCommandSucceeded = [bool]$wsl.wslVersionCommandSucceeded
    wslDefaultVersion = $wsl.wslDefaultVersion
    rebootPending = [bool]$wsl.rebootPending
    wslVerified = $false
    recoveryTasksVerified = $false
    finalizerTaskVerified = $false
    finalizerNonce = $null
  }
  if ($facts.rebootPending) {
    Write-Host "Registering verified post-reboot recovery tasks..."
    $resume = Invoke-RegisterResume $Request
    $finalizer = Invoke-RegisterFinalize $Request
    $facts.recoveryTasksVerified = [bool]($resume.recoveryTasksVerified -and $finalizer.finalizerTaskVerified)
    $facts.finalizerTaskVerified = [bool]$finalizer.finalizerTaskVerified
    $facts.finalizerNonce = [string]$finalizer.finalizerNonce
  } else {
    $verified = Get-WslRuntimeFacts
    $facts.wslFeatureState = [string]$verified.wslFeatureState
    $facts.virtualMachinePlatformFeatureState = [string]$verified.virtualMachinePlatformFeatureState
    $facts.wslPath = $verified.wslPath
    $facts.wslVersion = $verified.wslVersion
    $facts.wslVersionCommandSucceeded = [bool]$verified.wslVersionCommandSucceeded
    $facts.wslDefaultVersion = $verified.wslDefaultVersion
    $facts.rebootPending = [bool]$verified.rebootPending
    $facts.wslVerified = [bool](
      $verified.wslFeatureState -eq "Enabled" -and
      $verified.virtualMachinePlatformFeatureState -eq "Enabled" -and
      $verified.wslPath -and
      $verified.wslVersionCommandSucceeded -and
      $verified.wslDefaultVersion -eq 2 -and
      -not $verified.rebootPending
    )
  }
  return $facts
}

function Invoke-ProvisionRainbond($Request) {
  Write-Host "[1/6] Importing the dedicated Rainbond WSL environment..."
  $imported = Invoke-ImportDistro $Request
  Write-Host "[2/6] Configuring fixed local networking..."
  $configured = Invoke-ConfigureNetwork $Request
  $network = Invoke-VerifyNetwork $Request
  Write-Host "[3/6] Preparing Docker inside the Rainbond environment..."
  $docker = Invoke-PrepareDocker $Request
  Write-Host "[4/6] Installing Rainbond (the first image pull can take some time)..."
  $installed = Invoke-InstallRainbond $Request
  Write-Host "[5/6] Verifying Rainbond inside WSL..."
  Write-Host "[6/6] Verifying Windows loopback access..."
  $verified = Invoke-VerifyDeployment $Request
  return [ordered]@{
    installationId = [string]$Request.installation_id
    distroIdentityVerified = [bool]$imported.distroIdentityVerified
    systemdReady = [bool]$imported.systemdReady
    networkGateReady = [bool]$docker.networkGateReady
    dockerReady = [bool]$docker.dockerReady
    rainbondRuntimeVerified = [bool]$installed.rainbondRuntimeVerified
    networkManifestVerified = [bool]($configured.networkManifestVerified -and $network.networkManifestVerified)
    portproxyVerified = [bool]$network.portproxyVerified
    containerRunning = [bool]$verified.containerRunning
    nodeReady = [bool]$verified.nodeReady
    componentsReady = [bool]$verified.componentsReady
    wslConsoleReachable = [bool]$verified.wslConsoleReachable
    windowsConsoleReachable = [bool]$verified.windowsConsoleReachable
    portsListening = $verified.portsListening
    subnet = [string]$network.subnet
    hostAddress = [string]$network.hostAddress
    guestAddress = [string]$verified.guestAddress
    windowsConsoleUrl = [string]$verified.windowsConsoleUrl
    controlConsoleUrl = [string]$verified.controlConsoleUrl
  }
}

if ([string]::IsNullOrWhiteSpace($RequestPath) -or [string]::IsNullOrWhiteSpace($ResultPath)) {
  throw "RequestPath and ResultPath are required for this action"
}
$requestInfo = Get-Item -LiteralPath $RequestPath
if ($requestInfo.PSIsContainer -or ($requestInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw "RequestPath must be a regular non-reparse file"
}
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$requiredRequestKeys = @("schema", "action", "operation_id", "installation_id", "nonce", "user_sid", "policy")
if ($Action -ne "Preflight") { $requiredRequestKeys += "payload" }
$actualRequestKeys = @($request.PSObject.Properties.Name)
if ($request.schema -ne "rainskills.windows-request.v1" -or $request.action -ne $Action) {
  throw "Request schema or action mismatch"
}
if (@($actualRequestKeys | Where-Object { $requiredRequestKeys -notcontains $_ }).Count -gt 0 -or
    @($requiredRequestKeys | Where-Object { $actualRequestKeys -notcontains $_ }).Count -gt 0) {
  throw "Request contains unsupported or missing fields"
}
if ($actualRequestKeys -contains "command" -or $actualRequestKeys -contains "script") {
  throw "Request may not contain command or script"
}
Assert-NoExecutableFields $request
$uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
if ([string]$request.operation_id -notmatch $uuidPattern -or
    [string]$request.installation_id -notmatch $uuidPattern -or
    [string]$request.nonce -notmatch "^[0-9a-f]{64}$") {
  throw "Request identifiers are invalid"
}
$requestFullPath = [IO.Path]::GetFullPath($RequestPath)
$resultFullPath = [IO.Path]::GetFullPath($ResultPath)
if ([IO.Path]::GetDirectoryName($requestFullPath) -ne [IO.Path]::GetDirectoryName($resultFullPath) -or
    [IO.Path]::GetFileName($requestFullPath) -ne "request-$($request.nonce).json" -or
    [IO.Path]::GetFileName($resultFullPath) -ne "result-$($request.nonce).json") {
  throw "RequestPath and ResultPath are outside the nonce-bound operation directory"
}
if (Test-Path -LiteralPath $ResultPath) {
  $resultInfo = Get-Item -LiteralPath $ResultPath
  if ($resultInfo.PSIsContainer -or ($resultInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "ResultPath must be a regular non-reparse file"
  }
}

$machineActions = @("PrepareWsl", "ProvisionRainbond", "InstallMachineBundle", "EnableWsl", "UpdateWsl", "VerifyWsl", "RegisterResume", "RegisterFinalize", "RequestReboot", "Finalize", "ImportDistro", "PrepareRuntime", "ConfigureNetwork", "VerifyNetwork", "PrepareDocker", "InstallRainbond", "VerifyDeployment")
if ($machineActions -contains $Action -and -not (Test-IsElevated)) {
  Invoke-ElevatedSelf
  exit 0
}
if ($machineActions -contains $Action -and
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne [string]$request.user_sid) {
  throw "Post-UAC SID does not match the original user"
}

$status = "ok"
switch ($Action) {
  "Preflight" { $facts = Invoke-Preflight $request }
  "PrepareWsl" { $facts = Invoke-PrepareWsl $request }
  "ProvisionRainbond" { $facts = Invoke-ProvisionRainbond $request }
  "InstallMachineBundle" { $facts = Invoke-InstallMachineBundle $request }
  "EnableWsl" { $facts = Invoke-EnableWsl $request }
  "UpdateWsl" { $facts = Invoke-UpdateWsl $request }
  "VerifyWsl" {
    $facts = Get-WslRuntimeFacts
    $facts["wslVerified"] = [bool](
      $facts.wslFeatureState -eq "Enabled" -and
      $facts.virtualMachinePlatformFeatureState -eq "Enabled" -and
      $facts.wslPath -and
      $facts.wslVersionCommandSucceeded -and
      $facts.wslDefaultVersion -eq 2 -and
      -not $facts.rebootPending
    )
    if (-not $facts.wslVerified) { $status = "blocked" }
  }
  "RegisterResume" { $facts = Invoke-RegisterResume $request }
  "RegisterFinalize" { $facts = Invoke-RegisterFinalize $request }
  "RequestReboot" { $facts = Invoke-RequestReboot $request }
  "Finalize" { $facts = Invoke-Finalize $request }
  "ImportDistro" { $facts = Invoke-ImportDistro $request }
  "PrepareRuntime" { $facts = Invoke-PrepareRuntime $request }
  "ConfigureNetwork" { $facts = Invoke-ConfigureNetwork $request }
  "VerifyNetwork" { $facts = Invoke-VerifyNetwork $request }
  "PrepareDocker" { $facts = Invoke-PrepareDocker $request }
  "InstallRainbond" { $facts = Invoke-InstallRainbond $request }
  "VerifyDeployment" { $facts = Invoke-VerifyDeployment $request }
  default { throw "Unsupported fixed action" }
}
Write-ActionResult $request $facts $status
if ($Action -eq "RequestReboot") { Restart-Computer -Force }
