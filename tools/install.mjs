/**
 * 一行命令把 dsh-werewolf 装进任意 DSH profile（跨平台、幂等）。
 *
 *   node tools/install.mjs                          # 装到默认 profile（~/.dsh/profiles/desktop）
 *   node tools/install.mjs --profile web            # 指定 profile
 *   node tools/install.mjs --dsh-home D:\dshhome    # 指定 DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
 *   node tools/install.mjs --preset                 # 顺便装「狼人杀模式」Agent Preset
 *   node tools/install.mjs --bump                   # 升级：同步代码并把模块 URL 的 ?v=N 加一
 *   node tools/install.mjs --dry-run                # 只打印将要做的改动，不落盘
 *
 * 它做三件事：
 *   1. 把插件文件复制到 <profile>/plugins/dsh-werewolf/（HMR 只监听 profile 目录内的模块，
 *      放外面改了不会热重载）
 *   2. 往 <profile>/cordis.patch.yml 写入/更新一行 insert，模块 URL 按平台自动生成
 *      （Windows 用 file:///C:/…，POSIX 用绝对路径）
 *   3. 可选：装 Agent Preset「狼人杀模式」（等价于 tools/apply-preset.mjs）
 *
 * 零依赖，只用 node: 内置模块。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/** 读取 `--key value` 形式的参数。 */
function arg(key) {
  const index = argv.indexOf(`--${key}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const dryRun = argv.includes('--dry-run')
const withPreset = argv.includes('--preset')
const bump = argv.includes('--bump')
const profile = arg('profile') ?? 'desktop'
const dshHome = arg('dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')

const profileDir = join(dshHome, 'profiles', profile)
const patchPath = join(profileDir, 'cordis.patch.yml')
const installDir = join(profileDir, 'plugins', 'dsh-werewolf')
const entryPath = join(installDir, 'lib', 'index.js')

/** 统一的提示输出。 */
function step(message) {
  console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)
}

// --- 0. 前置检查
if (!existsSync(profileDir)) {
  const profilesDir = join(dshHome, 'profiles')
  let available = '（未找到任何 profile）'
  try {
    const names = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'cordis.patch.yml')))
      .map((entry) => entry.name)
    available = names.length > 0 ? names.join(', ') : available
  } catch {
    available = `（找不到 ${profilesDir}）`
  }
  console.error(`✗ profile 不存在：${profileDir}`)
  console.error(`  已发现的 profile：${available}`)
  console.error('  用 --profile <名字> 指定，或用 --dsh-home <路径> 指定 DSH 主目录。')
  process.exit(1)
}
if (existsSync(entryPath)) {
  step(`检测到已安装，将覆盖更新：${installDir}`)
}

// --- 1. 复制插件文件（不含 node_modules / 对局导出）
const COPY = ['lib', 'tools', 'test', 'examples']
const COPY_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'PUBLISH.md', 'sync.ps1']
step(`复制插件 → ${installDir}`)
if (!dryRun) {
  mkdirSync(installDir, { recursive: true })
  for (const dir of COPY) {
    const from = join(root, dir)
    if (existsSync(from)) cpSync(from, join(installDir, dir), { recursive: true })
  }
  for (const file of COPY_FILES) {
    const from = join(root, file)
    if (existsSync(from)) cpSync(from, join(installDir, file))
  }
}

// --- 2. 写入/更新 profile 补丁里的插件行
// Windows 上 Node 的 ESM loader 不接受裸盘符路径，必须用 file:/// URL；POSIX 两种都行。
const baseUrl = process.platform === 'win32' ? pathToFileURL(entryPath).href : entryPath

let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
// 保留（或按 --bump 自增）已有的 ?v=N：ESM 按 URL 缓存模块，升级必须换 URL 才会换新代码。
const versionMatch = /name:\s*'[^']*dsh-werewolf[^']*index\.js(?:\?v=(\d+))?'/.exec(patch)
const previousVersion = versionMatch?.[1] === undefined ? 0 : Number(versionMatch[1])
const version = bump ? previousVersion + 1 : previousVersion
const moduleUrl = version > 0 ? `${baseUrl}?v=${version}` : baseUrl
if (bump) step(`版本号 ?v=${previousVersion} → ?v=${version}（缓存版本自增）`)

const block = [
  '# dsh-werewolf：AI 狼人杀模式（1 位裁判 + N 位玩家，全部是真实子智能体）',
  '# 由 tools/install.mjs 写入；升级用 `node tools/install.mjs --bump`',
  '- insert:',
  '    - id: werewolf',
  `      name: '${moduleUrl}'`,
  '      config:',
  '        seats: 12',
  '        godView: true',
  '        sheriff: auto',
  '        reasoningEffort: low',
  '        turnTimeoutMs: 120000',
  '        autoExport: true',
  '        exportDir: werewolf-logs',
].join('\n')

if (versionMatch !== null) {
  // 已存在：只替换那一行的 name，避免重复插入
  const before = patch
  patch = patch.replace(
    /(\n\s*-?\s*id: werewolf[\s\S]{0,400}?name:\s*')[^']*(')/,
    (_match, head, tail) => `${head}${moduleUrl}${tail}`,
  )
  step(patch === before ? '补丁里已有 werewolf 行（URL 未变化，跳过）' : `更新补丁里的模块 URL → ${moduleUrl}`)
} else {
  patch = `${patch.replace(/\s+$/, '')}\n${block}\n`
  step(`追加插件行到 ${patchPath}`)
}
if (!dryRun) writeFileSync(patchPath, patch, 'utf8')

// --- 3. 可选：装 Agent Preset
if (withPreset) {
  const snippetPath = join(root, 'tools', 'preset-werewolf.yml')
  if (!existsSync(snippetPath)) {
    console.error(`✗ 找不到 preset 片段：${snippetPath}`)
  } else if (patch.includes('- id: preset-werewolf')) {
    step('「狼人杀模式」preset 已存在，跳过')
  } else {
    const snippet = readFileSync(snippetPath, 'utf8').replace(/\s+$/, '')
    patch = `${readFileSync(patchPath, 'utf8').replace(/\s+$/, '')}\n${snippet}\n`
    if (!dryRun) writeFileSync(patchPath, patch, 'utf8')
    step('已追加「狼人杀模式」preset 到 profile 补丁')
  }
}

// --- 4. 收尾提示
console.log('')
console.log(dryRun ? '（dry-run：以上改动未落盘）' : '✓ 安装完成')
console.log(`  DSH 主目录   : ${dshHome}`)
console.log(`  profile      : ${profile}`)
console.log(`  插件安装目录 : ${installDir}`)
console.log(`  模块 URL     : ${moduleUrl}`)
console.log('')
console.log('接下来：')
console.log('  1) 重启 DSH（或直接保存/触碰一次 cordis.patch.yml 触发热重载）')
console.log('  2) 若改了代码要生效：把补丁里 ?v=N 加一，并在插件管理器里停用/启用 include:werewolf')
console.log('  3) 用 /werewolf 或说「玩一局狼人杀」开局；对局结束会自动导出 Markdown')
if (withPreset) console.log('  4) 刷新浏览器（F5）→ 设置 → Agent 预设 → 自定义 → 狼人杀模式')
else console.log('  4) （可选）装「狼人杀模式」：重跑本脚本并加 --preset，或 node tools/apply-preset.mjs')
