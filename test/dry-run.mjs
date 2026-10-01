/**
 * 离线自测：用脚本化的 ask/judge 跑完整局，验证规则状态机与 Markdown 导出，
 * 全程不依赖任何 LLM 调用。
 *
 *   node test/dry-run.mjs              # 跑 6 / 8 / 9 / 12 人各 5 局
 *   node test/dry-run.mjs 12 20        # 12 人局跑 20 次随机种子
 *   node test/dry-run.mjs 12 1 --write # 额外把第一局的 Markdown 写到 examples/sample-report.md
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WerewolfGame } from '../lib/engine.js'
import { resolveBoard } from '../lib/rules.js'
import { buildMarkdown, reportFilename } from '../lib/report.js'
// 插件入口：`apply` 只由 loader 调用，这里只借用导出工具做端到端落盘测试。
const { saveReport } = await import('../lib/index.js')

const WRITE_SAMPLE = process.argv.includes('--write')
const SAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'sample-report.md')

/** 可复现的伪随机源。 */
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从提示词里抽出所有「N号」作为候选。 */
function seatsIn(prompt) {
  return [...new Set([...prompt.matchAll(/(\d{1,2})\s*号/g)].map((match) => Number(match[1])))].sort((a, b) => a - b)
}

const pick = (list, rng) => list[Math.floor(rng() * list.length)]

/**
 * 脚本化玩家：按提示词里要求的输出协议伪造一条合法回复。
 * @param {() => number} rng - 随机源
 * @returns {(seat:number, prompt:string)=>Promise<string>} ask 实现
 */
function scriptedAsk(rng) {
  return async (seat, prompt) => {
    if (prompt.includes('只回复「收到」')) return '收到'
    const candidates = seatsIn(prompt).filter((item) => item !== seat)
    const anySeat = candidates.length > 0 ? candidates : seatsIn(prompt)
    // --- 警长竞选相关（必须在通用【投票】分支之前判断）
    if (/【上警】/.test(prompt)) {
      return rng() < 0.6 ? `我上警带节奏。\n【上警】是` : `我先不上警。\n【上警】否`
    }
    if (/【方向】/.test(prompt)) return `从${rng() < 0.5 ? '左' : '右'}边开始。\n【方向】${rng() < 0.5 ? '左' : '右'}`
    if (/【警长】/.test(prompt)) return `【警长】${pick(anySeat, rng)}号`
    if (/【警徽】/.test(prompt)) {
      return rng() < 0.25 ? '我不移交了。\n【警徽】撕' : `交给信任的人。\n【警徽】${pick(anySeat, rng)}号`
    }
    if (/【狼刀】/.test(prompt)) return `场上${pick(anySeat, rng)}号发言偏软，先刀他。\n【狼刀】${pick(anySeat, rng)}号`
    if (/【查验】/.test(prompt)) return `先摸个远的。\n【查验】${pick(anySeat, rng)}号`
    if (/【女巫】/.test(prompt) && /用药决定/.test(prompt)) {
      const roll = rng()
      if (roll < 0.4) return '今晚救人。\n【女巫】救'
      if (roll < 0.6) return `毒一个可疑的。\n【女巫】毒 ${pick(anySeat, rng)}号`
      return '今晚不用药。\n【女巫】不用'
    }
    if (/【守护】/.test(prompt)) return `守一个。\n【守护】${pick(anySeat, rng)}号`
    if (/【开枪】/.test(prompt)) return `带走一个。\n【开枪】${pick(anySeat, rng)}号`
    if (/【投票】/.test(prompt)) return `【投票】${pick(anySeat, rng)}号`
    if (/遗言/.test(prompt)) return `我是${seat}号，好人跟票别分票。`
    return `我是${seat}号玩家，我的判断是场上${pick(anySeat, rng)}号最像狼，他是狼面最大的一个。`
  }
}

/** 跑一局，返回结果与统计。 */
async function playOnce(seats, seed) {
  const rng = mulberry32(seed)
  const transcript = []
  const game = new WerewolfGame({
    boardSpec: seats,
    options: { godView: false, maxDays: 30 },
    rng,
    ask: scriptedAsk(rng),
    judge: null,
    emit: (text) => transcript.push(text),
  })
  const result = await game.run()
  return { result, transcript, game }
}

