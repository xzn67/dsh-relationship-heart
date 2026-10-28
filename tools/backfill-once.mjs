// 一次性回填：把历史事件算进 state.json（装好插件后跑一次）
// 用法：node tools/backfill-once.mjs
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { backfill } from '../lib/backfill.js'
import { emptyState, measure, render, smooth } from '../lib/heart.js'

const days = 9
const state = emptyState()
const result = backfill(state, { days })
const now = Date.now()
const raw = measure(state, now)
state.dims = smooth(null, raw)
state.lastMeasure = {
  at: now,
  distance: Number(raw.distance.toFixed(4)),
  note: raw.note,
  n: raw.n,
}
state.history = [{
  at: now,
  dims: {
    intimacy: Number(state.dims.intimacy.toFixed(4)),
    unknown: Number(state.dims.unknown.toFixed(4)),
  },
  why: raw.note,
}]

const dir = join(homedir(), '.dsh', 'relationship')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'state.json')
const tmp = `${file}.tmp`
writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
renameSync(tmp, file)

console.log('backfill:', result)
console.log('聚合:', raw.n, '条，', Object.keys(state.perDay).length, '天')
console.log('维度:', {
  intimacy: Number(state.dims.intimacy.toFixed(3)),
  distance: Number(raw.distance.toFixed(3)),
  unknown: Number(state.dims.unknown.toFixed(3)),
})
console.log('那句:', render({ ...state.dims, distance: raw.distance }))
console.log('写入:', file)
