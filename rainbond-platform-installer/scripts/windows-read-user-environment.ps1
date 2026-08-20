$ErrorActionPreference = "Stop"

$outputPath = $env:RAINSKILLS_CREDENTIAL_OUTPUT_PATH
if ([string]::IsNullOrWhiteSpace($outputPath)) {
  throw "Credential output path was not provided."
}

$token = [Environment]::GetEnvironmentVariable("RAINBOND_JWT", "User")
$origin = [Environment]::GetEnvironmentVariable("RAINBOND_URL", "User")
if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($origin)) {
  throw "Rainbond user environment is incomplete."
}

$payload = @{ token = $token; origin = $origin } | ConvertTo-Json -Compress
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($outputPath, $payload, $utf8WithoutBom)
