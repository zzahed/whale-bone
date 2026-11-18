'use strict';
/**
 * Offline, deterministic API connector scaffolds. This module NEVER sends requests.
 * Scripts are user-reviewed workspace proposals, not a new transport for Whale Bone.
 */
function cleanName(value){
 const name=String(value??'').trim();
 if(!/^[A-Za-z][A-Za-z0-9 _-]{0,45}$/.test(name)||/^(?:a|an|any|external|unknown|provider)(?:\s|$)/i.test(name))throw Error('Enter a specific API provider name using letters, numbers, spaces, hyphens, or underscores (1–46 characters)');
 return name;
}
function slug(name){return cleanName(name).toLowerCase().replace(/[ _-]+/g,'_').replace(/^_+|_+$/g,'');}
function psQuote(value){const s=String(value??'');if(/[\r\n\0]/.test(s)||s.length>800)throw Error('Unsafe PowerShell configuration');return "'"+s.replace(/'/g,"''")+"'";}
function isBrave(name){return /^brave(?: search)?$/i.test(cleanName(name));}
// Only an explicit composer command can select the local connector path.
// Ordinary requests, including 'connect to Brave API', always reach the configured model API.
function parseConnectorCommand(text){
 const matched=String(text||'').trim().match(/^\/connector\s+([A-Za-z][A-Za-z0-9 _-]{0,45})$/i);
 if(!matched || /\b(?:and|fix|write|using|with|in|plus)\b/i.test(matched[1]))return null;
 try{return {provider:cleanName(matched[1])};}catch{return null;}
}
function makeConnector(provider,settings={}){
 const name=cleanName(provider);
 const short=slug(name);
 const proxyEnabled=settings.proxyEnabled!==false,proxy=proxyEnabled?String(settings.proxyUrl||''):'';
 const proxyAuth=['computer','user','none'].includes(settings.proxyAuth)?settings.proxyAuth:'computer';
 if(proxy&&!/^https?:\/\/[\w.-]+(?::\d{1,5})?\/?$/.test(proxy))throw Error('Invalid proxy setting for generated script');
 const userAgent=String(settings.userAgent||'Whale-Bone-VSCode/0.9.4');
 const proxyParam=psQuote(proxy),userAgentParam=psQuote(userAgent);
 // Proxy lines: none when disabled; system proxy when no URL; credentials prompted at run time, never embedded.
 const proxyLines=!proxyEnabled?'# Proxy disabled in Whale Bone settings: direct connection.\n[System.Net.WebRequest]::DefaultWebProxy = $null\n'
  :!proxy?'# No proxy URL configured: Invoke-WebRequest uses the Windows system proxy.\n'
  :'$request[\'Proxy\'] = '+proxyParam+'\n'+(proxyAuth==='computer'?'$request[\'ProxyUseDefaultCredentials\'] = $true\n':proxyAuth==='user'?'$request[\'ProxyCredential\'] = Get-Credential -UserName '+psQuote(settings.proxyUsername||'')+' -Message \'Proxy credentials\'\n':'');
 const verified=isBrave(name);
 const keyVariable=verified?'BRAVE_API_KEY':short.toUpperCase()+'_API_KEY';
 const authHeader=verified?'X-Subscription-Token':'REVIEW_AUTH_HEADER';
 const baseUrl=verified?'https://api.search.brave.com/res/v1/web/search':'REPLACE_WITH_VERIFIED_PROVIDER_ENDPOINT';
 const comments=verified
  ? `# Verified Brave Search Web Search endpoint and X-Subscription-Token header.\n# Documentation: https://api-dashboard.search.brave.com/api-reference/web/search/get\n# Set BRAVE_API_KEY using an approved secret store or masked prompt (Read-Host -AsSecureString).\n# Do not save credentials in this file or commit them to source control.`
  : `# UNVERIFIED TEMPLATE for ${name}. Review the provider's official API documentation.\n# Set the real HTTPS endpoint, supported request method, query parameters, and authentication header.\n# This is NOT a working provider integration until you verify these values.\n# Set ${keyVariable} using an approved secret store or masked prompt (Read-Host -AsSecureString).\n# Do not save credentials in this file or commit them to source control.`;
 const tokenCheck=verified?'':`if ($AuthHeader -eq 'REVIEW_AUTH_HEADER') { throw 'Replace REVIEW_AUTH_HEADER with the official provider authentication header.' }\n`;
 const script=`#requires -version 5.1\n${comments}\n# Uses the same proxy settings as Whale Bone (enabled flag, address, computer or user authentication).\n# Run manually, after provider access is approved by corporate IT.\nparam(\n    [string]$Query = 'hello world',\n    [string]$Endpoint = ${psQuote(baseUrl)},\n    [string]$AuthHeader = ${psQuote(authHeader)}\n)\n$ErrorActionPreference = 'Stop'\n$apiKey = [Environment]::GetEnvironmentVariable(${psQuote(keyVariable)}, 'Process')\nif ([string]::IsNullOrWhiteSpace($apiKey)) { throw '${keyVariable} environment variable is missing. Set it for this PowerShell session first.' }\nif ($Endpoint -eq 'REPLACE_WITH_VERIFIED_PROVIDER_ENDPOINT') { throw 'Set Endpoint from the official provider documentation before running.' }\n${tokenCheck}$uri = [Uri]$Endpoint\nif ($uri.Scheme -ne 'https') { throw 'API endpoints must use HTTPS.' }\n# Check the provider documentation if it uses POST, a different parameter, or OAuth.\n$separator = if ($Endpoint.Contains('?')) { '&' } else { '?' }\n$requestUrl = $Endpoint + $separator + 'q=' + [Uri]::EscapeDataString($Query)\n$headers = @{ Accept = 'application/json' }\n$headers[$AuthHeader] = $apiKey\n$request = @{\n    Uri = $requestUrl\n    Method = 'GET'\n    Headers = $headers\n    UserAgent = ${userAgentParam}\n    TimeoutSec = 180\n    UseBasicParsing = $true\n}\n${proxyLines}# Do not log $request or $headers. They contain the API key.\n$response = Invoke-WebRequest @request\n$response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 12\n`;
 return {provider:name,filename:`tools/connect_${short}_api.ps1`,script,verified,keyVariable,authHeader,baseUrl,documentation:verified?'https://api-dashboard.search.brave.com/api-reference/web/search/get':null};
}
module.exports={parseConnectorCommand,makeConnector,cleanName};
