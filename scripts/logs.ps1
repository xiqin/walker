$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutLog = Join-Path $ProjectRoot 'logs\adapter.out.log'
$ErrLog = Join-Path $ProjectRoot 'logs\adapter.err.log'
$Tail = 80

if ($args.Count -gt 0) {
  $Tail = [int]$args[0]
}

if (Test-Path -LiteralPath $OutLog) {
  '--- stdout ---'
  Get-Content -LiteralPath $OutLog -Tail $Tail
}

if (Test-Path -LiteralPath $ErrLog) {
  '--- stderr ---'
  Get-Content -LiteralPath $ErrLog -Tail $Tail
}
