param(
    [Parameter(Mandatory = $true)]
    [string]$Url
)

$uri = $null
if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    throw "The browser URL is not an absolute URI."
}
if ($uri.Scheme -notin @("http", "https")) {
    throw "The browser URL must use HTTP or HTTPS."
}
if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
    throw "The browser URL must not contain credentials."
}
$controlCharacters = [char[]](@(0..31) + @(127))
if ($Url.IndexOfAny($controlCharacters) -ge 0) {
    throw "The browser URL contains control characters."
}

Start-Process -FilePath $uri.AbsoluteUri
