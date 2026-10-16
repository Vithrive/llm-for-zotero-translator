# 把 addon/ 打包成 .xpi，并按 manifest.json 生成 update.json
#
# 用法（在插件根目录或任意位置均可）：
#   pwsh -File tools/build-xpi.ps1
#
# 规则：
#   - zip 条目取自 addon/ 的相对路径，manifest.json 必须落在压缩包根目录
#   - 条目名统一用正斜杠，时间戳固定为 1980-01-01，保证可复现
#   - update.json 的 update_link 指向 GitHub Release（tag: release）里的 xpi
[CmdletBinding()]
param(
  [string]$OutName
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$pluginDir = Split-Path -Parent $PSScriptRoot
$addonDir = Join-Path $pluginDir "addon"
$manifestPath = Join-Path $addonDir "manifest.json"

if (-not (Test-Path $manifestPath)) { throw "缺少 $manifestPath" }
if (-not $OutName) { $OutName = Split-Path -Leaf $pluginDir }

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$version = $manifest.version
$addonId = $manifest.applications.zotero.id
$homepage = $manifest.homepage_url

$outFile = Join-Path $pluginDir "$OutName.xpi"
$updateFile = Join-Path $pluginDir "update.json"
if (Test-Path $outFile) { Remove-Item $outFile -Force }

$fixedTime = [datetime]::new(1980, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$zip = [System.IO.Compression.ZipFile]::Open($outFile, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $addonDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($addonDir.Length + 1).Replace("\", "/")
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTime
    $out = $entry.Open()
    try {
      $in = [System.IO.File]::OpenRead($_.FullName)
      try { $in.CopyTo($out) } finally { $in.Dispose() }
    } finally { $out.Dispose() }
  }
} finally {
  $zip.Dispose()
}

# update.json：Zotero 7 的更新清单格式
$updateLink = "$homepage/releases/download/release/$OutName.xpi"
$updateJson = [ordered]@{
  addons = [ordered]@{
    $addonId = [ordered]@{
      updates = @([ordered]@{ version = $version; update_link = $updateLink })
    }
  }
}
$updateJson | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $updateFile -Encoding utf8NoBOM

Write-Output "已生成: $outFile"
Write-Output "已生成: $updateFile  (id=$addonId, version=$version)"
