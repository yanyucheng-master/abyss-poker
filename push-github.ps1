# 深渊德州 — 推送到 GitHub abyss-poker
# 用法: powershell -ExecutionPolicy Bypass -File push-github.ps1

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Repo = "https://github.com/yanyucheng-master/abyss-poker.git"

Push-Location $Root
try {
    if (-not (Test-Path ".git")) {
        git init -b master
        git remote add origin $Repo
    }
    git add -A
    $status = git status --porcelain
    if (-not $status) {
        Write-Host ">> 无变更，跳过提交"
    } else {
        git commit -m "chore: sync abyss-poker deploy package"
    }
    Write-Host ">> 推送到 GitHub ..."
    git pull origin master --rebase 2>$null
    git push -u origin master
    Write-Host ">> 完成: $Repo"
    Write-Host ">> Render 绑定该仓库后会自动部署"
} finally {
    Pop-Location
}
