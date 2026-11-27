# Super-agent keep-alive guard (C-26a).
#
# The plugin is the only reason this installation keeps DSH running. This guard therefore does nothing when
#   1. the state directory holds the `.disabled` marker (scripts/superagent-off.ps1 writes it), or
#   2. the DSH profile no longer loads dsh-superagent (the plugin was switched off or removed).
# Only when the plugin is still installed does it start DSH if it is not running. It changes no DSH setting and
# deletes nothing.
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent'),
  [string]$Exe = ''
)
$ErrorActionPreference = 'Stop'

# Discover the DeepSeek Harness desktop executable when -Exe is not given. Probe the standard per-user and per-machine
# install locations instead of assuming one machine's path; pass -Exe <path> to override (e.g. a custom install drive).
if (-not $Exe) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe') }
  $Exe = [string]($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
}

if (Test-Path (Join-Path $StateDir '.disabled')) { exit 0 }
$config = Join-Path $Profile 'cordis.patch.yml'
if (-not (Test-Path $config)) { exit 0 }
if (-not (Select-String -Path $config -Pattern 'dsh-superagent' -SimpleMatch -Quiet)) { exit 0 }
if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { exit 0 }

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) { exit 0 }
Start-Process -FilePath $Exe
exit 0
