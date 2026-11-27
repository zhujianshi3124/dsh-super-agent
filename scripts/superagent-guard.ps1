# Super-agent keep-alive guard (C-26a).
#
# The plugin is the only reason this installation keeps DSH running. This guard therefore does nothing when
#   1. the state directory holds the `.disabled` marker (scripts/superagent-off.ps1 writes it), or
#   2. the DSH profile no longer loads dsh-superagent (the plugin was switched off or removed).
# Only when the plugin is still installed does it start DSH if it is not running. It changes no DSH setting and
# deletes nothing. If DSH needs starting but cannot be found, it says so and exits 1 instead of passing silently.
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent'),
  [string]$Exe = ''
)
$ErrorActionPreference = 'Stop'

if (Test-Path (Join-Path $StateDir '.disabled')) { exit 0 }
$config = Join-Path $Profile 'cordis.patch.yml'
if (-not (Test-Path $config)) { exit 0 }
if (-not (Select-String -Path $config -Pattern 'dsh-superagent' -SimpleMatch -Quiet)) { exit 0 }

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) { exit 0 }

# Discover the DeepSeek Harness desktop executable when -Exe is not given. Its installer records the install directory under
# the Uninstall registry keys (per user, per machine, and the 32-bit view), which finds an install on any drive; the standard
# per-user and per-machine install directories are probed after that. Pass -Exe <path> to override.
if (-not $Exe) {
  $uninstall = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
  $candidates = @(foreach ($root in "HKCU:\$uninstall", "HKLM:\$uninstall", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") {
    foreach ($key in @(Get-ChildItem -Path $root -ErrorAction SilentlyContinue)) {
      $entry = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
      $location = [string]$entry.InstallLocation
      # Joined by .NET: Join-Path fails on a drive that no longer exists, such as a removed disk an old entry still names.
      if ($entry.DisplayName -like 'DeepSeek Harness*' -and $location) {
        try { [System.IO.Path]::Combine($location.Trim('"'), 'DeepSeek Harness.exe') } catch { }
      }
    }
  })
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
  $candidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe') }
  $Exe = [string]($candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
  if (-not $Exe) {
    Write-Warning 'superagent-guard: DeepSeek Harness is not running and was not found in the Uninstall registry keys or the default install directories; pass -Exe <path to DeepSeek Harness.exe>.'
    exit 1
  }
} elseif (-not (Test-Path -LiteralPath $Exe)) {
  Write-Warning "superagent-guard: DeepSeek Harness is not running and -Exe does not exist: $Exe"
  exit 1
}

Start-Process -FilePath $Exe
exit 0
