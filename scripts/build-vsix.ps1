# Offline VSIX builder for the matching Whale Bone source bundle.
# Windows PowerShell 5.1; no administrator rights or external package manager required.
[CmdletBinding()]
param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$packagePath = Join-Path $sourceRoot 'extension\package.json'
if (-not (Test-Path -LiteralPath $packagePath)) { throw 'Source root must contain extension\package.json' }
$manifest = Join-Path $sourceRoot 'extension.vsixmanifest'
$types = Join-Path $sourceRoot '[Content_Types].xml'
if (-not (Test-Path -LiteralPath $manifest) -or -not (Test-Path -LiteralPath $types)) { throw 'Source bundle is missing a VSIX manifest' }
$version = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
[xml]$manifestXml = Get-Content -LiteralPath $manifest -Raw
$identity = $manifestXml.SelectSingleNode('//*[local-name()="Identity"]')
if (-not $identity -or $identity.GetAttribute('Version') -ne $version) { throw 'VSIX manifest version must match extension/package.json before packaging' }
if (-not $OutputPath) { $OutputPath = Join-Path (Split-Path $sourceRoot -Parent) ('whale-bone-' + $version + '.vsix') }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ($OutputPath.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Build output must be outside the source tree' }
if (Test-Path -LiteralPath $OutputPath) { throw 'Output already exists; remove it explicitly before rebuilding' }
$staging = Join-Path ([IO.Path]::GetTempPath()) ('whalebone-vsix-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $staging | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'extension') -Destination (Join-Path $staging 'extension') -Recurse
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $staging 'extension.vsixmanifest')
    Copy-Item -LiteralPath $types -Destination (Join-Path $staging '[Content_Types].xml')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($staging,$OutputPath,[IO.Compression.CompressionLevel]::Optimal,$false)
    Write-Host ('Built ' + $OutputPath)
    Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256 | Format-List
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
