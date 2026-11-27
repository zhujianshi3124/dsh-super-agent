# Reverses superagent-off.ps1: clears the marker so the plugin and its guard may run again. It touches no data.
param(
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent')
)
$ErrorActionPreference = 'Stop'
$marker = Join-Path $StateDir '.disabled'
if (Test-Path $marker) { Remove-Item -LiteralPath $marker -Force }
Write-Output 'plugin on: marker cleared. Restart DSH so the plugin loads.'
