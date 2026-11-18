# Restart HidForge outside the caller's process container.
# Started from a terminal inside the Claude desktop app (an MSIX package), a plain Start-Process child runs inside that
# package: Windows kills it whenever it services the app (an update attempt) or the app closes, and its log is redirected
# to the package's LocalCache. Win32_Process.Create starts it from the WMI service instead, as an ordinary user process.
# Usage: powershell -NoProfile -File scripts\restart.ps1 [-Port 4317]
param([int]$Port = 4317)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  if ($p) {
    # the watchdog (scripts\supervise.ts) would start the server again: stop it first
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
    if ($parent -and $parent.CommandLine -match 'supervise\.ts') { Stop-Process -Id $parent.ProcessId -Force }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue # may already be gone with the watchdog
  }
}
Start-Sleep -Seconds 2
$vbs = Join-Path $root 'scripts\HidForge.vbs'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "wscript.exe `"$vbs`""; CurrentDirectory = $root }
if ($r.ReturnValue -ne 0) { throw "could not start HidForge (Win32_Process.Create returned $($r.ReturnValue))" }
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try { $null = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2; "HidForge is running at http://127.0.0.1:$Port"; exit 0 } catch { }
}
throw "HidForge did not answer on port $Port within 30 s"
