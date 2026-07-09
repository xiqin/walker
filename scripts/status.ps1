$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'walker.pid'
$OutLog = Join-Path $ProjectRoot 'logs\walker.out.log'
$ErrLog = Join-Path $ProjectRoot 'logs\walker.err.log'
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

if (Test-Path -LiteralPath $PidFile) {
  $PidText = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  $Process = if ($PidText) { Get-BridgeProcess ([int]$PidText) } else { $null }
  if ($Process) {
    "status: running"
    "pid: $PidText"
  } else {
    "status: stopped"
    "stale_pid: $PidText"
  }
} else {
  "status: stopped"
}

if (Test-Path -LiteralPath $OutLog) {
  '--- recent stdout ---'
  Get-Content -LiteralPath $OutLog -Tail 20
}

if (Test-Path -LiteralPath $ErrLog) {
  '--- recent stderr ---'
  Get-Content -LiteralPath $ErrLog -Tail 20
}
