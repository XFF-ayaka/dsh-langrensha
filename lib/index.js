/**
 * dsh-werewolf — 给 DeepSeek Harness 定制的「狼人杀模式」（宿主端插件）。
 *
 * 一局游戏 = 1 位裁判 AI + N 位玩家 AI，全部由真实子智能体扮演：
 *   - 裁判由引擎随机发牌，并负责每个阶段的公开播报；
 *   - 每位玩家是独立的 `spawn` 子智能体（独立会话/上下文/人格，工具被完全屏蔽）；
 *   - 讨论阶段每位存活玩家依次发言，发言前会看到全部公开发言与前情，
 *     因此是「听取别人的对话之后再发言」；
 *   - 所有裁判播报与玩家发言都会作为 assistant 消息追加进**用户所在会话**，
 *     直接显示在用户的对话框里。
 *
 * 本插件刻意不 import 任何 @deepseek-ai/* 包（宿主从 asar 装载，外部插件目录
 * 解析不到这些包），只使用 Node 内置模块 + 相对导入。
 *
 * 子模块用「带版本查询的动态导入」：ESM 按 URL 缓存模块，静态 import 会让
 * 「换 URL 重挂载」只换到入口、子模块仍是旧代码。把入口 URL 上的 `?v=N`
 * 透传下去，改一次 `?v=` 就能整体换新（见 README「开发」一节）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const CACHE_KEY = new URL(import.meta.url).search

const { WerewolfGame } = await import(`./engine.js${CACHE_KEY}`)
const { resolveBoard, ROLE_LABEL } = await import(`./rules.js${CACHE_KEY}`)
const { playerBriefing } = await import(`./prompts.js${CACHE_KEY}`)
const { SubagentTable } = await import(`./table.js${CACHE_KEY}`)
const { buildMarkdown, reportFilename } = await import(`./report.js${CACHE_KEY}`)

/** 插件名（cordis 稳定标识）。 */
export const name = 'werewolf'

/**
 * 构建标记：用于在运行时确认装载的确实是当前这份代码
 * （它会随系统提示词一起出现在会话上下文里）。
 */
const BUILD = 'v7-fix-autoexport-scope'

/** 依赖的宿主服务：全部就绪后插件才会激活。 */
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents', 'commands']

/** 裁判人设：只播报事实，不掌握也不泄露任何未公开信息。 */
const JUDGE_BRIEFING = [
  '你是这局狼人杀的主持人（裁判 / 上帝），负责如实播报每一个阶段。',
  '',
  '铁律：',
  '1. 你只输出要播报给全体玩家的那一段话；不要解释、不要提问、不要复述规则、不要寒暄。',
  '2. 你每次只会收到「必须如实播报的事实」。严禁增删事实，严禁推测或泄露任何玩家的真实身份、狼刀目标、预言家查验结果、女巫用药等信息——这些信息本就不该出现在你的输入里。',
  '3. 语气像线下面杀主持人：简短、有节奏、有沉浸感，可以用「天黑请闭眼」「天亮了」这类口令。',
  '4. 不要使用 Markdown，不要输出【】标记，不要写「裁判：」这样的前缀。',
  '5. 你只输出这一次要播报的内容，不要输出思考过程。',
].join('\n')

/** 所有工具共用的输出渲染：把字符串投影成模型/界面可见的文本。 */
function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** 状态字符串渲染。 */
function statusRender(_args, value) {
  return [{ type: 'text', text: value.text }]
}

/**
 * 会话的工作目录（导出文件的默认落点）。
 * @param {object} agent - 调用方 Agent
 * @returns {string} 绝对路径
 */
function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/**
 * 把一局对局写成 Markdown 文件。
 * @param {object} input - 依赖
 * @param {object} input.agent - 调用方 Agent（提供默认目录）
 * @param {object} input.game - 对局
 * @param {object} [input.config] - 插件配置（`exportDir`）
 * @param {string} [input.target] - 显式路径：目录或 .md 文件
 * @returns {{path:string, bytes:number, lines:number}} 写入结果
 */
export function saveReport({ agent, game, config = {}, target }) {
  const base = sessionCwd(agent)
  const configured = config.exportDir
  let file
  if (typeof target === 'string' && target.trim() !== '') {
    const raw = target.trim()
    const absolute = isAbsolute(raw) ? raw : resolve(base, raw)
    file = /\.md$/i.test(absolute) ? absolute : join(absolute, reportFilename(game))
  } else {
    const dir = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'werewolf-logs'
    const absoluteDir = isAbsolute(dir) ? dir : resolve(base, dir)
    file = join(absoluteDir, reportFilename(game))
  }
  mkdirSync(resolve(file, '..'), { recursive: true })
  const markdown = buildMarkdown(game, { build: BUILD })
  writeFileSync(file, markdown, 'utf8')
  return { path: file, bytes: Buffer.byteLength(markdown, 'utf8'), lines: markdown.split('\n').length }
}

