/**
 * 狼人杀对局引擎：状态机 + 裁判流程。
 *
 * 引擎只做两件与外部有关的事，其余全是纯逻辑：
 *   - `ask(seat, prompt)`：向某位玩家 AI 要一段回复（子智能体的一轮）
 *   - `emit(text)`：把一段**要显示给用户**的文本推入对话（裁判播报 / 玩家发言）
 *
 * 因此引擎可以脱离 DSH 用脚本化的 ask/emit 单测（见 `test/dry-run.mjs`）。
 */

import { randomUUID } from 'node:crypto'

/** 入口 URL 上的 `?v=` 会透传给子模块，避免 ESM 按 URL 缓存拿到旧代码。 */
const CACHE_KEY = new URL(import.meta.url).search

const { resolveBoard, assignRoles, tallyVotes, resolveNight, checkWin, canShoot, GOD_ROLES, ROLE_LABEL } = await import(
  `./rules.js${CACHE_KEY}`
)
const {
  playerBriefing,
  speechPrompt,
  votePrompt,
  pkPrompt,
  wolfNightPrompt,
  seerPrompt,
  witchPrompt,
  guardPrompt,
  hunterPrompt,
  lastWordsPrompt,
  judgePrompt,
  judgeFinalPrompt,
  privateInfo,
  label,
  sheriffCampaignPrompt,
  sheriffSpeechPrompt,
  sheriffVotePrompt,
  sheriffRunoffPrompt,
  sheriffDirectionPrompt,
  sheriffTransferPrompt,
} = await import(`./prompts.js${CACHE_KEY}`)

/** 引擎内部的中止异常。 */
export class GameAborted extends Error {
  constructor(reason = '游戏已中止') {
    super(reason)
    this.name = 'GameAborted'
  }
}

/**
 * 从文本里解析一个座位号标记。
 * @param {string} text - 玩家回复
 * @param {string[]} tags - 可能的标记名，如 ['投票','归票']
 * @returns {number|null} 座位号；null 表示没解析到
 */
function parseSeat(text, tags) {
  for (const tag of tags) {
    const match = new RegExp(`【${tag}】\\s*(\\d{1,2})\\s*号?`).exec(text ?? '')
    if (match !== null) {
      const seat = Number(match[1])
      if (Number.isInteger(seat) && seat > 0) return seat
    }
  }
  return null
}

/**
 * 解析狼刀标记，支持「空刀」。
 * @param {string} text - 回复
 * @returns {number|null|'empty'} 座位号、null（未解析到）或 'empty'（空刀）
 */
function parseWolfTarget(text) {
  const body = text ?? ''
  if (/【狼刀】\s*空刀/.test(body) || /空刀/.test(body)) return 'empty'
  return parseSeat(body, ['狼刀', '刀人', '击杀'])
}

/**
 * 解析女巫用药。
 * @param {string} text - 回复
 * @returns {{type:'none'|'save'|'poison', target:number|null}} 用药决定
 */
function parseWitchAction(text) {
  const body = text ?? ''
  const line = /【女巫】([^\n]*)/.exec(body)?.[1] ?? body
  if (/毒/.test(line)) {
    const target = parseSeat(body, ['女巫']) ?? null
    const match = /(\d{1,2})\s*号/.exec(line)
    const seat = match === null ? target : Number(match[1])
    return { type: 'poison', target: Number.isInteger(seat) && seat > 0 ? seat : target }
  }
  if (/救|解药/.test(line)) return { type: 'save', target: null }
  return { type: 'none', target: null }
}

/** 从一组候选中随机取一个（用注入的 rng，便于测试）。 */
function pickRandom(list, rng) {
  return list[Math.floor(rng() * list.length)]
}

/**
 * 一局狼人杀。
 */
