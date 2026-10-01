/**
 * 狼人杀提示词工厂：把规则、私有信息与公开发言转成每个 AI 的输入文本。
 *
 * 所有提示词都用中文书写，因为整局游戏以中文进行。输出协议用【】标记，
 * 引擎用正则解析这些标记（见 parse.js 中的解析函数在 engine.js 内联实现）。
 */

/** 入口 URL 上的 `?v=` 会透传给子模块，避免 ESM 按 URL 缓存拿到旧代码。 */
const CACHE_KEY = new URL(import.meta.url).search

const { ROLE_LABEL, GOD_ROLES } = await import(`./rules.js${CACHE_KEY}`)

/** 把内部角色名转成人类可读标签。 */
export function label(role) {
  return ROLE_LABEL[role] ?? role
}

/**
 * 组装某位玩家的私有信息块（只有该玩家和裁判看得到）。
 * @param {object} player - 玩家状态 {seat, role, alive, revealedIdiot}
 * @param {object} game - 游戏状态 {players, seerChecks, potions, nightDeaths, board}
 * @returns {string} 私有信息文本
 */
export function privateInfo(player, game) {
  const lines = [`你的座位：${player.seat} 号`, `你的真实身份：${label(player.role)}（${player.role === 'wolf' ? '狼人阵营' : '好人阵营'}）`]
  if (player.role === 'wolf') {
    const mates = game.players.filter((item) => item.role === 'wolf' && item.seat !== player.seat)
    lines.push(
      mates.length === 0
        ? '你是唯一的狼人。'
        : `你的狼队友：${mates.map((item) => `${item.seat} 号${item.alive ? '' : '（已出局）'}`).join('、')}。`,
    )
    const wolves = game.players.filter((item) => item.role === 'wolf')
    lines.push(`狼队共 ${wolves.length} 人，存活 ${wolves.filter((item) => item.alive).length} 人。`)
  }
  if (player.role === 'seer') {
    lines.push(
      game.seerChecks.length === 0
        ? '你还没有查验记录。'
        : `你的查验记录：${game.seerChecks.map((check) => `${check.target} 号是${check.result === 'wolf' ? '狼人' : '好人'}`).join('；')}`,
    )
  }
  if (player.role === 'witch') {
    lines.push(`你的药剂：解药${game.potions.antidote ? '还在' : '已用'}，毒药${game.potions.poison ? '还在' : '已用'}。`)
    lines.push(`自救规则：${game.options.witchSelfSave === 'never' ? '不可自救' : game.options.witchSelfSave === 'always' ? '任何时候都可自救' : '仅首夜可自救'}。同一晚只能使用一瓶药。`)
  }
  if (player.role === 'guard') {
    lines.push(
      `你上一晚守护了：${game.lastGuardTarget === null ? '未守人' : `${game.lastGuardTarget} 号`}（不可连续两晚守同一人）。`,
    )
  }
  if (player.role === 'hunter') lines.push('你的技能：被狼刀或被投票放逐出局时可开枪带走一人；被女巫毒死不能开枪。')
  if (player.role === 'idiot') lines.push('你的技能：被投票放逐时翻牌免死，之后仍可发言但失去投票权。')
  if (player.revealedIdiot) lines.push('你已经翻牌（白痴），现在不能投票。')
  if (game.sheriffEnabled === true) {
    lines.push(
      game.sheriffSeat === null
        ? '本局有警长竞选，目前尚未选出警长。'
        : game.sheriffSeat === player.seat
          ? '你是本局警长：放逐投票时你的票算 1.5 票，白天由你决定发言方向，并且你最后发言归票。'
          : `本局警长是 ${game.sheriffSeat} 号（他的票算 1.5 票，白天由他决定发言方向并最后归票）。`,
    )
  }
  return lines.join('\n')
}

/**
 * 玩家 AI 的开场设定（每轮都随提示词一起投递，因为每轮都是独立的子智能体运行）。
 * @param {object} input - {seat, role, seatCount, boardLabel, sheriffEnabled}
 * @returns {string} 系统提示
 */
export function playerBriefing({ seat, role, seatCount, boardLabel, sheriffEnabled = false }) {
  return [
    `你正在参加一局中文狼人杀（${boardLabel}，共 ${seatCount} 人${sheriffEnabled ? '，有警长竞选' : '，无警长简化局'}）。`,
    `你是 ${seat} 号玩家，真实身份是【${label(role)}】。`,
    '',
    '铁律：',
    '1. 你只能输出这一次发言的内容：不要复述规则、不要提问、不要解释你在做什么、不要输出思考过程。',
    '2. 你没有任何工具，也不能读文件或执行命令，你只会说话。',
    '3. 你的真实身份只能在符合战术时公开声称；狼人可以撒谎、可以悍跳预言家。',
    '4. 发言要像真人面杀：先给结论，再给逻辑，最后归票；控制在 120 字以内（遗言、PK 发言可到 200 字）。',
    '5. 不要输出规则要求之外的【】标记，不要用 Markdown 代码块。',
  ].join('\n')
}

