# 把 dsh-werewolf 同步进 DSH profile。
#
#   .\sync.ps1                        # 同步到 desktop profile
#   .\sync.ps1 -Profile web           # 指定 profile
#
# 为什么要同步：DSH 的 HMR 只监听 profile 目录内的模块，profile 之外的模块
# 被判定为 external，改了永远不会热重载。源码留在仓库，运行用 profile 里的副本。
#
# 同步后**还要**做两件事才会真正换新代码（原因见 README「更新流程」）：
#   1. 把 cordis.patch.yml 里该行 name 末尾的 ?v=N 加一
#   2. 用 plugin_manager 把 include:werewolf 停用再启用
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot
$target = Join-Path $DshHome "profiles\$Profile\plugins\dsh-werewolf"

if (-not (Test-Path (Join-Path $DshHome "profiles\$Profile"))) {
  throw "profile 不存在：$(Join-Path $DshHome "profiles\$Profile")"
}

foreach ($dir in 'lib', 'test', 'tools') {
  New-Item -ItemType Directory -Force -Path (Join-Path $target $dir) | Out-Null
}

Copy-Item (Join-Path $source 'lib\*.js') -Destination (Join-Path $target 'lib') -Force
Copy-Item (Join-Path $source 'test\*.mjs') -Destination (Join-Path $target 'test') -Force
Copy-Item (Join-Path $source 'tools\*') -Destination (Join-Path $target 'tools') -Force
foreach ($file in 'package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'PUBLISH.md') {
  $from = Join-Path $source $file
  if (Test-Path $from) { Copy-Item $from -Destination $target -Force }
}

$build = (Select-String -Path (Join-Path $source 'lib\index.js') -Pattern "const BUILD = '([^']+)'" |
  Select-Object -First 1).Matches.Groups[1].Value

Write-Host "已同步到 $target" -ForegroundColor Green
Write-Host "当前构建标记：$build" -ForegroundColor Green
Write-Host '还需：① cordis.patch.yml 里 ?v=N 加一 ② plugin_manager 停用/启用 include:werewolf' -ForegroundColor Yellow