export class WerewolfGame {
  /**
   * @param {object} input - 依赖注入
   * @param {number|string|object} [input.boardSpec] - 板子
   * @param {object} [input.options] - 规则开关
   * @param {(seat:number, prompt:string)=>Promise<string>} input.ask - 向玩家要一轮回复
   * @param {(prompt:string)=>Promise<string>} input.judge - 向裁判要一段播报
   * @param {(text:string)=>void} input.emit - 发布文本到用户对话
   * @param {AbortSignal} [input.signal] - 中止信号
   * @param {() => number} [input.rng] - 随机源
   */
  constructor({ boardSpec = 12, options = {}, ask, judge, emit, signal, rng = Math.random }) {
    if (typeof ask !== 'function') throw new Error('WerewolfGame 需要 ask(seat, prompt)')
    if (typeof emit !== 'function') throw new Error('WerewolfGame 需要 emit(text)')
    this.board = resolveBoard(boardSpec)
    this.options = {
      winCondition: options.winCondition ?? this.board.win,
      witchSelfSave: options.witchSelfSave ?? 'first-night',
      guardSelfGuard: options.guardSelfGuard ?? true,
      sameGuardSameSaveDies: options.sameGuardSameSaveDies ?? true,
      hunterShootWhenPoisoned: options.hunterShootWhenPoisoned ?? false,
      firstNightLastWordsOnly: options.firstNightLastWordsOnly ?? true,
      maxDays: options.maxDays ?? 30,
      godView: options.godView ?? true,
      sheriff: options.sheriff,
    }
    // 警长竞选：默认「人多才开」（>= 9 人），可用 sheriff: true/false 强制开关。
    this.sheriffEnabled =
      this.options.sheriff === true || (this.options.sheriff !== false && this.board.seats >= 9)
    this.ask = ask
    this.judgeFn = typeof judge === 'function' ? judge : null
    this.emitRaw = emit
    this.signal = signal
    this.rng = rng
    this.stopped = false
    this.phase = 'setup'
    this.winner = null
    this.day = 1
    /** 连续无响应的 AI 次数（用于整体失败保护）。 */
    this.askFailures = 0
    this.id = randomUUID()
    /** @type {Array<{seat:number, role:string, alive:boolean, votable:boolean, revealedIdiot:boolean, cause:string|null, deathDay:number|null}>} */
    this.players = []
    this.potions = { antidote: true, poison: true }
    this.lastGuardTarget = null
    this.seerChecks = []
    /** 警长座位（null = 本局无警长）。 */
    this.sheriffSeat = null
    /** 是否已经进行过警长竞选。 */
    this.sheriffElectionDone = false
    /** @type {string[]} 公开文本（裁判播报 + 玩家发言），用于拼接公开发言上下文 */
    this.publicLines = []
    /** @type {Array<{day:number, phase:string, text:string}>} 带阶段信息的完整时间线（供导出 Markdown） */
    this.timeline = []
    /** @type {Array<object>} 每晚的上帝视角行动明细（供导出附录） */
    this.nightLog = []
    /** @type {Array<object>} 每次放逐投票的统计（供导出表格） */
    this.voteLog = []
    /** 对局开始时间。 */
    this.startedAt = new Date()
    /** 对局结束时间（未结束为 null）。 */
    this.finishedAt = null
  }

