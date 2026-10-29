// 暴力测试：关系读数的脏输入与极端序列。
// 判据：不炸、不出 NaN、perDay 不无限膨胀、对外永远是一句话。
import {
  aggregate, clamp01, dayKey, diceParams, emptyState, measure, prune,
  recordUser, render, roll, sanitizeState, smooth,
} from '../lib/heart.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}`) }
}
const time = (label, fn) => {
  const t0 = Date.now()
  const r = fn()
  console.log(`  ·    ${label}：${Date.now() - t0}ms`)
  return r
}
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

console.log('【1. 十万条乱序消息】')
{
  const rand = mulberry32(4242)
  const state = emptyState()
  const now = Date.now()
  let bad = 0
  time('10 万条记账 + 量一次', () => {
    for (let k = 0; k < 100_000; k++) {
      // 时间轴乱序、跨年、极旧、未来，全往里塞
      const offset = (rand() - 0.5) * 400 * 86_400_000
      const t = now + offset
      const text = ['难受', '喜欢你', '你好', '', '很长的消息'.repeat(200)][Math.floor(rand() * 5)]
      recordUser(state, text, t)
      if (!Number.isFinite(state.lastUserAt)) bad++
      if (Object.keys(state.perDay).length > 12) bad++
    }
    const dims = measure(state, now, 7)
    if (!Number.isFinite(dims.intimacy) || !Number.isFinite(dims.distance) || !Number.isFinite(dims.unknown)) bad++
    if (dims.intimacy < 0 || dims.intimacy > 1) bad++
    if (dims.unknown < 0 || dims.unknown > 1) bad++
    if (dims.distance < 0 || dims.distance > 1) bad++
  })
  ok(bad === 0, '十万条乱序都不出 NaN / 越界，perDay 一直被剪在 12 天以内')
  ok(state.history.length <= 60, `history 被压在 60 条内（实得 ${state.history.length}）`)
  ok(typeof render(measure(state, now)) === 'string', '对外仍然只有一句话')
}

console.log('\n【2. 脏时间与脏文本】')
{
  const state = emptyState()
  const nasty = [NaN, Infinity, -Infinity, undefined, null, 'x', {}, [], 1e300, -1e300, 0, -1]
  let bad = 0
  for (const t of nasty) {
    try {
      recordUser(state, '难受', t)
      if (!Number.isFinite(state.lastUserAt)) bad++
    } catch { bad++; console.log(`     recordUser(${String(t)}) 抛了`) }
  }
  ok(bad === 0, '坏时间戳一律当现在，不抛也不污染 lastUserAt')

  const state2 = emptyState()
  for (const text of [undefined, null, 123, {}, [], { toString() { return '难受' } }]) {
    try { recordUser(state2, text, Date.now()) } catch { bad++ }
  }
  ok(bad === 0, '坏文本一律走 String()，读取不抛')

  const huge = '喜欢你' + '啊'.repeat(3_000_000)
  const t0 = Date.now()
  recordUser(state2, huge, Date.now())
  ok(Date.now() - t0 < 3000, `三百万字的单条消息也扛得住（${Date.now() - t0}ms）`)
}

console.log('\n【3. 坏状态文件规整】')
{
  const cases = [
    ['null', null],
    ['数组', []],
    ['perDay 是字符串', { perDay: 'x' }],
    ['perDay 里是数字', { perDay: { '2026-01-01': 42 } }],
    ['perDay 里混坏字段', { perDay: { '2026-01-01': { n: 'x', pos: NaN, neg: null, late: Infinity } } }],
    ['dims 是字符串', { dims: 'x' }],
    ['dims 越界', { dims: { intimacy: 99, unknown: -99 } }],
    ['history 是对象', { history: {} }],
    ['history 塞一万条', { history: new Array(10_000).fill({ at: 1 }) }],
    ['lastUserAt 是未来', { lastUserAt: Number.MAX_SAFE_INTEGER }],
    ['一堆陈年 perDay', Object.fromEntries(Array.from({ length: 500 }, (_, i) => [dayKey(Date.now() - i * 86_400_000), { n: 1, pos: 0, neg: 0, late: 0 }]))],
  ]
  let bad = 0
  for (const [name, input] of cases) {
    try {
      const s = sanitizeState(input)
      if (!Number.isFinite(s.lastUserAt) || !Number.isFinite(s.dims.intimacy) || !Number.isFinite(s.dims.unknown)) bad++
      if (s.dims.intimacy < 0 || s.dims.intimacy > 1 || s.dims.unknown < 0 || s.dims.unknown > 1) bad++
      if (s.history.length > 60) bad++
      if (Object.keys(s.perDay).length > 12) bad++
      for (const d of Object.values(s.perDay)) {
        if (![d.n, d.pos, d.neg, d.late].every((x) => Number.isFinite(x) && x >= 0)) bad++
      }
      const dims = measure(s, Date.now(), 7)
      if (![dims.intimacy, dims.distance, dims.unknown].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) bad++
    } catch { bad++; console.log(`     ${name} 抛了`) }
  }
  ok(bad === 0, `${cases.length} 种坏状态都被规整成能算的形状，perDay 剪到 12 天、history 压到 60 条`)
  ok(sanitizeState({ history: new Array(10_000).fill({ at: 1 }) }).history.length === 60, '一万条 history 只留 60 条')
}