/**
 * 白天公开发言的指令。
 * @param {object} input - {player, game, order Note}
 * @returns {string} 指令
 */
export function speechPrompt({ player, game }) {
  return [
    `现在是第 ${game.day} 天白天发言阶段。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '轮到你发言。要求：',
    '- 表态身份（可报可藏）、复盘点评前面玩家的发言（谁像狼、谁像好人、理由）、给出本轮归票目标。',
    '- 直接说话，不要写「我说」之类的旁白。',
    '- 120 字以内，结尾用一行给出你的归票：『【投票】N号』（N 为你要投的座位号，可以投自己或写 0 表示弃票）。',
  ].join('\n')
}

/**
 * 投票指令（发言结束后的正式投票）。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function votePrompt({ player, game }) {
  const candidates = game.players.filter((item) => item.alive && item.seat !== player.seat).map((item) => `${item.seat}号`)
  return [
    `第 ${game.day} 天投票阶段。候选（存活玩家）：${candidates.join('、')}（也可以投自己或弃票）。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '只输出一行：【投票】N号。不要输出任何其它文字。',
  ].join('\n')
}

/**
 * 平票 PK 发言指令。
 * @param {object} input - {player, game, rivals}
 * @returns {string} 指令
 */
export function pkPrompt({ player, game, rivals }) {
  return [
    `第 ${game.day} 天出现平票，你（${player.seat} 号）与 ${rivals.join('、')} 号进入 PK。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '请做一轮 PK 发言为自己辩解并攻击对手，200 字以内，结尾用一行给出你重投的目标：『【投票】N号』。',
  ].join('\n')
}

/**
 * 夜间狼队讨论指令。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function wolfNightPrompt({ player, game }) {
  const targets = game.players.filter((item) => item.alive).map((item) => `${item.seat}号(${label(item.role) === '狼人' ? '狼' : '？'})`)
  return [
    `天黑请闭眼。第 ${game.day} 夜，狼队睁眼。`,
    '',
    '【狼队内部信息】',
    privateInfo(player, game),
    `存活玩家：${game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')}`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '请简短地给出你的刀人意见（为什么刀他），并在一行给出最终选择：『【狼刀】N号』；不想刀人可以写『【狼刀】空刀』。',
  ].join('\n')
}

/**
 * 预言家查验指令。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function seerPrompt({ player, game }) {
  return [
    `第 ${game.day} 夜，预言家睁眼。`,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    `存活玩家：${game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')}`,
    '',
    '请在一行给出你要查验的座位：『【查验】N号』。可以附一句理由，但必须包含该标记。',
  ].join('\n')
}

/**
 * 女巫用药指令。
 * @param {object} input - {player, game, killedTonight}
 * @returns {string} 指令
 */
export function witchPrompt({ player, game, killedTonight }) {
  return [
    `第 ${game.day} 夜，女巫睁眼。`,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    `今晚被狼刀的人是：${killedTonight === null ? '无人被刀' : `${killedTonight} 号`}`,
    `解药${game.potions.antidote ? '还在' : '已用'}，毒药${game.potions.poison ? '还在' : '已用'}。`,
    '',
    '请在一行给出用药决定：',
    '- 用解药救人：『【女巫】救』',
    '- 用毒药毒人：『【女巫】毒 N号』',
    '- 不用药：『【女巫】不用』',
  ].join('\n')
}

/**
 * 守卫守护指令。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function guardPrompt({ player, game }) {
  return [
    `第 ${game.day} 夜，守卫睁眼。`,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    `存活玩家：${game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')}`,
    '',
    '请在一行给出守护目标：『【守护】N号』；空守写『【守护】空守』。',
  ].join('\n')
}

/**
 * 猎人开枪指令。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function hunterPrompt({ player, game }) {
  return [
    `你（${player.seat} 号，猎人）刚刚出局，可以开枪带走一人。`,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    `存活玩家：${game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')}`,
    '',
    '请在一行给出你的选择：『【开枪】N号』；不开枪写『【开枪】不开』。可以附一句遗言。',
  ].join('\n')
}

/**
 * 遗言指令。
 * @param {object} input - {player, game, cause}
 * @returns {string} 指令
 */
export function lastWordsPrompt({ player, game, cause }) {
  return [
    `你（${player.seat} 号）已经出局（死因：${cause === 'poison' ? '被毒' : cause === 'vote' ? '被投票放逐' : '被狼刀'}），现在留遗言。`,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '请留下遗言：交代你的身份与信息、给好人留线索或给狼队留误导，200 字以内。不要输出任何【】标记。',
  ].join('\n')
}

/**
 * 裁判播报指令。
 * @param {object} input - {phase, facts, game}
 * @returns {string} 指令
 */
export function judgePrompt({ phase, facts, game }) {
  return [
    '你是这局狼人杀的裁判（上帝）。请只输出要播报给全体玩家看的那段话。',
    '',
    `当前阶段：${phase}`,
    `第 ${game.day} 天/夜。存活：${game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')}`,
    '',
    '【必须如实播报的事实（不得增删、不得泄露未授权信息）】',
    facts,
    '',
    '要求：',
    '- 用中文，语气像面杀主持：简明、有节奏感，可用「天黑请闭眼」「天亮了」这类口令。',
    '- 只播报上面给出的公开事实；绝不提及任何玩家的真实身份、狼刀目标、查验结果、用药等未公开信息。',
    '- 只播报本轮新增信息，不要重复上一阶段已经播报过的内容。',
    '- 事实里列出了出局玩家时，直接宣布出局名单并禁止说「平安夜」；只有事实本身是平安夜时才可以说「平安夜」。',
    '- 不要自行添加下一阶段的口令（例如在投票结果里说「天黑请闭眼」），也不要自我纠正、不要说「不对」。',
    '- 80 字以内，不要用 Markdown，不要输出【】标记，不要加「裁判：」这样的前缀。',
  ].join('\n')
}

/**
 * 裁判终局点评指令。
 * @param {object} input - {game, winner, facts}
 * @returns {string} 指令
 */
export function judgeFinalPrompt({ game, winner, facts }) {
  return [
    '你是这局狼人杀的裁判（上帝）。游戏已经结束，请做终局播报与简短复盘。',
    '',
    `胜方：${winner === 'wolves' ? '狼人阵营' : '好人阵营'}`,
    '【真实身份表】',
    facts,
    '',
    '要求：中文，先宣布胜负，再用 3-5 句话点评本局关键点（谁跳了预言家、狼队怎么赢/输的）。250 字以内，不要用 Markdown。',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * 警长竞选（上警 / 竞选发言 / 警下投票 / 平票 PK / 发言方向 / 警徽移交）
 * ------------------------------------------------------------------ */

/** 存活玩家名单文本。 */
function aliveList(game) {
  return game.players.filter((item) => item.alive).map((item) => `${item.seat}号`).join('、')
}

/**
 * 上警宣言：是否参加警长竞选。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function sheriffCampaignPrompt({ player, game }) {
  return [
    `第 ${game.day} 天，警长竞选（上警）开始。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    `存活玩家：${aliveList(game)}`,
    '',
    '上警的人要公开发表竞选发言、并接受警下玩家投票；不上警的人只投票、不发言。',
    '你是否上警？请用一行给出决定：『【上警】是』或『【上警】否』。',
    '（上警需要理由时可在前面写一句话，但必须包含该标记。）',
  ].join('\n')
}

/**
 * 竞选发言。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function sheriffSpeechPrompt({ player, game }) {
  return [
    `你正在竞选警长（第 ${game.day} 天）。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '请做 120 字以内的竞选发言：说明你为什么适合当警长、你的验人/归票思路（若你是预言家可以报验人抢警徽流）。',
    '直接说话，不要输出任何【】标记。',
  ].join('\n')
}

/**
 * 警下投票选警长。
 * @param {object} input - {player, game, candidates}
 * @returns {string} 指令
 */
export function sheriffVotePrompt({ player, game, candidates }) {
  return [
    `第 ${game.day} 天警长竞选投票。候选（警上玩家）：${candidates.map((seat) => `${seat}号`).join('、')}。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '【你的私有信息】',
    privateInfo(player, game),
    '',
    '你不在警上，只能在这几位候选人里选一个。只输出一行：【警长】N号。',
  ].join('\n')
}

/**
 * 警长竞选平票 PK 发言。
 * @param {object} input - {player, game, rivals}
 * @returns {string} 指令
 */
export function sheriffRunoffPrompt({ player, game, rivals }) {
  return [
    `警长竞选出现平票，你（${player.seat}号）与 ${rivals.join('、')} 号进入 PK。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    '请做 150 字以内的最后陈述，说服警下玩家把警徽投给你。不要输出【】标记。',
  ].join('\n')
}

/**
 * 警长决定白天发言方向。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function sheriffDirectionPrompt({ player, game }) {
  return [
    `你是本局警长（${player.seat}号）。第 ${game.day} 天白天发言即将开始，由你决定从哪边开始。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    `存活玩家：${aliveList(game)}`,
    '',
    '请用一行给出决定：『【方向】左』表示从你左手边（座位号往下一位）开始；『【方向】右』表示从你右手边开始。',
    '（不论左右，你都最后发言并归票。）',
  ].join('\n')
}

/**
 * 警长出局时移交或撕掉警徽。
 * @param {object} input - {player, game}
 * @returns {string} 指令
 */
export function sheriffTransferPrompt({ player, game }) {
  return [
    `你（${player.seat}号）是本局警长，现在已经出局，需要处理警徽。`,
    '',
    '【公开信息】',
    game.publicDigest,
    '',
    `存活玩家：${aliveList(game)}`,
    '',
    '请用一行给出决定：把警徽移交给你信任的存活玩家『【警徽】N号』，或者撕掉警徽『【警徽】撕』。',
  ].join('\n')
}

/** 神职名单（用于裁判事实描述）。 */
export function godList(players) {
  return players.filter((player) => GOD_ROLES.includes(player.role)).map((player) => player.seat)
}
