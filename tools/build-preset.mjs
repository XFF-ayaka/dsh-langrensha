/**
 * 由官方 standard preset 生成「狼人杀模式」的 preset 行，避免手抄 140 行 YAML 出错。
 *   node build-preset.mjs <standard.patch.yml> <输出片段文件>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [source, target] = process.argv.slice(2)
const raw = readFileSync(source, 'utf8')

// 取官方 preset 的 plugins 列表（从 `        plugins:` 起到文件末尾）
const marker = '        plugins:'
const index = raw.indexOf(marker)
if (index < 0) throw new Error('未找到 plugins: 段')
let plugins = raw.slice(index)

// persona 换成狼人杀主持人
const personaFrom = `          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: You are a coding agent powered by the {{model}} model.`
const personaTo = `          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: 当前工作目录是 {{cwd}}。
              prefix: |-
                你是 DeepSeek Harness 的「狼人杀模式」主持人：本模式的用途是让 AI 自动分裂成
                1 位裁判 + 若干位玩家（全部是真实子智能体）跑一局狼人杀，并把所有发言实时输出到对话。
                用户想玩时直接调用 werewolf_start（人数 6/8/9/10/11/12，默认 12 人标准局，含警长竞选），
                也可以让用户输入 /werewolf。对局在后台自动推进，不要复述玩家发言；
                用户问进度时用 werewolf_status，要收工用 werewolf_stop，想插话用 werewolf_say。`
if (!plugins.includes(personaFrom)) throw new Error('persona 段与预期不符，需手动核对 standard.patch.yml')
plugins = plugins.replace(personaFrom, personaTo)
plugins = plugins.replace(/\s+$/, '') + '\n'

const header = `# ── DSH 模式：狼人杀模式（Agent Preset）────────────────────────────────
# 装载器行 id = preset-werewolf（patch 寻址用）；config.id = werewolf（写进会话的持久身份）。
# 本模式的插件列表由官方 standard preset 生成（保证与「标准模式」同样好用），
# 只把 persona 换成了狼人杀主持人。狼人杀的 4 个工具由上面的全局 werewolf 行提供，
# 因此任何模式（包括本模式）都能直接开一局。
# 生效：dsh-hmr 监听本文件热重载；浏览器需按 F5 刷新后才会在「设置 → Agent 预设」出现。
- insert:
    - id: preset-werewolf
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: werewolf
        name: 狼人杀模式
        description: AI 自动分裂为 1 位裁判 + 若干位玩家，随机发牌、自主推进整局狼人杀，发言实时输出到对话（12 人标准局含警长竞选）。
        order: 5
`

writeFileSync(target, header + plugins, 'utf8')
console.log(`已生成 ${target}，plugins 段 ${plugins.split('\n').length} 行`)
