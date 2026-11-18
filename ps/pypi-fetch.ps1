# Whale Bone Python package relay. Separate from the existing API transport.
# Reads a single JSON request on stdin, fetches public PyPI content through the configured proxy
# (Windows-integrated or explicit credentials), writes raw bytes to a temporary file and fails closed on HTTP redirects.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$source=$null
$target=$null
try {
    $req=([Console]::In.ReadLine() | ConvertFrom-Json)
    $url=[Uri]$req.url
    if ($url.Scheme -ne 'https' -or $url.Port -ne 443 -or $url.UserInfo -or @('pypi.org','files.pythonhosted.org') -notcontains $url.Host.ToLowerInvariant()) { throw 'Unapproved package host' }
    if (-not [IO.Path]::IsPathRooted([string]$req.destination)) { throw 'Invalid download destination' }
    $request=[Net.HttpWebRequest]::Create($url)
    $request.Method='GET'
    $request.AllowAutoRedirect=$false
    $request.UserAgent=[string]$req.userAgent
    $request.Timeout=[Math]::Max(5000,[Math]::Min(180000,([int]$req.timeoutSeconds)*1000))
    $request.ReadWriteTimeout=$request.Timeout
    # Proxy options mirror the API transport: enabled flag, URL (empty = system proxy), auth computer|user|none.
    $proxyEnabled=($null -eq $req.proxyEnabled) -or [bool]$req.proxyEnabled
    $proxyAuth=[string]$req.proxyAuth;if([string]::IsNullOrWhiteSpace($proxyAuth)){$proxyAuth='computer'}
    if (@('computer','user','none') -notcontains $proxyAuth) {throw 'Invalid proxy authentication mode'}
    if (-not $proxyEnabled) {
        $request.Proxy=$null
    } else {
        if ($req.proxyUrl) {$proxy=New-Object System.Net.WebProxy -ArgumentList ([string]$req.proxyUrl)} else {$proxy=[Net.WebRequest]::GetSystemWebProxy()}
        if ($proxyAuth -eq 'computer') {
            $proxy.Credentials=[Net.CredentialCache]::DefaultNetworkCredentials
        } elseif ($proxyAuth -eq 'user') {
            $proxyUser=[string]$req.proxyUsername;$proxyDomain=''
            if ([string]::IsNullOrWhiteSpace($proxyUser) -or [string]::IsNullOrEmpty([string]$req.proxyPassword)) {throw 'Proxy username and password are required'}
            if ($proxyUser.Contains('\')) {$parts=$proxyUser.Split([char[]]@('\'),2);$proxyDomain=$parts[0];$proxyUser=$parts[1]}
            $proxy.Credentials=New-Object System.Net.NetworkCredential -ArgumentList $proxyUser,([string]$req.proxyPassword),$proxyDomain
        }
        $request.Proxy=$proxy
    }
    $response=$request.GetResponse()
    try {
        $status=[int]$response.StatusCode
        if ($status -ne 200) { throw ('Upstream HTTP '+$status) }
        if ($response.ContentLength -gt [long]$req.maximumBytes) { throw 'Package download exceeds allowed size' }
        $source=$response.GetResponseStream()
        $target=[IO.File]::Create([string]$req.destination)
        $buffer=New-Object byte[] 65536
        $total=[long]0
        while (($n=$source.Read($buffer,0,$buffer.Length)) -gt 0) {
            $total += $n
            if ($total -gt [long]$req.maximumBytes) { throw 'Package download exceeds allowed size' }
            $target.Write($buffer,0,$n)
        }
    } finally {
        if ($source) { $source.Dispose() }
        if ($target) { $target.Dispose() }
        $response.Dispose()
    }
    exit 0
} catch {
    if ($target) { $target.Dispose() }
    if ($source) { $source.Dispose() }
    [Console]::Error.WriteLine(('PyPI download error: '+$_.Exception.Message))
    exit 1
}
