/**
 * 狼人杀规则核心（纯函数，无副作用、无 IO）。
 *
 * 规则依据《狼人杀规则规格书》整理，默认对齐「网易官方 12 人标准场」的
 * 核心约定，并把桌规差异做成可配置项：
 *   - 女巫自救：witchSelfSave = 'first-night' | 'always' | 'never'
 *   - 守卫自守：guardSelfGuard = true
 *   - 同守同救：sameGuardSameSaveDies = true（奶死）
 *   - 猎人被毒不可开枪：hunterShootWhenPoisoned = false
 *   - 胜负：winCondition = 'side'（屠边）| 'eliminate'（屠城）
 *   - 平票：tieRule = 'pk'（PK 后重投，再平票无人出局）| 'no-elimination'
 *
 * 本文件不做任何 LLM 调用，可脱离 DSH 独立单测。
 */

/** 角色中文名。 */
export const ROLE_LABEL = Object.freeze({
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  idiot: '白痴',
  villager: '平民',
})

/** 属于「神职」的角色（警长不计入神职）。 */
export const GOD_ROLES = Object.freeze(['seer', 'witch', 'hunter', 'guard', 'idiot'])

/** 属于狼人阵营的角色。 */
export const WOLF_ROLES = Object.freeze(['wolf'])

/**
 * 内置板子。gods 顺序即发牌顺序，villagers 为平民数量。
 * win: 'side' = 屠边（神全灭或民全灭）；'eliminate' = 屠城（好人全灭）。
 */
export const BOARDS = Object.freeze({
  6: { label: '6 人局（2 狼 / 预言家·女巫 / 2 民）', wolves: 2, gods: ['seer', 'witch'], villagers: 2, win: 'eliminate' },
  8: { label: '8 人局（3 狼 / 预言家·女巫·猎人 / 2 民）', wolves: 3, gods: ['seer', 'witch', 'hunter'], villagers: 2, win: 'eliminate' },
  9: { label: '9 人局（3 狼 / 预言家·女巫·猎人 / 3 民）', wolves: 3, gods: ['seer', 'witch', 'hunter'], villagers: 3, win: 'eliminate' },
  10: { label: '10 人局（3 狼 / 预言家·女巫·猎人 / 4 民）', wolves: 3, gods: ['seer', 'witch', 'hunter'], villagers: 4, win: 'side' },
  11: { label: '11 人局（3 狼 / 预言家·女巫·猎人·守卫 / 4 民）', wolves: 3, gods: ['seer', 'witch', 'hunter', 'guard'], villagers: 4, win: 'side' },
  12: { label: '12 人标准局（4 狼 / 预言家·女巫·猎人·白痴 / 4 民，屠边）', wolves: 4, gods: ['seer', 'witch', 'hunter', 'idiot'], villagers: 4, win: 'side' },
  12.5: { label: '12 人进阶局（3 狼 / 预言家·女巫·猎人·守卫 / 4 民，屠边）', wolves: 3, gods: ['seer', 'witch', 'hunter', 'guard'], villagers: 4, win: 'side' },
})

/**
 * 解析板子规格。
 * @param {number|string|undefined} spec - 人数（6/8/9/10/11/12），或 'standard'、或自定义对象。
 * @returns {{seats:number, wolves:number, gods:string[], villagers:number, win:'side'|'eliminate', label:string}} 板子
 */
export function resolveBoard(spec) {
  if (spec !== undefined && spec !== null && typeof spec === 'object') {
    const gods = Array.isArray(spec.gods) ? spec.gods.slice() : ['seer', 'witch', 'hunter']
    for (const role of gods) {
      if (!(role in ROLE_LABEL)) throw new Error(`未知神职角色：${role}`)
    }
    const wolves = Number(spec.wolves ?? 3)
    const villagers = Number(spec.villagers ?? 3)
    const seats = wolves + gods.length + villagers
    return { seats, wolves, gods, villagers, win: spec.win === 'side' ? 'side' : 'eliminate', label: spec.label ?? `自定义 ${seats} 人局` }
  }
  const key = spec === undefined || spec === null || spec === '' ? 12 : spec === 'standard' ? 12 : Number(spec)
  if (!(key in BOARDS)) {
    throw new Error(`不支持的板子人数：${String(spec)}（可选：${Object.keys(BOARDS).join(' / ')}，或传 {wolves,gods,villagers}）`)
  }
  const board = BOARDS[key]
  return {
    seats: board.wolves + board.gods.length + board.villagers,
    wolves: board.wolves,
    gods: board.gods.slice(),
    villagers: board.villagers,
    win: board.win,
    label: board.label,
  }
}

/**
 * 生成牌堆（未洗牌）。
 * @param {{wolves:number, gods:string[], villagers:number}} board - 板子
 * @returns {string[]} 角色数组，长度 = 座位数
 */
export function buildDeck(board) {
  const deck = []
  for (let index = 0; index < board.wolves; index++) deck.push('wolf')
  for (const god of board.gods) deck.push(god)
  for (let index = 0; index < board.villagers; index++) deck.push('villager')
  return deck
}

/**
 * Fisher–Yates 洗牌（返回新数组）。
 * @param {readonly unknown[]} input - 输入
 * @param {() => number} [rng] - 随机源，默认 Math.random
 * @returns {unknown[]} 洗牌结果
 */
