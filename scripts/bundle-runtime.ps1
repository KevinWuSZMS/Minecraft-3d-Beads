param([string]$Version = 'v24.22.1')
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Invalid Node.js version' }
$runtimeDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runtime'))
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$baseUrl = "https://nodejs.org/dist/$Version"
$checksumText = (Invoke-WebRequest "$baseUrl/SHASUMS256.txt").Content
if ($checksumText -is [byte[]]) { $checksumText = [Text.Encoding]::UTF8.GetString($checksumText) }
[IO.File]::WriteAllText((Join-Path $runtimeDirectory 'SHASUMS256.txt'), [string]$checksumText)
[IO.File]::WriteAllText((Join-Path $runtimeDirectory 'node-version.txt'), "$Version`n")
$archives = [ordered]@{}
foreach ($platform in @('win-x64', 'darwin-arm64', 'darwin-x64')) {
    $extension = if ($platform -eq 'win-x64') { 'zip' } else { 'tar.gz' }
    $directory = "node-$Version-$platform"
    $filename = "$directory.$extension"
    $expected = ([regex]::Match($checksumText, "(?m)^([a-f0-9]{64})\s+" + [regex]::Escape($filename) + "\s*$")).Groups[1].Value
    if (!$expected) { throw "Official checksum missing: $filename" }
    $archivePath = Join-Path $runtimeDirectory $filename
    if (!(Test-Path -LiteralPath $archivePath)) {
        Write-Host "Downloading official runtime: $filename"
        Invoke-WebRequest "$baseUrl/$filename" -OutFile $archivePath -TimeoutSec 180
    }
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA256 mismatch: $filename" }
    $archives[$platform] = [ordered]@{ file=$filename; directory=$directory; sha256=$actual; bytes=(Get-Item -LiteralPath $archivePath).Length; source="$baseUrl/$filename" }
    Write-Host "Verified $filename"
}
$manifest = [ordered]@{ schemaVersion=1; nodeVersion=$Version; checksumSource="$baseUrl/SHASUMS256.txt"; archives=$archives }
[IO.File]::WriteAllText((Join-Path $runtimeDirectory 'manifest.json'), (($manifest | ConvertTo-Json -Depth 8) + "`n"))
