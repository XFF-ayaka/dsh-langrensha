/**
 * 把一局对局渲染成 Markdown 文档。
 *
 * 纯函数：只读 `WerewolfGame` 的状态快照，不碰文件系统（写盘由调用方负责），
 * 因此可以脱离 DSH 单测。上帝视角附录（夜间行动、查验记录）只在
 * `game.options.godView === true` 时输出。
 */

/** 入口 URL 上的 `?v=` 会透传给子模块，避免 ESM 按 URL 缓存拿到旧代码。 */
const CACHE_KEY = new URL(import.meta.url).search
const { ROLE_LABEL, factionOf } = await import(`./rules.js${CACHE_KEY}`)

const PHASE_LABEL = {
  setup: '开局',
  night: '夜晚',
  dawn: '天亮',
  sheriff: '警长竞选',
  speech: '白天发言',
  vote: '投票放逐',
  over: '终局',
}

const CAUSE_LABEL = { knife: '狼刀', poison: '毒杀', vote: '放逐', skill: '技能' }

/** 两位补零。 */
const pad = (value) => String(value).padStart(2, '0')

/** 本地时间戳，形如 2026-10-01 20:15。 */
function stamp(date) {
  const value = date instanceof Date ? date : new Date(date ?? Date.now())
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/** 适合做文件名的紧凑时间戳。 */
export function fileStamp(date) {
  const value = date instanceof Date ? date : new Date(date ?? Date.now())
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}`
}

/** 渲染一个 `【标题】\n正文` 文本块。 */
function block(lines, text) {
  const match = /^【([^】]+)】\n?([\s\S]*)$/.exec(text)
  if (match === null) {
    lines.push(text, '')
    return
  }
  lines.push(`**${match[1]}**`, '')
  const body = match[2].trim()
  if (body !== '') lines.push(...body.split('\n').map((line) => (line.trim() === '' ? '' : `> ${line}`)), '')
}

/** 女巫用药的文本描述。 */
function witchText(action) {
  if (action === undefined || action === null || action.type === 'none') return '不用药'
  if (action.type === 'save') return `用解药救 ${action.target}号`
  return `用毒药毒 ${action.target}号`
}

/**
 * 生成对局 Markdown。
 * @param {object} game - `WerewolfGame` 实例（或同形状的状态）
 * @param {object} [meta] - 额外信息
 * @param {string} [meta.build] - 插件构建标记，写进页脚
 * @param {Date} [meta.exportedAt] - 导出时间
 * @returns {string} Markdown 文本
 */
export function buildMarkdown(game, meta = {}) {
  const godView = game.options?.godView !== false
  const lines = []
  const winnerText =
    game.winner === null || game.winner === undefined
      ? game.phase === 'over'
        ? '平局'
        : '进行中'
      : game.winner === 'wolves'
        ? '**狼人阵营获胜**'
        : '**好人阵营获胜**'

  lines.push(`# 狼人杀对局记录 · ${game.board.label}`)
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 板子 | ${game.board.label}｜${game.board.seats} 人 |`)
  lines.push(`| 结果 | ${winnerText} |`)
  lines.push(`| 结束时天数 | 第 ${game.day} 天 |`)
  lines.push(
    `| 警长 | ${game.sheriffEnabled === true ? (game.sheriffSeat === null ? '无（无人上警或平票）' : `${game.sheriffSeat} 号，票权 1.5`) : '本局不设警长'} |`,
  )
  lines.push(`| 开始时间 | ${stamp(game.startedAt)} |`)
  lines.push(`| 结束时间 | ${game.finishedAt === null || game.finishedAt === undefined ? '—（仍在进行）' : stamp(game.finishedAt)} |`)
  lines.push(`| 对局 ID | \`${game.id}\` |`)
  lines.push('')

  // --- 身份表
  lines.push('## 一、身份表')
  lines.push('')
  if (godView) {
    lines.push('| 座位 | 身份 | 阵营 | 结局 |')
    lines.push('| --- | --- | --- | --- |')
    for (const player of game.players) {
      const cause = player.cause === null || player.cause === undefined ? '' : `（${CAUSE_LABEL[player.cause] ?? player.cause}）`
      lines.push(
        `| ${player.seat} 号 | ${ROLE_LABEL[player.role] ?? player.role}${player.revealedIdiot ? '（已翻牌）' : ''} | ${factionOf(player.role) === 'wolf' ? '狼人' : '好人'} | ${player.alive ? '存活' : `出局${cause}`} |`,
      )
    }
  } else {
    lines.push('> 本局未开启上帝视角，身份表未记录。')
  }
  lines.push('')

  // --- 放逐投票
  if ((game.voteLog ?? []).length > 0) {
    lines.push('## 二、放逐投票')
    lines.push('')
    lines.push('| 天 | 轮次 | 票型 | 结果 |')
    lines.push('| --- | --- | --- | --- |')
    for (const record of game.voteLog) {
      const counts = record.counts.map((row) => `${row.seat}号 ${row.weight}票`).join('、') || '全部弃票'
      const outcome =
        record.top.length === 0
          ? '无人出局'
          : record.top.length > 1
            ? `平票（${record.top.join('、')}号）`
            : `${record.top[0]}号 得票最高`
      lines.push(`| 第 ${record.day} 天 | ${record.round === 1 ? '首投' : 'PK 重投'} | ${counts} | ${outcome} |`)
    }
    lines.push('')
  }

  // --- 时间线
  lines.push('## 三、对局时间线')
  lines.push('')
  let currentGroup = null
  for (const entry of game.timeline ?? []) {
    const group = `第 ${entry.day} 天 · ${PHASE_LABEL[entry.phase] ?? entry.phase}`
    if (group !== currentGroup) {
      if (currentGroup !== null) lines.push('')
      lines.push(`### ${group}`)
      lines.push('')
      currentGroup = group
    }
    block(lines, entry.text)
  }

  // --- 上帝视角附录
  if (godView && ((game.nightLog ?? []).length > 0 || (game.seerChecks ?? []).length > 0)) {
    lines.push('## 四、夜间行动明细（上帝视角）')
    lines.push('')
    lines.push('| 夜 | 守卫守护 | 狼队刀口 | 女巫 | 实际出局 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const night of game.nightLog) {
      const deaths = night.deaths.length === 0 ? '平安夜' : night.deaths.map((death) => `${death.seat}号（${CAUSE_LABEL[death.cause] ?? death.cause}）`).join('、')
      lines.push(
        `| 第 ${night.day} 夜 | ${night.guardTarget === null || night.guardTarget === undefined ? '空守' : `${night.guardTarget}号`} | ${night.wolfTarget === null || night.wolfTarget === undefined ? '空刀' : `${night.wolfTarget}号`} | ${witchText(night.witchAction)} | ${deaths} |`,
      )
    }
    lines.push('')
    if ((game.seerChecks ?? []).length > 0) {
      lines.push('**预言家查验记录**', '')
      for (const check of game.seerChecks) {
        lines.push(`- 第 ${check.day} 夜：${check.target} 号是${check.result === 'wolf' ? '**狼人**' : '好人'}`)
      }
      lines.push('')
    }
  }

  const seer = game.players.find((player) => player.role === 'seer')
  lines.push('---')
  lines.push('')
  lines.push(
    `*由 dsh-werewolf${meta.build === undefined ? '' : `（${meta.build}）`} 生成于 ${stamp(meta.exportedAt ?? new Date())}${
      seer === undefined ? '' : ` · 预言家座位 ${seer.seat} 号`
    }*`,
  )
  lines.push('')
  return lines.join('\n')
}

/**
 * 生成导出文件名（不含目录）。
 * @param {object} game - 对局
 * @param {Date} [at] - 时间
 * @returns {string} 文件名
 */
export function reportFilename(game, at = new Date()) {
  return `狼人杀-${fileStamp(at)}-${game.board.seats}人局.md`
}
