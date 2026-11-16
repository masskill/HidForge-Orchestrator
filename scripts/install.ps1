<#
.SYNOPSIS
  Встановлення HidForge Orchestrator для поточного користувача (без прав адміністратора).
.DESCRIPTION
  Перевіряє Node.js 24+ і Git (нічого не встановлює сам) і створює ярлики «HidForge Orchestrator»
  на робочому столі та в меню «Пуск». Ярлик запускає scripts\HidForge.vbs: сервер без вікна термінала + браузер.
  Залежності для роботи не потрібні (Node 24 виконує TypeScript напряму). Дані: %LOCALAPPDATA%\HidForge.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
#>
param(
  [string]$ShortcutDir,   # куди класти ярлик; за замовчуванням — робочий стіл і меню «Пуск»
  [switch]$NoShortcuts,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'HidForge.vbs'
$Name = 'HidForge Orchestrator.lnk'
function Fail([string]$msg) { Write-Host "ПОМИЛКА: $msg" -ForegroundColor Red; exit 1 }

if ($ShortcutDir) { $dirs = @($ShortcutDir) }
else { $dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }

if ($Uninstall) {
  foreach ($d in $dirs) {
    $l = Join-Path $d $Name
    if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l; Write-Host "Видалено ярлик: $l" }
  }
  Write-Host 'Дані (проєкти, історія, резервні копії) залишено: %LOCALAPPDATA%\HidForge'
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js не знайдено. Встановіть Node.js 24+ з https://nodejs.org і запустіть скрипт знову.' }
$nv = (& node -p 'process.versions.node').Trim()
if ([int]($nv.Split('.')[0]) -lt 24) { Fail "Потрібен Node.js 24+, знайдено $nv." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git не знайдено. Встановіть Git for Windows: https://git-scm.com' }
Write-Host "Node.js $nv; $((& git --version).Trim())"

if (-not $NoShortcuts) {
  $sh = New-Object -ComObject WScript.Shell
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
    $path = Join-Path $d $Name
    $l = $sh.CreateShortcut($path)
    $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $l.Arguments = '"' + $Launcher + '"'
    $l.WorkingDirectory = $Root
    $l.Description = 'HidForge Orchestrator: локальний оркестратор AI-агентів'
    $l.Save()
    Write-Host "Ярлик: $path"
  }
}
Write-Host 'Готово. Запуск: ярлик «HidForge Orchestrator» (без вікна термінала). Зупинка: Налаштування -> Зупинити сервер.'
