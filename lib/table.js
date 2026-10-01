/**
 * 子智能体牌桌：把「裁判 + N 位玩家」实现为真实的 DSH 子智能体。
 *
 * 设计要点（第一版踩过的坑）：
 *   可继续子智能体（startContinuable）在空闲后会被管理器中 dispose，
 *   `ctx.agents.get(childId)` 随即返回 undefined，于是「投递一轮、等它回复」
 *   的写法第二轮就会失败。
 *
 * 这里改为**一次性运行**：每次发言 = `ctx.subagents.start('spawn', …)`，
 * `run.result` 直接 resolve 该子智能体这一轮的最终 assistant 输出。
 * 每位玩家的身份连续性由提示词承载（真实身份 + 私有信息 + 全部公开发言），
 * 因此每一轮都是「一个独立 AI 听完所有人的发言之后再开口」。
 *
 * 子智能体被 `toolFilter: { allow: [] }` 完全屏蔽工具：它们只会说话。
 */

import { randomUUID } from 'node:crypto'

/** 提取 ContentBlock[] 里的纯文本。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 给一个 promise 加超时，超时时先释放子运行。 */
function withTimeout(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        /* 忽略 */
      }
      reject(new Error(`AI 本回合超时（${Math.round(ms / 1000)}s）`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 一副由子智能体组成的牌桌。
 */
export class SubagentTable {
  /**
   * @param {object} input - 依赖
   * @param {object} input.ctx - 插件上下文（需要 ctx.subagents / ctx.on）
   * @param {object} input.agent - 调用方 Agent（主会话），作为所有子智能体的父级
   * @param {object} [input.config] - 插件配置
   * @param {object} [input.logger] - 日志器
   */
  constructor({ ctx, agent, config = {}, logger }) {
    this.ctx = ctx
    this.agent = agent
    this.config = config
    this.logger = logger
    this.controller = new AbortController()
    /** 正在运行的子智能体句柄，用于 stop() / 超时时统一释放。 */
    this.runs = new Set()
    this.closed = false
    this.disposers = []
  }

  /** 单轮超时（毫秒）。 */
  get timeoutMs() {
    const ms = Number(this.config.turnTimeoutMs ?? 300000)
    return Number.isFinite(ms) && ms > 5000 ? ms : 300000
  }

  /**
   * 跑一次子智能体：投递提示词，取回这一轮的最终发言。
   * @param {string} label - 子智能体显示标签
   * @param {string} prompt - 提示词
   * @returns {Promise<string>} 发言文本
   */
  async run(label, prompt) {
    if (this.closed) throw new Error('牌桌已关闭')
    const request = {
      prompt: [{ type: 'text', text: prompt }],
      parent: this.agent,
      signal: this.controller.signal,
      toolFilter: { allow: [] },
    }
    if (this.config.reasoningEffort !== undefined && this.config.reasoningEffort !== '') {
      request.agentOptions = { reasoningEffort: this.config.reasoningEffort }
    }
    const handle = await this.ctx.subagents.start('spawn', request)
    this.runs.add(handle)
    try {
      const result = await withTimeout(handle.result, this.timeoutMs, () => {
        void handle.dispose().catch(() => {})
      })
      const text = textOfContent(result?.output)
      if (text === '') this.logger?.warn?.(`[dsh-werewolf] ${label} 未产出文本（stopReason=${result?.stopReason ?? 'unknown'}）`)
      return text
    } finally {
      this.runs.delete(handle)
      try {
        await handle.dispose()
      } catch {
        /* 忽略释放异常 */
      }
    }
  }

  /**
   * 向玩家要一轮发言。
   * @param {number} seat - 座位
   * @param {string} prompt - 指令
   * @returns {Promise<string>} 发言文本
   */
  async ask(seat, prompt) {
    return await this.run(`${seat}号玩家`, prompt)
  }

  /**
   * 向裁判要一段播报。
   * @param {string} prompt - 指令
   * @returns {Promise<string>} 播报文本
   */
  async judge(prompt) {
    return await this.run('裁判', prompt)
  }

  /**
   * 把一段文本发布到用户对话框（作为一条系统通知）。
   *
   * 两条硬约束决定了这里必须走 `agent.inject()`，不能直接 `session.append()`：
   *
   * 1. 会话格式 v4 规定 `assistant/message` 必须落在「已打开的 turn/step」内并携带模型
   *    stream。插件在回合之外只能伪造它——伪造会让整份日志在重放时判定为损坏
   *    （`assistant/message does not match an open turn and step`），并让 token-meter
   *    投影在读取 `stream` 时抛错。回合之外唯一合法的可见载荷是 `user/message`。
   * 2. 但直接 append（无论 assistant 还是 user）都会踩到第二个坑：对局在后台推进，
   *    播报可能正好落在一次工具调用与它的 tool/result 之间——`werewolf_start` 执行期间
   *    裁判开场白就是这种情况。模型路由要求带 `tool_use` 的 assistant 消息后面**紧跟**
   *    携带 `tool_result` 的消息，夹在中间的消息会让整个请求被拒
   *    （`tool_use ids were found without tool_result blocks immediately after`）。
   *
   * `agent.inject()` 把消息投进 Agent 的 next-step 收件箱（合法的
   * `agent/inbox/spliced` 事件，界面立即显示），由 Agent 循环在下一个 step 边界统一
   * 追加为 surface 消息，因此永远不会夹在工具调用与其结果之间。
   * @param {string} text - 文本
   * @returns {void}
   */
  emit(text) {
    const agent = this.agent
    if (agent?.session === undefined) return
    const body = String(text ?? '').trim()
    if (body === '') return
    if (typeof agent.inject !== 'function') {
      this.logger?.warn?.('[dsh-werewolf] agent.inject 不可用，本段播报已丢弃')
      return
    }
    agent.inject({
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: {
        kind: 'dsh-werewolf',
        form: 'notice',
        summary: body.length <= 120 ? body : `${body.slice(0, 119)}…`,
      },
    })
  }

  /**
   * 关闭牌桌：中止并释放所有子智能体。
   * @returns {Promise<void>} 完成
   */
  async stop() {
    if (this.closed) return
    this.closed = true
    this.controller.abort()
    const pending = [...this.runs]
    this.runs.clear()
    for (const handle of pending) {
      try {
        await handle.dispose()
      } catch {
        /* 忽略 */
      }
    }
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    this.disposers = []
  }
}
