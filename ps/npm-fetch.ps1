# Dedicated npm registry downloader. Does not alter the Whale Bone API or PyPI transport.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
$source=$null;$target=$null
try {
    $req=([Console]::In.ReadLine() | ConvertFrom-Json)
    $url=[Uri]$req.url
    if ($url.Scheme -ne 'https' -or $url.Port -ne 443 -or $url.UserInfo -or $url.Host.ToLowerInvariant() -ne 'registry.npmjs.org') {throw 'Unapproved npm registry endpoint'}
    if (-not [IO.Path]::IsPathRooted([string]$req.destination)) {throw 'Invalid npm download destination'}
    $request=[Net.HttpWebRequest]::Create($url)
    $request.Method='GET';$request.AllowAutoRedirect=$false
    $request.UserAgent=[string]$req.userAgent
    $request.Accept='application/vnd.npm.install-v1+json, application/json'
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
        if ([int]$response.StatusCode -ne 200) {throw ('Upstream HTTP '+[int]$response.StatusCode)}
        if ($response.ContentLength -gt [long]$req.maximumBytes) {throw 'npm response exceeds size limit'}
        $source=$response.GetResponseStream();$target=[IO.File]::Create([string]$req.destination)
        $buffer=New-Object byte[] 65536;$total=[long]0
        while (($count=$source.Read($buffer,0,$buffer.Length)) -gt 0) {
            $total+=$count;if($total -gt [long]$req.maximumBytes){throw 'npm response exceeds size limit'}
            $target.Write($buffer,0,$count)
        }
    } finally {
        if($source){$source.Dispose()};if($target){$target.Dispose()};$response.Dispose()
    }
    exit 0
} catch {
    if($target){$target.Dispose()};if($source){$source.Dispose()}
    [Console]::Error.WriteLine(('npm registry fetch error: '+$_.Exception.Message))
    exit 1
}
