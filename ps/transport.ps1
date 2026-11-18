# This code is invoked via powershell.exe -NoProfile -NonInteractive -EncodedCommand.
# JSON request (including secret) is received only from stdin, not the process command line.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Empty transport request.' }
    $request = ConvertFrom-Json -InputObject $raw

    $uri = [Uri]([string]$request.url)
    if ($uri.Scheme -ne 'https') { throw 'API endpoint must use HTTPS.' }
    if ($uri.UserInfo) { throw 'Credentials in endpoint URLs are prohibited.' }
    $key = [string]$request.apiKey
    if ([string]::IsNullOrWhiteSpace($key)) { throw 'API key is missing.' }
    $headers = @{'Accept'='application/json'}
    if ($request.authMode -eq 'bearer') {
        $headers['Authorization'] = 'Bearer ' + $key
    } else {
        $headers['x-api-key'] = $key
    }
    $params = @{
        Uri = $uri.AbsoluteUri
        Method = [string]$request.method
        Headers = $headers
        TimeoutSec = [int]$request.timeoutSeconds
        UseBasicParsing = $true
        ErrorAction = 'Stop'
        UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    }
    # Default is the exact User-Agent of the previously verified v0.1 transport.
    if ($request.userAgent) {
        $agent = [string]$request.userAgent
        if ($agent.Length -gt 300 -or $agent -match '[\r\n]') { throw 'Invalid User-Agent.' }
        $params['UserAgent'] = $agent
    }
    if ($request.method -eq 'POST') {
        $params['ContentType'] = 'application/json; charset=utf-8'
        $params['Body'] = [Text.Encoding]::UTF8.GetBytes([string]$request.body)
    }

    # Proxy options: proxyEnabled (default on), proxyUrl (empty = Windows system proxy),
    # proxyAuth: computer (Windows-integrated), user (explicit credentials) or none.
    $proxyEnabled = ($null -eq $request.proxyEnabled) -or [bool]$request.proxyEnabled
    $proxyAuth = [string]$request.proxyAuth
    if ([string]::IsNullOrWhiteSpace($proxyAuth)) { $proxyAuth = 'computer' }
    if (@('computer','user','none') -notcontains $proxyAuth) { throw 'Invalid proxy authentication mode.' }
    if (-not $proxyEnabled) {
        # Direct connection: also bypass the Windows system proxy for this process only.
        [System.Net.WebRequest]::DefaultWebProxy = $null
    } else {
        $proxyText = [string]$request.proxyUrl
        if ([string]::IsNullOrWhiteSpace($proxyText)) {
            $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy()
            if ($null -ne $systemProxy -and -not $systemProxy.IsBypassed($uri)) {
                $found = $systemProxy.GetProxy($uri)
                if ($null -ne $found -and $found.AbsoluteUri -ne $uri.AbsoluteUri) {
                    $proxyText = $found.AbsoluteUri
                }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($proxyText)) {
            $proxyUri = [Uri]$proxyText
            if ($proxyUri.Scheme -ne 'http' -and $proxyUri.Scheme -ne 'https') {
                throw 'Proxy URL must use HTTP or HTTPS.'
            }
            if ($proxyUri.UserInfo) { throw 'Do not put credentials in the proxy URL.' }
            $params['Proxy'] = $proxyUri.AbsoluteUri
            if ($proxyAuth -eq 'computer') {
                $params['ProxyUseDefaultCredentials'] = $true
            } elseif ($proxyAuth -eq 'user') {
                $proxyUser = [string]$request.proxyUsername
                $proxyPassword = [string]$request.proxyPassword
                if ([string]::IsNullOrWhiteSpace($proxyUser) -or [string]::IsNullOrEmpty($proxyPassword)) { throw 'Proxy username and password are required.' }
                $securePassword = ConvertTo-SecureString -String $proxyPassword -AsPlainText -Force
                $params['ProxyCredential'] = New-Object System.Management.Automation.PSCredential -ArgumentList $proxyUser, $securePassword
            }
        }
    }

    # Do not disable Schannel trust validation. Corporate CA must be trusted by Windows.
    $response = Invoke-WebRequest @params
    $output = @{ ok=$true; status=[int]$response.StatusCode; body=[string]$response.Content; proxyUsed=([bool]$params.ContainsKey('Proxy')) }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $output -Compress -Depth 6))
} catch {
    $status = 0
    try {
        if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    } catch {}
    $msg = [string]$_.Exception.Message
    # Never return request bodies, HTTP request headers, or secrets in diagnostics.
    $output = @{ ok=$false; status=$status; error=$msg }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $output -Compress -Depth 5))
}
