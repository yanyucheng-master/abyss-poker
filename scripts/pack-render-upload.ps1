# Pack render-upload folder and zip (no node_modules / coverage)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/pack-render-upload.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$OutDir = Join-Path $Root "render-upload"
$ZipName = "abyss-poker-render-upload.zip"
$ZipPath = Join-Path $Root $ZipName
$DesktopZip = Join-Path ([Environment]::GetFolderPath("Desktop")) $ZipName

$includeDirs = @("game", "public", "server", "socket", "utils", "docs", "tests", "scripts")
$includeFiles = @(
    "package.json",
    "package-lock.json",
    "server.js",
    "render.yaml",
    "jest.config.cjs",
    "README.md",
    "部署指南.txt",
    "push-github.ps1",
    ".gitignore"
)

if (Test-Path $OutDir) {
    Remove-Item $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir | Out-Null

foreach ($dir in $includeDirs) {
    $src = Join-Path $Root $dir
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $OutDir $dir) -Recurse -Force
    }
}

foreach ($file in $includeFiles) {
    $src = Join-Path $Root $file
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $OutDir $file) -Force
    }
}

$uploadReadme = Join-Path $OutDir "上传说明.txt"
$lines = @(
    "========================================",
    "  Render deploy bundle - Abyss Poker",
    "========================================",
    "",
    "Clean source without node_modules.",
    "",
    "Option A (recommended): GitHub + Render",
    "  1. Push this folder to GitHub repo abyss-poker",
    "  2. Render -> New Web Service -> connect repo",
    "  3. Build Command : npm install",
    "  4. Start Command  : npm start",
    "  5. Root Directory : (empty)",
    "",
    "Option B: use push-github.ps1 in project root",
    "",
    "After deploy, open https://YOUR-SERVICE.onrender.com",
    "Player A creates room, Player B joins with same URL + room code.",
    "",
    "See 部署指南.txt for full Chinese guide.",
    ""
)
Set-Content -Path $uploadReadme -Value $lines -Encoding UTF8

foreach ($zip in @($ZipPath, $DesktopZip)) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $OutDir "*") -DestinationPath $zip -Force
}

Write-Host ">> render-upload: $OutDir"
Write-Host ">> zip project : $ZipPath"
Write-Host ">> zip desktop : $DesktopZip"