  /** 中止检查：每个 await 边界调用。 */
  #checkAbort() {
    if (this.stopped || this.signal?.aborted === true) throw new GameAborted()
  }

  /** 发布一段文本（裁判播报/发言）：记录并推入对话。 */
  emit(text) {
    const body = String(text ?? '').trim()
    if (body === '') return
    this.publicLines.push(body)
    if (this.publicLines.length > 200) this.publicLines.splice(0, this.publicLines.length - 200)
    this.timeline.push({ day: this.day, phase: this.phase, text: body })
    try {
      this.emitRaw(body)
    } catch {
      // 发布失败不影响对局推进（完整文本仍保存在 publicLines / status 里）
    }
  }

  /** 给模型看的公开信息摘要。 */
  get publicDigest() {
    const lines = this.publicLines.slice(-45)
    return lines.length === 0 ? '（暂无公开发言）' : lines.join('\n')
  }

  /** 存活玩家。 */
  get alivePlayers() {
    return this.players.filter((player) => player.alive)
  }

  /**
   * 开局：随机发牌、公布座位表与上帝视角（可关）。
   * @returns {Promise<void>} 完成
   */
  /**
   * 随机发牌（幂等：已有玩家则直接返回），供「先发牌、再按身份创建子智能体」使用。
   * @returns {ReadonlyArray<object>} 玩家列表
   */
  prepare() {
    if (this.players.length > 0) return this.players
    const roles = assignRoles(this.board, this.rng)
    this.players = [...roles.entries()]
      .map(([seat, role]) => ({ seat, role, alive: true, votable: true, revealedIdiot: false, cause: null, deathDay: null }))
      .sort((left, right) => left.seat - right.seat)
    return this.players
  }

  async setup() {
    this.prepare()
    const sheriffNote = this.sheriffEnabled ? '本局有警长竞选（第 1 天白天上警投票，警长票权 1.5）' : '本局无警长'
    this.emit(`【裁判】欢迎来到 ${this.board.label}。共 ${this.board.seats} 位玩家入座，${sheriffNote}。`)
    // 上帝视角身份表：只在开启 godView 时公布（关掉后连用户也不知道各人身份）。
    if (this.options.godView !== false) {
      this.emit(
        `【裁判·身份表（上帝视角，仅你可见）】\n${this.players
          .map((player) => `${player.seat}号 ${label(player.role)}`)
          .join('｜')}`,
      )
    }
    const roster = this.players.map((player) => `${player.seat}号`).join('、')
    await this.#judge(
      `请宣布游戏开始：介绍本局为 ${this.board.label}、${sheriffNote}，玩家座位为 ${roster}，然后宣布第一夜开始。`,
      '开局',
    )
  }

  /**
   * 向裁判要一段播报，失败时退回引擎自带的模板文本。
   * @param {string} facts - 必须如实播报的事实
   * @param {string} phase - 阶段名
   * @param {string} fallback - 兜底文本
   * @returns {Promise<void>} 完成
   */
  async #judge(facts, phase, fallback = '') {
    this.#checkAbort()
    if (this.judgeFn === null) {
      if (fallback !== '') this.emit(`【裁判】${fallback}`)
      return
    }
    try {
      const text = await this.judgeFn(judgePrompt({ phase, facts, game: this }))
      const body = String(text ?? '').trim()
      this.emit(`【裁判】${body === '' ? fallback : body}`)
    } catch (error) {
      if (error instanceof GameAborted) throw error
      this.emit(`【裁判】${fallback}`)
    }
  }

  /**
   * 向一位玩家要一轮回复。
   *
   * 单个 AI 卡住/超时不应该毁掉整局：失败时返回空串（后续解析会走兜底策略），
   * 但连续多次失败说明牌桌整体不可用，此时抛错结束对局。
   * @param {number} seat - 座位
   * @param {string} prompt - 指令
   * @returns {Promise<string>} 回复文本
   */
  async #ask(seat, prompt) {
    this.#checkAbort()
    try {
      const text = await this.ask(seat, prompt)
      this.askFailures = 0
      this.#checkAbort()
      return String(text ?? '').trim()
    } catch (error) {
      if (error instanceof GameAborted) throw error
      this.askFailures = (this.askFailures ?? 0) + 1
      const message = error instanceof Error ? error.message : String(error)
      this.emit(`【裁判】${seat}号 AI 本轮无响应（${message}），其行动按默认处理。`)
      if (this.askFailures >= 5) throw new Error(`连续 ${this.askFailures} 位 AI 无响应，本局提前结束`)
      return ''
    }
  }

  /**
   * 判断某座位玩家是否出局。
   * @param {number} seat - 座位
   * @returns {boolean} 是否存活
   */
  isAlive(seat) {
    return this.players.find((player) => player.seat === seat)?.alive === true
  }

  /**
   * 结算一批死亡（去重、记录死因、白痴不适用夜间死亡）。
   * @param {Array<{seat:number, cause:string}>} deaths - 死亡列表
   * @returns {Array<{seat:number, cause:string, role:string}>} 实际死亡
   */
  applyDeaths(deaths) {
    const applied = []
    for (const death of deaths) {
      const player = this.players.find((item) => item.seat === death.seat)
      if (player === undefined || !player.alive) continue
      player.alive = false
      player.votable = false
      player.cause = death.cause
      player.deathDay = this.day
      applied.push({ seat: player.seat, cause: death.cause, role: player.role })
    }
    return applied
  }

  /**
   * 夜间阶段。
   * @returns {Promise<Array<{seat:number, cause:string, role:string}>>} 本夜死亡
   */
  async nightPhase() {
    this.phase = 'night'
    await this.#judge(
      `第 ${this.day} 夜开始。请宣布「天黑请闭眼」，并提示守卫、狼人、预言家、女巫依次行动。不要透露任何身份或行动结果。`,
      '夜晚',
      '天黑请闭眼。守卫、狼人、预言家、女巫依次行动。',
    )

    // 守卫
    let guardTarget = null
    const guard = this.alivePlayers.find((player) => player.role === 'guard')
    if (guard !== undefined) {
      const reply = await this.#ask(guard.seat, guardPrompt({ player: guard, game: this }))
      const parsed = /【守护】\s*空守/.test(reply) ? null : parseSeat(reply, ['守护'])
      const candidates = this.alivePlayers.filter(
        (player) => (player.seat !== guard.seat || this.options.guardSelfGuard) && player.seat !== this.lastGuardTarget,
      )
      guardTarget = parsed !== null && candidates.some((player) => player.seat === parsed) ? parsed : candidates.length === 0 ? null : pickRandom(candidates, this.rng).seat
    }

    // 狼队
    const wolves = this.alivePlayers.filter((player) => player.role === 'wolf')
    const opinions = []
    const wolfVotes = []
    for (const wolf of wolves) {
      const extra = opinions.length === 0 ? '' : `\n\n【狼队当前意见】\n${opinions.join('\n')}`
      const reply = await this.#ask(wolf.seat, wolfNightPrompt({ player: wolf, game: this }) + extra)
      const target = parseWolfTarget(reply)
      opinions.push(`${wolf.seat}号：${reply.replace(/\s+/g, ' ').slice(0, 120)}`)
      wolfVotes.push({ seat: wolf.seat, target: target === 'empty' ? null : target })
    }
    let wolfTarget = null
    if (wolfVotes.some((vote) => vote.target !== null)) {
      const { counts, top } = tallyVotes(wolfVotes.filter((vote) => vote.target !== null))
      const best = top.length > 0 ? top : [...counts.keys()]
      wolfTarget = best.length === 1 ? best[0] : pickRandom(best, this.rng)
    }

    // 预言家
    const seer = this.alivePlayers.find((player) => player.role === 'seer')
    if (seer !== undefined) {
      const reply = await this.#ask(seer.seat, seerPrompt({ player: seer, game: this }))
      const candidates = this.alivePlayers.filter((player) => player.seat !== seer.seat)
      const target = parseSeat(reply, ['查验']) ?? (candidates.length === 0 ? null : pickRandom(candidates, this.rng).seat)
      if (target !== null) {
        const checked = this.players.find((player) => player.seat === target)
        if (checked !== undefined) {
          this.seerChecks.push({ target, result: checked.role === 'wolf' ? 'wolf' : 'good', day: this.day })
        }
      }
    }

    // 女巫
    let witchAction = { type: 'none', target: null }
    const witch = this.alivePlayers.find((player) => player.role === 'witch')
    if (witch !== undefined) {
      const reply = await this.#ask(witch.seat, witchPrompt({ player: witch, game: this, killedTonight: wolfTarget }))
      const parsed = parseWitchAction(reply)
      if (parsed.type === 'save' && this.potions.antidote && wolfTarget !== null) {
        const selfSave = wolfTarget !== witch.seat || this.options.witchSelfSave === 'always' || (this.options.witchSelfSave === 'first-night' && this.day === 1)
        if (selfSave) {
          witchAction = { type: 'save', target: wolfTarget }
          this.potions.antidote = false
        }
      } else if (parsed.type === 'poison' && this.potions.poison && parsed.target !== null && parsed.target !== witch.seat) {
        const victim = this.players.find((player) => player.seat === parsed.target)
        if (victim !== undefined && victim.alive) {
          witchAction = { type: 'poison', target: parsed.target }
          this.potions.poison = false
        }
      }
    }

    this.lastGuardTarget = guardTarget
    const resolution = resolveNight({
      wolfTarget,
      guardTarget,
      witchAction,
      sameGuardSameSaveDies: this.options.sameGuardSameSaveDies,
    })
    const deaths = this.applyDeaths(resolution.deaths)
    this.nightResolution = { wolfTarget, guardTarget, witchAction, resolution }
    this.nightLog.push({
      day: this.day,
      guardTarget,
      wolfTarget,
      witchAction,
      savedByWitch: resolution.saved,
      guarded: resolution.guarded,
      deaths: deaths.map((death) => ({ seat: death.seat, cause: death.cause, role: death.role })),
    })
    return deaths
  }

  /**
   * 天亮：公布死讯 + 首夜遗言 + 猎人开枪。
   * @param {Array<{seat:number, cause:string, role:string}>} deaths - 本夜死亡
   * @returns {Promise<void>} 完成
   */
  async dawnPhase(deaths) {
    this.phase = 'dawn'
    const facts =
      deaths.length === 0
        ? `第 ${this.day} 天天亮，昨晚是平安夜，无人出局。`
        : `第 ${this.day} 天天亮。昨晚出局的玩家是：${deaths.map((death) => `${death.seat}号`).join('、')}。不要说明死因。`
    await this.#judge(facts, '天亮', deaths.length === 0 ? '天亮了，昨晚是平安夜。' : `天亮了。昨晚 ${deaths.map((death) => `${death.seat}号`).join('、')} 出局。`)
    for (const death of deaths) {
      const player = this.players.find((item) => item.seat === death.seat)
      if (player === undefined) continue
      if (player.role === 'hunter' && canShoot(death.cause, this.options)) {
        await this.hunterShoot(player)
      }
      const giveLastWords = !this.options.firstNightLastWordsOnly || this.day === 1
      if (giveLastWords) await this.lastWords(player, death.cause)
    }
    await this.sheriffTransfer()
  }

  /**
   * 猎人开枪（可连锁）。
   * @param {object} player - 猎人
   * @returns {Promise<void>} 完成
   */
  async hunterShoot(player) {
    let shooter = player
    let chain = 0
    while (shooter !== undefined && chain < 3) {
      chain++
      const reply = await this.#ask(shooter.seat, hunterPrompt({ player: shooter, game: this }))
      if (/【开枪】\s*不开/.test(reply)) {
        this.emit(`【裁判】${shooter.seat}号（猎人）选择不开枪。`)
        return
      }
      const candidates = this.alivePlayers.map((item) => item.seat)
      const target = parseSeat(reply, ['开枪']) ?? pickRandom(candidates, this.rng)
      const victim = this.players.find((item) => item.seat === target && item.alive)
      if (victim === undefined) {
        this.emit(`【裁判】${shooter.seat}号（猎人）开枪未命中目标。`)
        return
      }
      this.emit(`【裁判】${shooter.seat}号亮出猎人身份，开枪带走了 ${victim.seat}号。`)
      this.applyDeaths([{ seat: victim.seat, cause: 'skill' }])
      if (victim.role === 'hunter' && canShoot('skill', this.options)) {
        shooter = victim
        continue
      }
      return
    }
  }

  /**
   * 遗言。
   * @param {object} player - 出局玩家
   * @param {string} cause - 死因
   * @returns {Promise<void>} 完成
   */
  async lastWords(player, cause) {
    const text = await this.#ask(player.seat, lastWordsPrompt({ player, game: this, cause }))
    if (text !== '') this.emit(`【${player.seat}号·遗言】\n${text}`)
  }

  /**
   * 计算白天发言顺序。
   * 有警长时由警长决定从左边还是右边开始，且警长本人最后发言归票；
   * 无警长时从首位死者的下一位开始（平安夜则从最小座位起）。
   * @param {number|null} firstDeadSeat - 首位死者座位
   * @returns {Promise<Array<object>>} 发言顺序
   */
  async speechOrder(firstDeadSeat) {
    const n = this.board.seats
    const alive = this.alivePlayers.slice().sort((left, right) => left.seat - right.seat)
    let direction = 'left'
    let startSeat
    const sheriff = alive.find((player) => player.seat === this.sheriffSeat)
    if (sheriff !== undefined) {
      const reply = await this.#ask(sheriff.seat, sheriffDirectionPrompt({ player: sheriff, game: this }))
      direction = /【方向】\s*右/.test(reply) ? 'right' : 'left'
      startSeat = direction === 'right' ? ((sheriff.seat - 2 + n) % n) + 1 : (sheriff.seat % n) + 1
      this.emit(`【裁判】警长 ${sheriff.seat}号 决定从${direction === 'right' ? '右' : '左'}边开始发言（警长最后归票）。`)
    } else {
      startSeat = firstDeadSeat === null ? (alive[0]?.seat ?? 1) : ((firstDeadSeat % n) + 1)
    }
    const ordered = []
    for (let offset = 0; offset < n; offset++) {
      const raw = direction === 'right' ? startSeat - 1 - offset : startSeat - 1 + offset
      const seat = ((raw % n) + n) % n + 1
      const player = alive.find((item) => item.seat === seat)
      if (player !== undefined && !ordered.includes(player)) ordered.push(player)
    }
    if (sheriff !== undefined) {
      const index = ordered.indexOf(sheriff)
      if (index >= 0) ordered.splice(index, 1)
      ordered.push(sheriff)
    }
    return ordered
  }

  /**
   * 警长竞选（上警 → 竞选发言 → 警下投票 → 平票 PK 重投 → 再平票则本局无警长）。
   * 只在第 1 天白天、公布死讯之后进行。
   * @returns {Promise<void>} 完成
   */
  async sheriffElection() {
    if (this.sheriffEnabled !== true || this.sheriffElectionDone) return
    this.sheriffElectionDone = true
    this.phase = 'sheriff'
    await this.#judge(
      '第 1 天警长竞选（上警）开始。请宣布：上警的玩家将公开发表竞选发言，警下玩家投票选出警长；警长有 1.5 票、决定白天发言方向并最后归票。不要透露任何身份。',
      '警长竞选',
      '现在进行警长竞选（上警）。上警的玩家请发表竞选发言，警下玩家投票选出警长。',
    )
    const alive = this.alivePlayers.slice().sort((left, right) => left.seat - right.seat)

    // --- 上警
    const candidates = []
    for (const player of alive) {
      const reply = await this.#ask(player.seat, sheriffCampaignPrompt({ player, game: this }))
      if (/【上警】\s*(是|上警|要|yes|1)/i.test(reply)) {
        candidates.push(player)
        this.emit(`【${player.seat}号】上警。`)
      }
    }
    if (candidates.length === 0) {
      this.emit('【裁判】无人上警，本局没有警长。')
      return
    }
    if (candidates.length === 1) {
      this.sheriffSeat = candidates[0].seat
      this.emit(`【裁判】只有 ${candidates[0].seat}号 上警，自动当选警长（票权 1.5，决定发言方向，最后发言归票）。`)
      return
    }

    // --- 竞选发言
    for (const candidate of candidates) {
      const text = await this.#ask(candidate.seat, sheriffSpeechPrompt({ player: candidate, game: this }))
      this.emit(`【${candidate.seat}号·竞选发言】\n${text}`)
    }

    // --- 警下投票（警上玩家不参与投票）
    const voters = alive.filter((player) => !candidates.includes(player))
    const collect = async (pool) => {
      const votes = []
      for (const voter of voters) {
        const reply = await this.#ask(voter.seat, sheriffVotePrompt({ player: voter, game: this, candidates: pool }))
        let target = parseSeat(reply, ['警长', '警徽'])
        if (target === null || !pool.some((player) => player.seat === target)) target = null
        votes.push({ seat: voter.seat, target })
      }
      return votes
    }
    const describe = (counts) =>
      [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([seat, value]) => `${seat}号${value}票`)
        .join('、') || '全部弃票'

    let pool = candidates
    let { top, counts } = tallyVotes(await collect(pool))
    if (top.length === 0) {
      this.emit('【裁判】警下全部弃票，本局没有警长。')
      return
    }
    if (top.length > 1) {
      this.emit(`【裁判】警长竞选平票：${describe(counts)}。${top.join('、')}号进入 PK 发言。`)
      for (const seat of top) {
        const player = this.players.find((item) => item.seat === seat)
        if (player === undefined) continue
        const text = await this.#ask(seat, sheriffRunoffPrompt({ player, game: this, rivals: top.filter((item) => item !== seat) }))
        this.emit(`【${seat}号·PK发言】\n${text}`)
      }
      pool = this.players.filter((player) => top.includes(player.seat))
      const revote = tallyVotes(await collect(pool))
      top = revote.top
      counts = revote.counts
      if (top.length !== 1) {
        this.emit('【裁判】警长竞选重投仍然平票，本局没有警长。')
        return
      }
    }
    this.sheriffSeat = top[0]
    this.emit(`【裁判】${top[0]}号 当选警长（${describe(counts)}）。警长票权 1.5，决定白天发言方向，最后发言归票。`)
  }

  /**
   * 警长出局时移交警徽或撕掉警徽。
   * @returns {Promise<void>} 完成
   */
  async sheriffTransfer() {
    if (this.sheriffSeat === null) return
    const holder = this.players.find((player) => player.seat === this.sheriffSeat)
    if (holder !== undefined && holder.alive) return
    if (holder === undefined) {
      this.sheriffSeat = null
      return
    }
    const reply = await this.#ask(holder.seat, sheriffTransferPrompt({ player: holder, game: this }))
    if (/【警徽】\s*(撕|不|放弃)/.test(reply)) {
      this.emit(`【裁判】${holder.seat}号 撕掉警徽，本局不再有警长。`)
      this.sheriffSeat = null
      return
    }
    const target = parseSeat(reply, ['警徽'])
    const successor = target === null ? undefined : this.players.find((player) => player.seat === target && player.alive)
    if (successor === undefined) {
      this.emit(`【裁判】${holder.seat}号 未成功移交警徽，本局不再有警长。`)
      this.sheriffSeat = null
      return
    }
    this.sheriffSeat = successor.seat
    this.emit(`【裁判】${holder.seat}号 把警徽移交给 ${successor.seat}号。`)
  }

  /** 放逐投票的票权：警长 1.5 票。 */
  get voteWeights() {
    return this.sheriffSeat === null ? new Set() : new Set([this.sheriffSeat])
  }

  /**
   * 白天：发言 → 投票 → 放逐结算。
   * @param {number|null} firstDeadSeat - 首位死者座位（决定发言起始位）
   * @returns {Promise<void>} 完成
   */
  async dayPhase(firstDeadSeat) {
    this.phase = 'speech'
    const ordered = await this.speechOrder(firstDeadSeat)
    // 发言顺序是确定性信息，由引擎直接播报：既省一次 AI 调用，
    // 也避免裁判在「天亮」播报之后又重复一次「天亮了」。
    this.emit(`【裁判】第 ${this.day} 天发言阶段开始，发言顺序：${ordered.map((player) => `${player.seat}号`).join(' → ')}。`)
    for (const player of ordered) {
      this.#checkAbort()
      if (!player.alive) continue
      const text = await this.#ask(player.seat, speechPrompt({ player, game: this }))
      this.emit(`【${player.seat}号·${player.revealedIdiot ? '白痴（已翻牌）' : '玩家'}发言】\n${text}`)
      player.lastSpeech = text
    }
    await this.votePhase()
  }

  /**
   * 投票阶段：统计 → 平票 PK → 再平票无人出局。
   * @returns {Promise<void>} 完成
   */
  async votePhase() {
    this.phase = 'vote'
    const voters = this.alivePlayers.filter((player) => player.votable)
    const collect = async (candidates) => {
      const votes = []
      for (const voter of voters) {
        const allowed = candidates ?? this.alivePlayers.map((player) => player.seat)
        const reply =
          candidates === undefined
            ? await this.#ask(voter.seat, votePrompt({ player: voter, game: this }))
            : await this.#ask(
                voter.seat,
                `平票重投阶段。你（${voter.seat}号）只能在 ${candidates.join('、')} 号之间选择。${privateInfo(voter, this)}\n\n只输出一行：【投票】N号。`,
              )
        let target = parseSeat(reply, ['投票', '归票'])
        if (target !== null && !allowed.includes(target) && target !== voter.seat) target = null
        if (target === voter.seat && candidates !== undefined) target = null
        votes.push({ seat: voter.seat, target })
      }
      return votes
    }

    let votes = await collect()
    let { top, counts } = tallyVotes(votes, this.voteWeights)
    this.voteLog.push({
      day: this.day,
      round: 1,
      votes: votes.map((vote) => ({ seat: vote.seat, target: vote.target })),
      counts: [...counts.entries()].map(([seat, weight]) => ({ seat, weight })).sort((a, b) => b.weight - a.weight),
      top: top.slice(),
    })
    const summary = () =>
      [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([seat, value]) => `${seat}号${value}票`)
        .join('、') || '全部弃票'

    if (top.length === 0) {
      await this.#judge(`第 ${this.day} 天投票结果：所有玩家弃票，本轮无人出局。`, '投票结果', `投票结束：${summary()}，本轮无人出局。`)
      return
    }
    if (top.length > 1) {
      this.emit(`【裁判】投票出现平票：${summary()}。${top.join('、')}号进入 PK 发言。`)
      for (const seat of top) {
        const player = this.players.find((item) => item.seat === seat)
        if (player === undefined || !player.alive) continue
        const rivals = top.filter((item) => item !== seat)
        const text = await this.#ask(seat, pkPrompt({ player, game: this, rivals }))
        this.emit(`【${seat}号·PK发言】\n${text}`)
      }
      votes = await collect(top)
      const revote = tallyVotes(votes, this.voteWeights)
      top = revote.top
      counts = revote.counts
      this.voteLog.push({
        day: this.day,
        round: 2,
        votes: votes.map((vote) => ({ seat: vote.seat, target: vote.target })),
        counts: [...counts.entries()].map(([seat, weight]) => ({ seat, weight })).sort((a, b) => b.weight - a.weight),
        top: top.slice(),
      })
      if (top.length !== 1) {
        await this.#judge(`第 ${this.day} 天重投仍然平票，本轮无人出局。`, '投票结果', `重投仍然平票，本轮无人出局。`)
        return
      }
    }
    const exiled = this.players.find((item) => item.seat === top[0])
    if (exiled === undefined) return
    if (exiled.role === 'idiot' && !exiled.revealedIdiot) {
      exiled.revealedIdiot = true
      exiled.votable = false
      this.emit(`【裁判】${exiled.seat}号亮出白痴身份，翻牌免死，本轮不放逐，但从此失去投票权（仍可发言）。`)
      await this.#judge(`第 ${this.day} 天投票：${exiled.seat}号被投出，但他是白痴，翻牌免死，本轮无人真正出局。`, '投票结果')
      return
    }
    this.emit(`【裁判】投票结果：${summary()}。${exiled.seat}号被放逐出局。`)
    this.applyDeaths([{ seat: exiled.seat, cause: 'vote' }])
    await this.#judge(`第 ${this.day} 天投票结果：${summary()}，${exiled.seat}号被投票放逐出局。不要说明他的身份。`, '投票结果')
    if (exiled.role === 'hunter' && canShoot('vote', this.options)) await this.hunterShoot(exiled)
    await this.lastWords(exiled, 'vote')
    await this.sheriffTransfer()
  }

  /**
   * 完整对局循环。
   * @returns {Promise<{winner:'good'|'wolves'|null, day:number, roles:Array<{seat:number, role:string}>}>} 结局
   */
  async run() {
    await this.setup()
    let winner = null
    while (winner === null && this.day <= this.options.maxDays) {
      this.#checkAbort()
      const nightDeaths = await this.nightPhase()
      this.#checkAbort()
      winner = checkWin(this.players, { win: this.options.winCondition, gods: this.board.gods, villagers: this.board.villagers })
      if (winner !== null) break
      await this.dawnPhase(nightDeaths)
      winner = checkWin(this.players, { win: this.options.winCondition, gods: this.board.gods, villagers: this.board.villagers })
      if (winner !== null) break
      // 第 1 天：公布死讯之后、白天发言之前进行警长竞选。
      if (this.day === 1) await this.sheriffElection()
      const firstDead = nightDeaths.length > 0 ? nightDeaths[0].seat : null
      await this.dayPhase(firstDead)
      winner = checkWin(this.players, { win: this.options.winCondition, gods: this.board.gods, villagers: this.board.villagers })
      if (winner === null) this.day++
    }
    this.winner = winner
    this.phase = 'over'
    this.finishedAt = new Date()
    const roleTable = this.players.map((player) => `${player.seat}号 ${label(player.role)}${player.alive ? '' : '（出局）'}`).join('｜')
    if (winner === null) {
      this.emit(`【裁判】达到最大天数仍未分出胜负，本局判和。\n【真实身份表】${roleTable}`)
    } else if (this.judgeFn !== null) {
      try {
        const text = await this.judgeFn(judgeFinalPrompt({ game: this, winner, facts: roleTable }))
        this.emit(`【裁判·终局】\n${String(text ?? '').trim()}`)
      } catch (error) {
        if (error instanceof GameAborted) throw error
        this.emit(`【裁判】游戏结束：${winner === 'wolves' ? '狼人阵营' : '好人阵营'}获胜。\n【真实身份表】${roleTable}`)
      }
    } else {
      this.emit(`【裁判】游戏结束：${winner === 'wolves' ? '狼人阵营' : '好人阵营'}获胜。\n【真实身份表】${roleTable}`)
    }
    return { winner, day: this.day, roles: this.players.map((player) => ({ seat: player.seat, role: player.role })) }
  }

  /** 停止对局。 */
  stop() {
    this.stopped = true
  }

  /**
   * 当前状态快照（给 werewolf_status 工具）。
   * @returns {object} 状态
   */
  status() {
    const alive = this.alivePlayers.map((player) => player.seat)
    const dead = this.players.filter((player) => !player.alive).map((player) => player.seat)
    return {
      id: this.id,
      board: this.board.label,
      day: this.day,
      phase: this.phase,
      winner: this.winner,
      alive,
      dead,
      sheriff: this.sheriffSeat,
      sheriffEnabled: this.sheriffEnabled,
      godView: this.options.godView
        ? this.players.map((player) => ({ seat: player.seat, role: player.role, label: ROLE_LABEL[player.role], alive: player.alive }))
        : undefined,
      recent: this.publicLines.slice(-8),
    }
  }
}

/** 神职座位（供工具展示）。 */
export function godSeats(game) {
  return game.players.filter((player) => GOD_ROLES.includes(player.role)).map((player) => player.seat)
}

export { playerBriefing }
