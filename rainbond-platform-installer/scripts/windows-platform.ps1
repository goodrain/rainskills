[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$RequestPath,

  [Parameter(Mandatory = $true)]
  [string]$ResultPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

$requestInfo = Get-Item -LiteralPath $RequestPath
if ($requestInfo.PSIsContainer -or ($requestInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw "RequestPath must be a regular non-reparse file"
}
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$requiredRequestKeys = @("schema", "action", "operation_id", "installation_id", "nonce", "user_sid", "policy")
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

$facts = Invoke-Preflight $request
$result = [ordered]@{
  schema = "rainskills.windows-result.v1"
  action = $Action
  operation_id = $request.operation_id
  installation_id = $request.installation_id
  nonce = $request.nonce
  status = "ok"
  facts = $facts
}
$json = $result | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($ResultPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
