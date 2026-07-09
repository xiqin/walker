$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'adapter.pid'
$ScriptPath = Join-Path $ProjectRoot 'src\index.js'

function Get-BridgeProcess($PidValue) {
  if (-not $PidValue) {
    return $null
  }
  $ProcessInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction SilentlyContinue
  if ($ProcessInfo -and $ProcessInfo.CommandLine -and ($ProcessInfo.CommandLine.Contains($ScriptPath) -or $ProcessInfo.CommandLine.Contains('src/index.js'))) {
    return $ProcessInfo
  }
  return $null
}

if (-not (Test-Path -LiteralPath $PidFile)) {
  'feishu-opendray-bridge is not running: adapter.pid not found.'
  exit 0
}

$PidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
if (-not $PidText) {
  Remove-Item -LiteralPath $PidFile -Force
  'feishu-opendray-bridge is not running: adapter.pid was empty.'
  exit 0
}

$Process = Get-BridgeProcess ([int]$PidText)
if ($Process) {
  Stop-Process -Id $Process.ProcessId -Force
  "feishu-opendray-bridge stopped. PID=$PidText"
} else {
  "feishu-opendray-bridge was not running. Stale PID=$PidText"
}

Remove-Item -LiteralPath $PidFile -Force
