// 关系读数：纯函数部分（无宿主依赖，便于单测）
// 设计见 README：只做三个维度、只输出一句话、不给数字。

const DAY = 86_400_000
const HOUR = 3_600_000

const POS = ['喜欢', '爱你', '好棒', '谢谢', '开心', '抱抱', '宝宝', '晚安',
  '不错', '很好', '辛苦', '厉害', '可爱', '乖', '想你']
const NEG = ['滚', '垃圾', '烦', '生气', '失望', '难受', '哭', '怕', '讨厌',
  '笨', '无语', '离谱', '难过']

export const clamp01 = (x) => {
  const v = Number(x)
  // 非有限值（NaN / ±Infinity）一律当 0：宁可说"读不出来"，也别让它变 1 混进真实读数
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export const dayKey = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function emptyState() {
  return {
    version: 1,
    perDay: {},
    lastUserAt: 0,
    firstUserAt: 0,
    dims: { intimacy: 0.5, unknown: 0.6 },
    history: [],
  }
}

/** 他发了一条消息：按天记账。 */
export function recordUser(state, text, now, keepDays = 9) {
  const s = String(text ?? '')
  const t = Number.isFinite(now) ? now : Date.now()
  const k = dayKey(t)
  const day = state.perDay[k] || (state.perDay[k] = { n: 0, pos: 0, neg: 0, late: 0 })
  day.n += 1
  if (new Date(t).getHours() <= 4) day.late += 1
  if (POS.some((w) => s.includes(w))) day.pos += 1
  if (NEG.some((w) => s.includes(w))) day.neg += 1
  if (!state.firstUserAt) state.firstUserAt = t
  state.lastUserAt = Math.max(state.lastUserAt || 0, t)
  // 剪枝以"最新一条"为基准，避免乱序事件把新数据剪掉
  prune(state, Math.max(t, state.lastUserAt), keepDays)
  return state
}

/** 从磁盘读回来的东西一律过这一道：坏字段、脏数字、被手改过的结构，
 *  都规整成能算的形状。一个坏 JSON 不该让读数变成 NaN，也不该让 perDay 无限膨胀。 */
export function sanitizeState(input, now = Date.now(), keepDays = 9) {
  const base = emptyState()
  if (!input || typeof input !== 'object') return base
  const num = (v, def) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : def
  }
  const perDay = {}
  if (input.perDay && typeof input.perDay === 'object') {
    for (const [k, d] of Object.entries(input.perDay)) {
      if (!d || typeof d !== 'object') continue
      perDay[k] = {
        n: Math.max(0, num(d.n, 0)),
        pos: Math.max(0, num(d.pos, 0)),
        neg: Math.max(0, num(d.neg, 0)),
        late: Math.max(0, num(d.late, 0)),
      }
    }
  }
  const dims = input.dims && typeof input.dims === 'object' ? input.dims : {}
  const state = {
    version: 1,
    perDay,
    lastUserAt: Math.max(0, num(input.lastUserAt, 0)),
    firstUserAt: Math.max(0, num(input.firstUserAt, 0)),
    dims: {
      intimacy: clamp01(dims.intimacy ?? base.dims.intimacy),
      unknown: clamp01(dims.unknown ?? base.dims.unknown),
    },
    history: Array.isArray(input.history) ? input.history.slice(-60) : [],
  }
  if (input.lastMeasure && typeof input.lastMeasure === 'object') state.lastMeasure = input.lastMeasure
  return prune(state, now, keepDays)
}

export function prune(state, now, keepDays = 9) {
  const keep = new Set()
  for (let i = 0; i < keepDays; i += 1) keep.add(dayKey(now - i * DAY))
  for (const k of Object.keys(state.perDay)) {
    if (!keep.has(k)) delete state.perDay[k]
  }
  if (state.history && state.history.length > 60) state.history = state.history.slice(-60)
  return state
}

