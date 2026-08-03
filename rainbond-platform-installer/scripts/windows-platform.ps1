[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "InspectState", "ProtectState", "InstallMachineBundle", "EnableWsl", "UpdateWsl", "VerifyWsl", "RegisterResume", "RegisterFinalize", "RequestReboot", "Finalize")]
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
  if (-not (Test-Path -LiteralPath $recoveryRoot -PathType Container) -or
      -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $recoveryEntry -PathType Leaf)) {
    throw "Recovery bundle or Node runtime is missing"
  }
  [void](Assert-FileDigest $sourceHelper $expectedHelperDigest)
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
  [void](Assert-FileDigest $machineHelper $expectedHelperDigest)
  $manifest = [ordered]@{
    schema = "rainskills.windows-machine-bundle.v1"
    operation_id = $Request.operation_id
    installation_id = $Request.installation_id
    original_user_sid = $Request.user_sid
    helper_sha256 = $expectedHelperDigest
    recovery_root = $recoveryRoot
    recovery_manifest_sha256 = $recoveryManifestDigest
    recovery_entry = $recoveryEntry
    node_path = $nodePath
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
      & $wslPath --update --web-download
      if ($LASTEXITCODE -ne 0) { Install-LegacyWslKernel $Request }
    }
  } else {
    throw "wsl.exe is unavailable after enabling Windows features; reboot and resume are required"
  }
  & $wslPath --set-default-version 2
  if ($LASTEXITCODE -ne 0) { throw "Failed to set WSL default version 2" }
  return Get-WslRuntimeFacts
}

function Invoke-UpdateWsl($Request) {
  $wslPath = Get-TrustedWslPath
  if (-not $wslPath) { throw "wsl.exe is not installed" }
  & $wslPath --update --web-download
  if ($LASTEXITCODE -ne 0) { Install-LegacyWslKernel $Request }
  return Get-WslRuntimeFacts
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

  $userArguments = '"' + $manifest.recovery_entry + '" platform install --onboarding-id ' +
    $Request.operation_id + ' --target local-windows --yes'
  $userAction = New-ScheduledTaskAction -Execute $manifest.node_path -Argument $userArguments
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

$machineActions = @("InstallMachineBundle", "EnableWsl", "UpdateWsl", "VerifyWsl", "RegisterResume", "RegisterFinalize", "RequestReboot", "Finalize")
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
  default { throw "Unsupported fixed action" }
}
Write-ActionResult $request $facts $status
if ($Action -eq "RequestReboot") { Restart-Computer -Force }
