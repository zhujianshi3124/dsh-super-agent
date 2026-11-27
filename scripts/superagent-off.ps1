# Turns the super-agent installation off completely (C-26a, C-26).
#
# It stops the plugin by leaving the `.disabled` marker the guard and any patrol read, and removes only start-up
# entries whose name names this installation (`superagent` / `dsh-superagent`). It deletes no user data: the state
# database, sessions, ticket directories and handoffs all stay where they are. Run `superagent-on.ps1` to reverse it.
param(
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent')
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$marker = Join-Path $StateDir '.disabled'
@{ at = (Get-Date).ToString('o'); by = 'superagent-off.ps1' } | ConvertTo-Json | Set-Content -Path $marker -Encoding utf8
Write-Output "plugin off: wrote $marker"

$patterns = 'superagent', 'dsh-superagent'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $run) {
  $keys = Get-Item -Path $run
  foreach ($name in $keys.GetValueNames()) {
    foreach ($pattern in $patterns) {
      if ($name -like "*$pattern*") {
        Remove-ItemProperty -Path $run -Name $name -Force
        Write-Output "removed start-up entry: $name"
      }
    }
  }
}
$startup = [Environment]::GetFolderPath('Startup')
Get-ChildItem -Path $startup -File -ErrorAction SilentlyContinue | Where-Object {
  $name = $_.Name
  $patterns | Where-Object { $name -like "*$_*" }
} | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force
  Write-Output "removed start-up file: $($_.Name)"
}
Write-Output 'done. dsh-superagent loads nothing until superagent-on.ps1 runs.'