export function shuffle(input, rng = Math.random) {
  const list = input.slice()
  for (let index = list.length - 1; index > 0; index--) {
    const pick = Math.floor(rng() * (index + 1))
    const swap = list[index]
    list[index] = list[pick]
    list[pick] = swap
  }
  return list
}

/**
 * 随机发牌：返回 {seat -> role}（seat 从 1 开始）。
 * @param {ReturnType<typeof resolveBoard>} board - 板子
 * @param {() => number} [rng] - 随机源
 * @returns {Map<number, string>} 座位到角色
 */
export function assignRoles(board, rng = Math.random) {
  const deck = shuffle(buildDeck(board), rng)
  const roles = new Map()
  for (let index = 0; index < deck.length; index++) roles.set(index + 1, deck[index])
  return roles
}

/**
 * 阵营判定。
 * @param {string} role - 角色
 * @returns {'wolf'|'good'} 阵营
 */
export function factionOf(role) {
  return role === 'wolf' ? 'wolf' : 'good'
}

/**
 * 投票统计：每人一票，返回最高票集合（用于平票判定）。
 * @param {ReadonlyArray<{seat:number, target:number|null}>} votes - 有效票
 * @param {ReadonlySet<number>} [weights] - 1.5 票的座位（警长），本引擎默认不使用
 * @returns {{counts:Map<number,number>, top:number[], abstain:number}} 统计
 */
export function tallyVotes(votes, weights = new Set()) {
  const counts = new Map()
  let abstain = 0
  for (const vote of votes) {
    if (vote.target === null || vote.target === undefined) {
      abstain++
      continue
    }
    const weight = weights.has(vote.seat) ? 1.5 : 1
    counts.set(vote.target, (counts.get(vote.target) ?? 0) + weight)
  }
  let best = 0
  for (const value of counts.values()) if (value > best) best = value
  const top = [...counts.entries()].filter(([, value]) => value === best).map(([seat]) => seat).sort((a, b) => a - b)
  return { counts, top: best === 0 ? [] : top, abstain }
}

/**
 * 夜晚结算。优先级：毒 > 刀；守卫与解药同时作用时按「同守同救」配置处理。
 * @param {object} input - 夜间行动
 * @param {number|null} input.wolfTarget - 狼刀目标
 * @param {number|null} input.guardTarget - 守卫目标
 * @param {{type:'none'|'save'|'poison', target:number|null}} input.witchAction - 女巫用药
 * @param {boolean} [input.sameGuardSameSaveDies] - 同守同救是否死亡
 * @returns {{deaths:Array<{seat:number, cause:'knife'|'poison'}>, guarded:boolean, saved:boolean, poisoned:boolean}} 结算结果
 */
export function resolveNight({ wolfTarget, guardTarget, witchAction, sameGuardSameSaveDies = true }) {
  /** @type {Map<number, 'knife'|'poison'>} */
  const deaths = new Map()
  const poisoned = witchAction?.type === 'poison' && typeof witchAction.target === 'number'
  if (poisoned) deaths.set(witchAction.target, 'poison')
  const guarded = typeof guardTarget === 'number' && guardTarget === wolfTarget
  const saved = witchAction?.type === 'save' && typeof witchAction.target === 'number' && witchAction.target === wolfTarget
  if (typeof wolfTarget === 'number') {
    if (guarded && saved) {
      if (sameGuardSameSaveDies && !deaths.has(wolfTarget)) deaths.set(wolfTarget, 'knife')
    } else if (!guarded && !saved && !deaths.has(wolfTarget)) {
      deaths.set(wolfTarget, 'knife')
    }
  }
  return {
    deaths: [...deaths.entries()].map(([seat, cause]) => ({ seat, cause })),
    guarded,
    saved,
    poisoned,
  }
}

/**
 * 胜负判定。
 * @param {ReadonlyArray<{seat:number, role:string, alive:boolean}>} players - 玩家
 * @param {{win:'side'|'eliminate'}} board - 板子（win 决定屠边/屠城）
 * @returns {null|'good'|'wolves'} null 表示未结束
 */
export function checkWin(players, board) {
  const alive = players.filter((player) => player.alive)
  const wolves = alive.filter((player) => factionOf(player.role) === 'wolf').length
  const gods = alive.filter((player) => GOD_ROLES.includes(player.role)).length
  const villagers = alive.filter((player) => player.role === 'villager').length
  const good = gods + villagers
  if (wolves === 0) return 'good'
  if (good === 0) return 'wolves'
  if (board.win === 'side') {
    if (gods === 0 && board.gods.length > 0) return 'wolves'
    if (villagers === 0 && board.villagers > 0) return 'wolves'
  }
  return null
}

/**
 * 判断死者能否发动技能（猎人/狼王开枪）。
 * @param {'knife'|'poison'|'vote'|'skill'} cause - 死因
 * @param {object} [options] - 规则开关
 * @param {boolean} [options.hunterShootWhenPoisoned] - 被毒是否可开枪
 * @returns {boolean} 是否可开枪
 */
export function canShoot(cause, options = {}) {
  if (cause === 'poison') return options.hunterShootWhenPoisoned === true
  return cause === 'knife' || cause === 'vote' || cause === 'skill'
}