console.log('\n【4. 掷骰的概率边界】')
{
  const rand = mulberry32(77)
  let bad = 0
  let min = 1
  let max = 0
  time('10 万次 roll', () => {
    for (let k = 0; k < 100_000; k++) {
      const dims = { intimacy: rand(), distance: rand(), unknown: rand() }
      const params = diceParams(dims)
      if (!Number.isFinite(params.pCenter) || !Number.isFinite(params.k)) bad++
      if (params.pCenter < 0 || params.pCenter > 1) bad++
      const r = roll(dims, rand)
      if (!Number.isFinite(r.p) || r.p < 0.02 || r.p > 0.95) bad++
      if (typeof r.hit !== 'boolean') bad++
      min = Math.min(min, r.p)
      max = Math.max(max, r.p)
    }
  })
  ok(bad === 0, `10 万次掷骰：p 恒在 [0.02,0.95]（实测 ${min.toFixed(3)}–${max.toFixed(3)}）`)
  ok(min < 0.1 && max > 0.9, `区间两头都够得着（${min.toFixed(2)} / ${max.toFixed(2)}）`)

  const weird = [undefined, null, {}, { intimacy: NaN, distance: NaN, unknown: NaN }, { intimacy: 9, distance: -9, unknown: 'x' }]
  let bad2 = 0
  for (const d of weird) {
    try {
      const r = roll(d, () => 0.5)
      if (!Number.isFinite(r.p) || r.p < 0.02 || r.p > 0.95) bad2++
      if (typeof r.hit !== 'boolean') bad2++
    } catch { bad2++ }
  }
  ok(bad2 === 0, '脏维度（含 undefined / NaN / 越界 / 字符串）也能掷，p 仍在区间内')

  const r2 = roll({}, 'not a function')
  ok(Number.isFinite(r2.p) && typeof r2.hit === 'boolean', '随机源不是函数时退回 Math.random，不抛')
}

console.log('\n【5. 聚合与平滑的极端值】')
{
  let bad = 0
  const state = emptyState()
  // 一天一亿条：密度要封顶，不能溢出
  state.perDay[dayKey(Date.now())] = { n: 1e9, pos: 1e9, neg: 0, late: 1e9 }
  const a = aggregate(state, Date.now(), 7)
  if (![a.n, a.pos, a.volatility].every(Number.isFinite)) bad++
  const m = measure(state, Date.now(), 7)
  if (![m.intimacy, m.distance, m.unknown].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) bad++
  ok(bad === 0, '一天一亿条消息也不溢出，读数仍在 [0,1]')

  const s1 = smooth({ intimacy: 0.5, unknown: 0.5 }, { intimacy: NaN, unknown: Infinity })
  ok(Number.isFinite(s1.intimacy) && Number.isFinite(s1.unknown), '平滑时遇到 NaN/Infinity 也不污染')
  ok(clamp01(NaN) === 0 && clamp01(Infinity) === 0 && clamp01(-Infinity) === 0,
    'clamp01 对三个特殊值都给出定值 0（非有限值统一当「读不出来」，不当成满值）')
  ok(clamp01('0.5') === 0.5, '数字字符串也能夹')

  const p = prune(sanitizeState({ perDay: { x: { n: 1 } } }, Date.now()), Date.now(), 0)
  ok(Object.keys(p.perDay).length === 0, 'keepDays=0 时把它剪空，不炸')
}

console.log('\n【6. 输出长度与形状】')
{
  const rand = mulberry32(5)
  let bad = 0
  let longest = ''
  for (let k = 0; k < 5000; k++) {
    const s = render({ intimacy: rand(), distance: rand(), unknown: rand() })
    if (typeof s !== 'string' || !s.length) bad++
    if (s.length > longest.length) longest = s
  }
  ok(bad === 0, '5000 组随机维度都输出非空字符串')
  ok(longest.length < 60, `最长那句 ${longest.length} 字（还像句话，不像报表）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
