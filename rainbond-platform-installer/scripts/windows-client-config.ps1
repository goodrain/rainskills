$token = $env:RAINSKILLS_RAINBOND_JWT
$baseUrl = $env:RAINSKILLS_RAINBOND_URL

if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($baseUrl)) {
    throw "Rainbond environment values were not provided."
}

[Environment]::SetEnvironmentVariable("RAINBOND_JWT", $token, "User")
[Environment]::SetEnvironmentVariable("RAINBOND_URL", $baseUrl, "User")