/** 断言。 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`)
}

let failures = 0
const boards = process.argv[2] !== undefined ? [Number(process.argv[2])] : [6, 8, 9, 12]
const rounds = process.argv[3] !== undefined ? Number(process.argv[3]) : 5

for (const board of boards) {
  const spec = resolveBoard(board)
  let goodWins = 0
  let wolfWins = 0
  let draws = 0
  for (let index = 0; index < rounds; index++) {
    const seed = 1000 + index * 37 + board
    const { result, transcript, game } = await playOnce(board, seed)
    assert(result.roles.length === spec.seats, `${board} 人局应有 ${spec.seats} 名玩家，实得 ${result.roles.length}`)
    assert(transcript.length > spec.seats, `${board} 人局应产生足够多的播报，实得 ${transcript.length}`)
    assert(game.day <= 31, `${board} 人局超过最大天数`)
    const wolves = result.roles.filter((row) => row.role === 'wolf').length
    assert(wolves === spec.wolves, `${board} 人局狼人应为 ${spec.wolves}，实得 ${wolves}`)
    // 警长竞选：>= 9 人默认开启，且第 1 天必定跑过一次
    if (spec.seats >= 9) {
      assert(game.sheriffEnabled === true, `${board} 人局应开启警长竞选`)
      assert(game.sheriffElectionDone === true, `${board} 人局应完成过警长竞选`)
      if (game.sheriffSeat !== null) {
        const sheriff = game.players.find((player) => player.seat === game.sheriffSeat)
        assert(sheriff !== undefined, `${board} 人局警长座位应存在`)
      }
    } else {
      assert(game.sheriffEnabled === false, `${board} 人局（<9 人）默认不设警长`)
    }
    // Markdown 导出：必须有标题、身份表、时间线与页脚
    const markdown = buildMarkdown(game, { build: 'dry-run' })
    assert(markdown.includes('# 狼人杀对局记录'), `${board} 人局 Markdown 缺少标题`)
    assert(markdown.includes('## 一、身份表'), `${board} 人局 Markdown 缺少身份表`)
    assert(markdown.includes('## 三、对局时间线'), `${board} 人局 Markdown 缺少时间线`)
    assert(markdown.split('\n').length > spec.seats * 2, `${board} 人局 Markdown 内容过短`)
    assert(/狼人杀-\d{8}-\d{4}-\d+人局\.md/.test(reportFilename(game, new Date(2026, 9, 1, 20, 15))), `${board} 人局导出文件名格式不对`)
    if (result.winner === 'good') goodWins++
    else if (result.winner === 'wolves') wolfWins++
    else draws++
    if (index === 0) {
      console.log(`\n=== ${spec.label}（seed ${seed}）===\n` + transcript.slice(0, 12).join('\n') + '\n...（共 ' + transcript.length + ' 条公开播报）')
      console.log(`结局：${result.winner ?? 'draw'}，第 ${result.day} 天`)
      console.log(`Markdown：${reportFilename(game)}（${markdown.split('\n').length} 行）`)
      if (WRITE_SAMPLE) {
        mkdirSync(dirname(SAMPLE_PATH), { recursive: true })
        writeFileSync(SAMPLE_PATH, `<!-- 由 node test/dry-run.mjs ${board} 1 --write 生成，用于展示导出格式 -->\n\n${markdown}`, 'utf8')
        console.log(`样例已写入：${SAMPLE_PATH}`)
      }
      // saveReport 端到端：用假 Agent 提供工作目录，验证真的写盘 + 内容可读回
      const sandbox = mkdtempSync(join(tmpdir(), 'dsh-werewolf-'))
      try {
        const saved = saveReport({
          agent: { session: { header: { cwd: sandbox } } },
          game,
          config: { exportDir: 'werewolf-logs' },
        })
        assert(existsSync(saved.path), '导出文件应真实存在')
        assert(saved.bytes > 1024, `导出文件不应为空，实得 ${saved.bytes} 字节`)
        const written = readFileSync(saved.path, 'utf8')
        assert(written.startsWith('# 狼人杀对局记录'), '导出文件开头应是标题')
        assert(written.includes('## 三、对局时间线'), '导出文件应包含时间线')
        console.log(`落盘校验通过：${saved.path.replace(sandbox, '<tmp>')}（${saved.lines} 行 / ${saved.bytes} 字节）`)
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
      }
    }
  }
  console.log(`\n[${spec.label}] ${rounds} 局：好人胜 ${goodWins} / 狼人胜 ${wolfWins} / 判和 ${draws}`)
}

console.log('\n✅ dry-run 全部通过')
process.on('exit', (code) => {
  if (code !== 0) failures++
  void failures
})