/** 窗口内的原始聚合。 */
export function aggregate(state, now, windowDays = 7) {
  let n = 0, pos = 0, neg = 0, late = 0
  const counts = []
  for (let i = 0; i < windowDays; i += 1) {
    const d = state.perDay[dayKey(now - i * DAY)]
    const c = d ? d.n : 0
    counts.push(c)
    if (d) {
      n += d.n
      pos += d.pos
      neg += d.neg
      late += d.late
    }
  }
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0
  const variance = counts.length
    ? counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length
    : 0
  const volatility = mean > 0 ? clamp01(Math.sqrt(variance) / mean) : 0
  return { n, pos, neg, late, volatility, days: counts.filter((c) => c > 0).length }
}

/** 原始三维读数。memorySeeds = 一起经历过多少（记忆种子数），只用来调"读得准不准"。 */
export function measure(state, now, windowDays = 7, memorySeeds = 0) {
  const a = aggregate(state, now, windowDays)
  const memoryBoost = clamp01(memorySeeds / 600) * 0.15
  if (a.n === 0) {
    return {
      intimacy: 0.2,
      distance: 1,
      unknown: clamp01(1 - memoryBoost),
      note: '最近没有可读的对话',
      n: 0,
    }
  }
  const gapH = clamp01((now - (state.lastUserAt || now)) / (72 * HOUR))
  const density = clamp01(a.n / 200)
  const total = a.pos + a.neg + 1
  const posRatio = a.pos / total
  const negRatio = a.neg / total
  const intimacy = clamp01(0.30 + 0.45 * density + 0.25 * posRatio
    - 0.20 * negRatio + 0.10 * (a.late / a.n))
  // 经历越多，越敢说"我读得准"；只调这一项，不让情绪碰读数
  const unknown = clamp01(0.75 - 0.45 * density + 0.30 * a.volatility - memoryBoost)

  const bits = []
  if (a.pos) bits.push(`暖话 ${a.pos}`)
  if (a.neg) bits.push(`冷话 ${a.neg}`)
  if (a.late / a.n > 0.2) bits.push('夜里多')
  return {
    intimacy,
    distance: clamp01(gapH),
    unknown,
    note: bits.join('、') || '日常对话',
    n: a.n,
  }
}

/** 关系有惯性：新读数只占三成。 */
export function smooth(old, raw, alpha = 0.3) {
  if (!old) return { intimacy: raw.intimacy, unknown: raw.unknown }
  return {
    intimacy: clamp01((1 - alpha) * clamp01(old.intimacy) + alpha * raw.intimacy),
    unknown: clamp01((1 - alpha) * clamp01(old.unknown) + alpha * raw.unknown),
  }
}

/** 对外只说一句话。 */
export function render(dims) {
  const d = clamp01(dims.distance ?? 1)
  const it = clamp01(dims.intimacy ?? 0)
  const un = clamp01(dims.unknown ?? 1)

  let base
  if (d > 0.75) base = '最近有点远，这几天几乎没怎么说话。'
  else if (d > 0.40) base = '隔了一阵，像各自在忙。'
  else if (it > 0.70) base = '贴得挺近，话也密。'
  else if (it > 0.45) base = '在日常里，不远不近。'
  else base = '话不算多，但还在。'

  let tail = ''
  if (un > 0.65) tail = '我读不太准。'
  else if (un > 0.45) tail = '大概是这样。'
  return (base + tail).trim()
}

/** 概率不固定：中心有倾向，宽度随不确定性变，每次掷前重新采样。 */
export function diceParams(dims = {}) {
  const d = dims && typeof dims === 'object' ? dims : {}
  const closeness = clamp01(1 - clamp01(d.distance ?? 1))
  const intimacy = clamp01(d.intimacy ?? 0)
  const unknown = clamp01(d.unknown ?? 1)
  return {
    pCenter: clamp01(0.10 + 0.55 * intimacy + 0.35 * closeness - 0.25 * unknown),
    k: clamp01(0.15 + 0.30 * unknown),
  }
}

export function roll(dims = {}, rand = Math.random) {
  const safe = typeof rand === 'function' ? rand : Math.random
  const { pCenter, k } = diceParams(dims)
  // 上限压到 0.95、下限 0.02：关系再近也留一点"这次不说"的余地
  const raw = pCenter + (safe() * 2 - 1) * k
  const p = Math.min(0.95, Math.max(0.02, Number.isFinite(raw) ? clamp01(raw) : 0.02))
  return { p, hit: safe() < p }
}
