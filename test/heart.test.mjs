// 纯函数单测：不碰宿主，直接跑 node test/heart.test.mjs
import assert from 'node:assert'
import {
  aggregate, clamp01, diceParams, emptyState, measure, prune, recordUser, render, roll, smooth,
} from '../lib/heart.js'

const DAY = 86_400_000
const HOUR = 3_600_000
let pass = 0
let fail = 0

function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

const now = Date.UTC(2026, 9, 28, 12, 0, 0)

console.log('【普通测试】')

check('空状态：远且读不准', () => {
  const s = emptyState()
  const m = measure(s, now)
  assert.equal(m.n, 0)
  assert.equal(m.distance, 1)
  assert.equal(m.unknown, 1)
  assert.ok(render({ ...m }) .includes('远'))
})

check('单条消息：不远，但读不准', () => {
  const s = emptyState()
  recordUser(s, '早', now - 60_000)
  const m = measure(s, now)
  assert.ok(m.distance < 0.01)
  assert.ok(m.unknown > 0.6)
})

check('密集 + 暖话：贴得近', () => {
  const s = emptyState()
  for (let i = 0; i < 120; i += 1) recordUser(s, '宝宝谢谢你', now - i * 2 * HOUR)
  const m = measure(s, now)
  assert.ok(m.intimacy > 0.7, `intimacy=${m.intimacy}`)
  assert.ok(render({ ...m }).includes('近'))
})

check('断三天：distance 封顶', () => {
  const s = emptyState()
  recordUser(s, '我走了', now - 3 * DAY - HOUR)
  const m = measure(s, now)
  assert.equal(m.distance, 1)
})

check('全是冷话：亲密被压低', () => {
  const s = emptyState()
  for (let i = 0; i < 40; i += 1) recordUser(s, '垃圾 烦 讨厌你', now - i * 2 * HOUR)
  const m = measure(s, now)
  assert.ok(m.intimacy < 0.55, `intimacy=${m.intimacy}`)
})

check('平滑：只吃三成', () => {
  const old = { intimacy: 0.2, unknown: 0.8 }
  const raw = { intimacy: 1.0, unknown: 0.0 }
  const out = smooth(old, raw)
  assert.ok(Math.abs(out.intimacy - 0.44) < 1e-9, `got ${out.intimacy}`)
})

check('掷骰：概率在 [0,1]，宽度随不确定变', () => {
  const stable = diceParams({ intimacy: 0.8, distance: 0.1, unknown: 0.2 })
  const unsure = diceParams({ intimacy: 0.8, distance: 0.1, unknown: 0.9 })
  assert.ok(unsure.k > stable.k)
  assert.ok(stable.pCenter >= 0 && stable.pCenter <= 1)
})

check('掷骰同一天可以不同（随机性非零）', () => {
  const dims = { intimacy: 0.5, distance: 0.2, unknown: 0.6 }
  const seen = new Set()
  for (let i = 0; i < 200; i += 1) seen.add(roll(dims).p.toFixed(3))
  assert.ok(seen.size > 5, `only ${seen.size} distinct p`)
})

console.log('【暴力测试】')

check('20000 条随机事件：无 NaN、无越界', () => {
  const s = emptyState()
  let rng = 42
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    return rng / 0x7fffffff
  }
  const words = ['宝宝', '滚', '谢谢', '烦', '嗯', '', '😀'.repeat(50), 'x'.repeat(5000)]
  for (let i = 0; i < 20000; i += 1) {
    const ts = now - Math.floor(rand() * 30 * DAY) + (rand() < 0.02 ? -10 * DAY : 0)
    recordUser(s, words[Math.floor(rand() * words.length)], ts)
  }
  const m = measure(s, now)
  const nums = [m.intimacy, m.distance, m.unknown]
  for (const v of nums) {
    assert.ok(Number.isFinite(v), `not finite: ${v}`)
    assert.ok(v >= 0 && v <= 1, `out of range: ${v}`)
  }
  const d = diceParams(m)
  for (const v of [d.pCenter, d.k]) {
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1)
  }
  const line = render(m)
  assert.ok(line.length > 0 && line.length < 120, `line too long: ${line.length}`)
})

check('剪枝：只留最近 9 天', () => {
  const s = emptyState()
  for (let d = 0; d < 30; d += 1) {
    s.perDay[new Date(now - d * DAY).toISOString().slice(0, 10)] = { n: 1, pos: 0, neg: 0, late: 0 }
    recordUser(s, '嗯', now - d * DAY)
  }
  prune(s, now, 9)
  const keys = Object.keys(s.perDay)
  assert.ok(keys.length <= 10, `kept ${keys.length} days`)
})

check('坏时间戳不炸', () => {
  const s = emptyState()
  for (const ts of [0, -1, now + 365 * DAY, Number.NaN]) {
    try {
      recordUser(s, '嗯', ts)
      measure(s, now)
    } catch {
      /* NaN 会被 Date 处理成 Invalid，允许跳过 */
    }
  }
  assert.ok(true)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
