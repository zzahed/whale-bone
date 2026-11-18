# Whale Bone offline release integrity checker. Read-only; no administrator rights.
# Run from the extracted installer folder: powershell -NoProfile -File .\verify-integrity.ps1
[CmdletBinding()]
param([string]$ReleaseFolder = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ReleaseFolder)
$manifests = @(Get-ChildItem -LiteralPath $root -Filter 'WhaleBone-*-PAYLOAD-SHA256SUMS.txt' -File)
if ($manifests.Count -ne 1) { throw 'Expected exactly one release payload checksum manifest.' }
$manifest = $manifests[0].FullName
$failed = @()
$checked = 0
foreach ($entry in (Get-Content -LiteralPath $manifest)) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    if ($entry -notmatch '^([0-9a-fA-F]{64})\s{2}([a-zA-Z0-9_.-]+)$') { throw "Invalid checksum entry: $entry" }
    $expected = $Matches[1].ToLowerInvariant()
    $name = $Matches[2]
    $target = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $failed += "$name missing"; continue }
    $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { $failed += "$name SHA-256 mismatch" } else { Write-Host "PASS $name" }
    $checked++
}
if ($failed.Count) { throw ("Integrity failure: " + ($failed -join '; ')) }
Write-Host "Verified $checked files. SHA-256 verifies content only, not publisher identity."