/**
 * 启动一局游戏（工具与斜杠命令共用）。
 * @param {object} input - 依赖
 * @param {object} input.ctx - 插件上下文
 * @param {object} input.agent - 调用方 Agent
 * @param {object} input.config - 插件配置
 * @param {object} [input.logger] - 日志器
 * @param {Map<string, object>} input.games - 会话→对局表
 * @param {number|string|object} [input.seats] - 板子
 * @param {boolean} [input.godView] - 是否在对话里显示上帝视角身份表
 * @returns {Promise<object>} 启动结果
 */
async function startGame({ ctx, agent, config, logger, games, seats, godView }) {
  const sessionId = agent.session?.id
  if (typeof sessionId !== 'string') throw new Error('werewolf_start 需要一个会话上下文')
  const running = games.get(sessionId)
  if (running !== undefined && running.game.phase !== 'over' && running.game.stopped !== true) {
    throw new Error('本会话已经有一局狼人杀正在进行中，请先用 werewolf_status 查看或 werewolf_stop 结束。')
  }

  const boardSpec = seats ?? config.seats ?? 12
  const board = resolveBoard(boardSpec)
  const table = new SubagentTable({ ctx, agent, config, logger })
  /** @type {Map<number, string>} 座位 → 该玩家的身份设定（发牌后填充） */
  let briefings = new Map()
  const game = new WerewolfGame({
    boardSpec: boardSpec,
    options: {
      ...config,
      godView: godView ?? config.godView ?? true,
    },
    ask: (seat, prompt) => table.run(`${seat}号玩家`, `${briefings.get(seat) ?? ''}\n\n=== 本轮指令 ===\n${prompt}`),
    judge: (prompt) => table.run('裁判', `${JUDGE_BRIEFING}\n\n=== 本轮指令 ===\n${prompt}`),
    emit: (text) => table.emit(text),
    signal: table.controller.signal,
  })
  game.prepare()
  const players = game.players
  // 每位玩家的身份设定：一次性子智能体没有长期记忆，所以每一轮都随提示词重发。
  briefings = new Map(
    players.map((player) => [
      player.seat,
      playerBriefing({
        seat: player.seat,
        role: player.role,
        seatCount: board.seats,
        boardLabel: board.label,
        sheriffEnabled: game.sheriffEnabled,
      }),
    ]),
  )

  // 后台跑完整局：每位玩家的发言、裁判每阶段播报都会实时追加到用户会话。
  const promise = (async () => {
    try {
      const result = await game.run()
      logger?.info?.(`[dsh-werewolf] 对局结束：${result.winner ?? 'draw'}（第 ${result.day} 天）`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== '游戏已中止' && message !== '牌桌已关闭') {
        logger?.warn?.(`[dsh-werewolf] 对局异常：${message}`)
        try {
          table.emit(`【裁判】本局因内部错误提前结束：${message}`)
        } catch {
          /* 发布失败忽略 */
        }
      }
    } finally {
      // 终局自动导出 Markdown（可用 config.autoExport: false 关闭）。
      // 注意：必须用 startGame 自己的 config 参数——`settings` 属于 apply() 的作用域。
      if (config.autoExport !== false && (game.timeline?.length ?? 0) > 0) {
        try {
          const saved = saveReport({ agent, game, config })
          table.emit(`【裁判】本局记录已导出为 Markdown：${saved.path}（${saved.lines} 行 / ${saved.bytes} 字节）`)
        } catch (error) {
          logger?.warn?.(`[dsh-werewolf] 导出 Markdown 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await table.stop()
      // 保留已结束的对局，便于事后用 werewolf_status 查看 / werewolf_export 再导一次。
      const entry = games.get(sessionId)
      if (entry?.table === table) entry.finished = true
    }
  })()
  promise.catch(() => {})

  games.set(sessionId, { table, game, promise, finished: false })
  const roster = players.map((player) => `${player.seat}号`).join('、')
  return {
    status: 'started',
    seats: board.seats,
    board: board.label,
    roster,
    note: `裁判 1 位 + 玩家 ${board.seats} 位已就位（每位 AI 都是独立子智能体）。对局正在后台推进，发言与播报会实时出现在本对话中；结束后会自动导出 Markdown；用 werewolf_status 查看进度，用 werewolf_stop 结束本局。`,
  }
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文
 * @param {object} [config] - 插件配置（来自 cordis.patch.yml 的 config 字段）
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {}
  const logger = ctx.logger?.('dsh-werewolf')
  /** @type {Map<string, {table: object, game: object, promise: Promise<unknown>}>} */
  const games = new Map()

  // --- 系统提示词：让每个 Agent 知道「狼人杀模式」存在以及怎么开一局。
  ctx.systemPrompt.section({
    name: 'plugin:dsh-werewolf',
    order: settings.promptOrder ?? 60,
    text: () =>
      [
        '本机已安装 dsh-werewolf 插件（狼人杀模式）：它可以让 AI 自动分裂成 1 位裁判 + 若干位玩家，',
        '全部由真实子智能体扮演，随机发牌、自主推进整局狼人杀，并把每位玩家的发言与裁判播报',
        '实时输出到用户当前对话里。',
        '当用户说「玩狼人杀 / 开一局狼人杀 / 狼人杀模式」时，直接调用 werewolf_start 工具（或在输入框输入 /werewolf）。',
        '人数可选 6 / 8 / 9 / 10 / 11 / 12（12 为 4 狼 + 预言家·女巫·猎人·白痴 + 4 民的屠边标准局，含警长竞选）。',
        '对局开始后你不需要复述发言内容（它们已经直接出现在对话里），只需简短说明如何查看进度或结束对局。',
        '每局结束时会自动导出 Markdown 对局记录；用户想再导一次或换路径时用 werewolf_export。',
        `（插件构建标记：${BUILD}）`,
      ].join(''),
  })

  // --- 工具 1：开一局。
  ctx.tools.register({
    name: 'werewolf_start',
    description:
      '启动一局 AI 狼人杀：由裁判随机发牌给若干位玩家 AI，自动完成夜晚/白天讨论/投票的完整对局，并把每位玩家的发言与裁判播报实时输出到当前对话。开局需要一点时间（所有 AI 入座），之后对局在后台自动推进。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        seats: {
          type: 'integer',
          description: '玩家人数，可选 6/8/9/10/11/12；12 为标准局（4 狼 + 预言家·女巫·猎人·白痴 + 4 民，屠边，含警长竞选）。省略则用配置默认值。',
        },
        godView: {
          type: 'boolean',
          description: '是否在对话里公布「上帝视角」身份表（默认 true，方便围观；设为 false 则连你也不知道各人身份）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'seats', 'board', 'roster', 'note'],
        properties: {
          status: { type: 'string' },
          seats: { type: 'integer' },
          board: { type: 'string' },
          roster: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `【狼人杀已开局】${value.board}\n座位：${value.roster}\n${value.note}` }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('werewolf_start 必须在某个 Agent 会话中调用')
      const result = await startGame({
        ctx,
        agent: exec.agent,
        config: settings,
        logger,
        games,
        seats: args?.seats,
        godView: args?.godView,
      })
      return result
    },
    presentCall: (args) => ({ card: 'generic', title: '开始一局狼人杀', kind: 'other', rawInput: args }),
  })

  // --- 工具 2：查看进度。
  ctx.tools.register({
    name: 'werewolf_status',
    description: '查看当前会话里这局狼人杀的进度：天数、阶段、存活/出局名单、上帝视角身份表与最近的公开播报。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: statusRender,
    },
    async execute(_args, exec) {
      const sessionId = exec.agent?.session?.id
      const entry = typeof sessionId === 'string' ? games.get(sessionId) : undefined
      if (entry === undefined) return { text: `当前会话没有正在进行的狼人杀对局（插件构建：${BUILD}）。可以用 werewolf_start 或 /werewolf 开一局。` }
      const status = entry.game.status()
      const lines = [
        `对局：${status.board}`,
        `插件构建：${BUILD}`,
        `进度：第 ${status.day} 天 · 阶段 ${status.phase}${status.winner === null ? '' : ` · 胜方 ${status.winner === 'wolves' ? '狼人' : '好人'}`}`,
        `存活：${status.alive.map((seat) => `${seat}号`).join('、') || '无'}`,
        `出局：${status.dead.map((seat) => `${seat}号`).join('、') || '无'}`,
        `警长：${status.sheriffEnabled === true ? (status.sheriff === null ? '尚未选出 / 本局无警长' : `${status.sheriff}号（票权 1.5）`) : '本局不设警长'}`,
      ]
      if (Array.isArray(status.godView)) {
        lines.push(`身份（上帝视角）：${status.godView.map((row) => `${row.seat}号 ${row.label}${row.alive ? '' : '(出局)'}`).join('｜')}`)
      }
      if (entry.finished === true) {
        lines.push('本局已结束，可用 werewolf_export 把完整对局导出为 Markdown 文档。')
      }
      lines.push('最近播报：', ...(status.recent ?? []).slice(-5))
      return { text: lines.join('\n') }
    },
  })

  // --- 工具 3：导出 Markdown。
  ctx.tools.register({
    name: 'werewolf_export',
    description:
      '把当前（或刚结束的）这局狼人杀导出为 Markdown 文档：包含身份表、放逐投票表、按天/夜分节的全部发言与裁判播报，以及上帝视角的夜间行动明细。默认写到会话工作目录下的 werewolf-logs/。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: '可选：目标目录或 .md 文件路径（相对路径按会话工作目录解析）。省略则用配置 exportDir（默认 werewolf-logs/）。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'path', 'bytes', 'lines'],
        properties: {
          text: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          lines: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('werewolf_export 必须在某个 Agent 会话中调用')
      const sessionId = exec.agent.session?.id
      const entry = typeof sessionId === 'string' ? games.get(sessionId) : undefined
      if (entry === undefined) {
        throw new Error('当前会话没有可导出的狼人杀对局（对局记录只保留最近一局）。')
      }
      const saved = saveReport({ agent: exec.agent, game: entry.game, config: settings, target: args?.path })
      return {
        text: `已导出对局记录：${saved.path}\n（${saved.lines} 行 / ${saved.bytes} 字节，包含身份表、投票表、全部发言与上帝视角夜间行动）`,
        path: saved.path,
        bytes: saved.bytes,
        lines: saved.lines,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '导出狼人杀对局记录', kind: 'other', rawInput: args }),
  })

  // --- 工具 4：结束对局。
  ctx.tools.register({
    name: 'werewolf_stop',
    description: '立即结束当前会话里正在进行的狼人杀对局，并中断所有裁判/玩家 AI。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: statusRender,
    },
    async execute(_args, exec) {
      const sessionId = exec.agent?.session?.id
      const entry = typeof sessionId === 'string' ? games.get(sessionId) : undefined
      if (entry === undefined) return { text: '当前会话没有正在进行的狼人杀对局。' }
      entry.game.stop()
      await entry.table.stop()
      // 保留这一局：仍可用 werewolf_export 把已产生的记录导出。
      entry.finished = true
      return { text: '已结束本局狼人杀并中断所有 AI。可用 werewolf_export 导出已产生的对局记录。' }
    },
  })

  // --- 工具 5：观众插话（可选）。
  ctx.tools.register({
    name: 'werewolf_say',
    description:
      '在正在进行的狼人杀对局里插入一句「观众发言」：它会显示在对话里，并进入所有 AI 能看到的公开信息，影响后续发言。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', description: '要插入的内容' } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: statusRender,
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id
      const entry = typeof sessionId === 'string' ? games.get(sessionId) : undefined
      if (entry === undefined) return { text: '当前会话没有正在进行的狼人杀对局。' }
      const body = String(args?.text ?? '').trim()
      if (body === '') throw new Error('werewolf_say 需要非空的 text')
      entry.game.emit(`【观众】${body}`)
      return { text: '已插入观众发言，后续发言会看到它。' }
    },
  })

  // --- 斜杠命令：/werewolf [人数]
  ctx.commands.register({
    name: 'werewolf',
    description: '开一局 AI 狼人杀（参数为人数，如 /werewolf 8）',
    input: { hint: '人数，例如 8' },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim()
      const seats = raw === '' ? undefined : Number(raw)
      if (seats !== undefined && (!Number.isFinite(seats) || seats < 6 || seats > 12)) {
        return { kind: 'error', text: '人数需要在 6~12 之间，例如 /werewolf 8。' }
      }
      try {
        const result = await startGame({
          ctx,
          agent: invocation.agent,
          config: settings,
          logger,
          games,
          seats,
          godView: true,
        })
        return {
          kind: 'success',
          text: `【狼人杀已开局】${result.board}\n座位：${result.roster}\n${result.note}`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // --- 卸载时收尾：结束所有对局。
  return async () => {
    for (const [sessionId, entry] of [...games.entries()]) {
      entry.game.stop()
      try {
        await entry.table.stop()
      } catch {
        /* 忽略 */
      }
      games.delete(sessionId)
    }
  }
}

export { ROLE_LABEL, resolveBoard }
