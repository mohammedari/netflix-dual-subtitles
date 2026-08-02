$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $projectRoot "release"
$stagingRoot = Join-Path $releaseRoot "netflix-dual-subtitles"
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json
$zipPath = Join-Path $releaseRoot "netflix-dual-subtitles-v$($manifest.version).zip"
$resolvedProject = [IO.Path]::GetFullPath($projectRoot)
$resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
if (-not $resolvedStaging.StartsWith($resolvedProject, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package outside the project directory."
}

if (Test-Path $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "manifest.json") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "MANUAL_TESTS.md") -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $projectRoot "src") -Destination $stagingRoot -Recurse
Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Created: $zipPath"
