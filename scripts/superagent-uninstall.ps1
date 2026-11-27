# Removes the super-agent installation completely, one command (C-26a).
#
# What it removes, in this order:
#   1. the `.disabled` marker: the plugin loads nothing after a restart, even if something still names it;
#   2. start-up entries whose name names this installation (`superagent` / `dsh-superagent`), in the Run key and the Startup folder;
#   3. the plugin's loader entries in the DSH profile's cordis.patch.yml, after backing that file up beside itself;
#   4. with -RemoveProgram -ProgramDir <dir>, the plugin's program directory itself (the built `lib`).
#
# What it never touches (C-26): the state directory (database, ticket directories, handoffs), DSH's own settings other than this
# plugin's entries, sessions, and anything already delivered. Deleting the state directory is the person's own decision.
#
# DSH is left running: close it and open it again for the removal to take effect (C-26a allows a cold restart). It stops no
# process and asks nothing.
param(
  [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$StateDir = (Join-Path $env:USERPROFILE '.dsh\state\superagent'),
  [string]$ProgramDir = '',
  [switch]$RemoveProgram,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
function Say([string]$text) { Write-Output $text }
if ($RemoveProgram -and -not $ProgramDir) { Say '用 -RemoveProgram 时要同时用 -ProgramDir 指明程序目录（插件 lib 所在的目录）。'; exit 1 }

Say '== super-agent 卸载 =='
if (-not $Yes) {
  Say "将删除：开机/启动项、DSH 配置里 dsh-superagent 的加载条目、以及“禁用”标记。"
  Say "将保留：状态库 ($StateDir)、工单目录、会话历史、已交付的东西。"
  if ($RemoveProgram) { Say "另外将删除程序目录：$ProgramDir" }
  $answer = Read-Host '确认继续？输入 yes 回车'
  if ($answer -ne 'yes') { Say '已取消，什么都没改。'; exit 1 }
}

# 1. The plugin loads nothing from now on, whatever still names it.
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$marker = Join-Path $StateDir '.disabled'
@{ at = (Get-Date).ToString('o'); by = 'superagent-uninstall.ps1' } | ConvertTo-Json | Set-Content -Path $marker -Encoding utf8
Say "已写禁用标记：$marker"

# 2. Start-up entries, by name only: no other value is read or changed.
$patterns = 'superagent', 'dsh-superagent'
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path $run) {
  $keys = Get-Item -Path $run
  foreach ($name in $keys.GetValueNames()) {
    foreach ($pattern in $patterns) {
      if ($name -like "*$pattern*") {
        Remove-ItemProperty -Path $run -Name $name -Force
        Say "已删除启动项：$name"
      }
    }
  }
}
$startup = [Environment]::GetFolderPath('Startup')
Get-ChildItem -Path $startup -File -ErrorAction SilentlyContinue | Where-Object {
  $file = $_.Name
  $patterns | Where-Object { $file -like "*$_*" }
} | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force
  Say "已删除启动文件：$($_.Name)"
}

# 3. The profile's loader entries. A top-level array item is removed whole when its text names this plugin, so a `- insert:`
#    block that carries only this plugin goes with it; the file is backed up first and checked afterwards.
$config = Join-Path $Profile 'cordis.patch.yml'
if (Test-Path $config) {
  $backup = "$config.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $config -Destination $backup
  $lines = Get-Content -LiteralPath $config -Encoding utf8
  $preamble = New-Object System.Collections.Generic.List[string]
  $items = New-Object System.Collections.Generic.List[object]
  $current = $null
  foreach ($line in $lines) {
    if ($line -match '^-(\s|$)') {
      if ($null -ne $current) { $items.Add($current) }
      $current = New-Object System.Collections.Generic.List[string]
    }
    if ($null -ne $current) { $current.Add($line) } else { $preamble.Add($line) }
  }
  if ($null -ne $current) { $items.Add($current) }
  $kept = New-Object System.Collections.Generic.List[string]
  foreach ($line in $preamble) { $kept.Add($line) }
  $removed = 0
  foreach ($item in $items) {
    $text = ($item -join "`n")
    if ($text -match 'dsh-superagent') { $removed++; continue }
    foreach ($line in $item) { if ($line -notmatch '^#.*super-agent') { $kept.Add($line) } }
  }
  Set-Content -LiteralPath $config -Value $kept -Encoding utf8
  if (Select-String -Path $config -Pattern 'dsh-superagent' -SimpleMatch -Quiet) {
    Copy-Item -LiteralPath $backup -Destination $config -Force
    Say "配置里仍有 dsh-superagent 字样，已还原备份：$backup。请手动检查 $config"
    exit 1
  }
  Say "已从 $config 删除 $removed 个加载条目（备份：$backup）"
} else {
  Say "没找到 $config，跳过配置删除。"
}

# 4. Program files, only when asked: the state directory stays where it is (C-26).
if ($RemoveProgram) {
  if (Test-Path $ProgramDir) {
    Remove-Item -LiteralPath $ProgramDir -Recurse -Force
    Say "已删除程序目录：$ProgramDir"
  } else { Say "程序目录不存在，跳过：$ProgramDir" }
} else {
  Say '程序目录未删除（要一起删就加 -RemoveProgram -ProgramDir <程序目录>）'
}

Say ''
Say ('完成。数据与历史都保留在：' + $StateDir)
Say '接下来：关掉 DSH 再打开，插件就不再加载了。'
