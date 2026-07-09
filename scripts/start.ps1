$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'adapter.pid'
$LogDir = Join-Path $ProjectRoot 'logs'
$OutLog = Join-Path $LogDir 'adapter.out.log'
$ErrLog = Join-Path $LogDir 'adapter.err.log'
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
  $ExistingPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (Get-BridgeProcess ([int]$ExistingPid)) {
    "feishu-opendray-bridge is already running. PID=$ExistingPid"
    exit 0
  }
}

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Process = Start-Process -FilePath $Node -ArgumentList @($ScriptPath) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
$Process.Id | Set-Content -LiteralPath $PidFile -Encoding ascii

Start-Sleep -Seconds 3
$Running = Get-BridgeProcess $Process.Id
if (-not $Running) {
  "feishu-opendray-bridge failed to stay running. See logs:"
  "  $OutLog"
  "  $ErrLog"
  exit 1
}

"feishu-opendray-bridge started. PID=$($Process.Id)"
"stdout: $OutLog"
"stderr: $ErrLog"
