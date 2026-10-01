/**
 * 把「狼人杀模式」preset 安装进 DSH profile（幂等）。
 *
 *   node tools/apply-preset.mjs                       # 默认安装到 desktop profile
 *   node tools/apply-preset.mjs web                   # 指定 profile
 *   node tools/apply-preset.mjs desktop --remove      # 卸载（移除该 preset 段）
 *
 * 原理：DSH 的「模式」= Agent Preset = profile 补丁里的一行
 * `@deepseek-ai/dsh-agent-preset`，其 config.plugins 描述该模式的能力组合。
 * 本脚本把 tools/preset-werewolf.yml 追加到 <profile>/cordis.patch.yml。
 *
 * 装完请刷新浏览器（F5）：Host 会热重载，但已打开的页面不会主动重读模式列表。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const profile = args.find((value) => !value.startsWith('--')) ?? 'desktop'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
const snippetPath = join(here, 'preset-werewolf.yml')

if (!existsSync(patchPath)) throw new Error(`profile 补丁不存在：${patchPath}`)
if (!existsSync(snippetPath)) throw new Error(`preset 片段不存在：${snippetPath}`)

const snippet = readFileSync(snippetPath, 'utf8').replace(/\s+$/, '')
const marker = '- id: preset-werewolf'
const current = readFileSync(patchPath, 'utf8')

if (remove) {
  const lines = current.split('\n')
  const start = lines.findIndex((line) => line.trim() === marker)
  if (start < 0) {
    console.log('未找到 preset-werewolf 段，无需卸载。')
    process.exit(0)
  }
  // 段范围：从「# ── DSH 模式」注释块（或 marker 行）到下一个顶层 「- insert:/- id:」 之前
  let from = start
  while (from > 0 && lines[from - 1].trim().startsWith('#')) from--
  let to = start + 1
  while (to < lines.length && !(lines[to].startsWith('- ') && !lines[to].startsWith('    '))) to++
  lines.splice(from, to - from)
  writeFileSync(patchPath, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
  console.log(`已从 ${patchPath} 移除「狼人杀模式」preset。请刷新浏览器（F5）。`)
  process.exit(0)
}

if (current.includes(marker)) {
  console.log('「狼人杀模式」preset 已存在；如需更新，先 --remove 再安装。')
  process.exit(0)
}

const next = `${current.replace(/\s+$/, '')}\n${snippet}\n`
writeFileSync(patchPath, next, 'utf8')
console.log(`已安装到 ${patchPath}`)
console.log('请刷新浏览器（F5），然后到「设置 → Agent 预设 → 自定义」查看「狼人杀模式」。')
