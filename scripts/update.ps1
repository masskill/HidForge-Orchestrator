<#
.SYNOPSIS
  Оновлення HidForge Orchestrator з origin (лише fast-forward, локальні зміни не перезаписуються).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Check
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update.ps1
#>
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
function Fail([string]$msg) { Write-Host "ПОМИЛКА: $msg" -ForegroundColor Red; exit 1 }
Set-Location -LiteralPath $Root
if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { Fail 'Це не git-копія: оновіть вручну, завантаживши нову версію.' }

$before = (& git rev-parse --short HEAD).Trim()
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
& git fetch --quiet origin $branch
if ($LASTEXITCODE -ne 0) { Fail 'git fetch не вдався (немає мережі або доступу до origin). Нічого не змінено.' }
$behind = [int](& git rev-list --count "HEAD..origin/$branch")
if ($behind -eq 0) { Write-Host "Оновлень немає (версія $before)."; exit 0 }
Write-Host "Доступно нових комітів: $behind"
& git log --oneline "HEAD..origin/$branch" | Select-Object -First 20
if ($Check) { exit 0 }

if (& git status --porcelain --untracked-files=no) { Fail 'Є локальні зміни у відстежуваних файлах. Закомітьте або збережіть їх окремо — оновлення їх не перезапише.' }
& git merge --ff-only --quiet "origin/$branch"
if ($LASTEXITCODE -ne 0) { Fail 'Оновлення лише fast-forward неможливе: локальна гілка розійшлася з origin. Нічого не змінено.' }
if (Test-Path -LiteralPath (Join-Path $Root 'node_modules')) { & npm install --no-audit --no-fund }
Write-Host "Оновлено: $before -> $((& git rev-parse --short HEAD).Trim()). Перезапустіть HidForge: Налаштування -> Зупинити сервер, потім ярлик."
