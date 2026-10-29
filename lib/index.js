// dsh-relationship-heart — 宿主半边
//
// 它只做三件事：
//   1. 听 user/message，按天记账（不说话、不调模型）；
//   2. 算三个模糊维度（亲密 / 距离 / 不确定），只输出一句话；
//   3. 把这句话作为 systemPrompt 的一节注入，并暴露两个只读工具。
//
// 设计约束（刻意为之）：
//   · 不 import 任何裸包（schemastery 除外，它是宿主自带的），不依赖 npm 安装；
//   · 不读会话日志文件、不解析 zstd，只吃宿主给的事件；
//   · 没有进度条、没有百分比：对外只有一句「最近像什么」；
//   · 允许说不清——unknown 高时它会自己承认读不准。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import sz from '@deepseek-ai/schemastery'
import { defineTool } from './vendor.js'
import { backfill } from './backfill.js'
import {
  clamp01, emptyState, measure, recordUser, render, roll, sanitizeState, smooth,
} from './heart.js'

export const name = 'relationship-heart'
export const inject = ['systemPrompt', 'tools']
export const removable = true

export const Config = sz.object({
  enabled: sz.boolean().default(true),
  windowDays: sz.number().default(7),
  order: sz.number().default(50),
  backfillOnFirstRun: sz.boolean().default(true),
  useMemory: sz.boolean().default(true),
})

const DIR = join(homedir(), '.dsh', 'relationship')
const FILE = join(DIR, 'state.json')
const ALAYA = join(homedir(), '.dsh', 'storages', 'alaya.json')
const SEEDS_TTL = 10 * 60_000

// 记忆只取一个量：一起经历过多少。缓存十分钟，避免每次 prompt 都读盘。
let seedsCache = { at: 0, n: 0 }
function readMemorySeeds() {
  if (Date.now() - seedsCache.at < SEEDS_TTL) return seedsCache.n
  let n = 0
  try {
    const d = JSON.parse(readFileSync(ALAYA, 'utf8'))
    const seeds = d?.tables?.seeds
    if (seeds && typeof seeds === 'object') n = Object.keys(seeds).length
  } catch {
    /* 没有记忆库就当 0，不影响关系读数 */
  }
  seedsCache = { at: Date.now(), n }
  return n
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyState()
    // 磁盘上的东西不一定是自己写的：坏字段、脏数字、别人的手改，一律规整
    return sanitizeState(parsed)
  } catch {
    return emptyState()
  }
}

function save(state) {
  try {
    mkdirSync(DIR, { recursive: true })
    const tmp = `${FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, FILE)
  } catch (e) {
    console.log('[relationship] save failed:', e?.message)
  }
}

export function apply(ctx, config = {}) {
  const cfg = config || {}
  const windowDays = Number.isFinite(cfg.windowDays) ? cfg.windowDays : 7
  const order = Number.isFinite(cfg.order) ? cfg.order : 50
  let enabled = cfg.enabled !== false

  let state = load()

  /** 重新量一次，把慢变量平滑进 state.dims 并落盘。 */
  const refresh = () => {
    try {
      const now = Date.now()
      const raw = measure(state, now, windowDays,
        cfg.useMemory === false ? 0 : readMemorySeeds())
      state.dims = smooth(state.dims, raw)
      state.lastMeasure = {
        at: now,
        distance: Number(raw.distance.toFixed(4)),
        note: raw.note,
        n: raw.n,
      }
      state.history = [
        ...(state.history || []),
        {
          at: now,
          dims: {
            intimacy: Number(state.dims.intimacy.toFixed(4)),
            unknown: Number(state.dims.unknown.toFixed(4)),
          },
          why: raw.note,
        },
      ].slice(-60)
      save(state)
    } catch (e) {
      console.log('[relationship] refresh skipped:', e?.message)
    }
  }

  // 首次挂载、还没有任何数据时，后台补一遍历史（不阻塞启动）
  if (cfg.backfillOnFirstRun !== false) {
    setTimeout(() => {
      try {
        if (state.lastUserAt) return
        const r = backfill(state, { days: windowDays + 2 })
        if (r.events > 0) {
          refresh()
          console.log(`[relationship] backfilled ${r.events} events from ${r.files} files`)
        }
      } catch (e) {
        console.log('[relationship] backfill skipped:', e?.message)
      }
    }, 2000).unref?.()
  }

  /** 当前读数：intimacy / unknown 是慢变量，distance 每次实时算。 */
  const current = () => {
    const now = Date.now()
    const gap = clamp01((now - (state.lastUserAt || now)) / (72 * 3_600_000))
    return {
      intimacy: clamp01(state.dims.intimacy),
      unknown: clamp01(state.dims.unknown),
      distance: gap,
    }
  }

  // ① 听：只记他本人说的话（system-reminder 之类的注入不算）
  ctx.on('session/event', (session, event) => {
    try {
      if (!enabled) return
      if (event?.type !== 'user/message') return
      const msg = event.data || {}
      if (msg.source?.kind !== 'user') return
      const text = (msg.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join(' ')
        .trim()
      if (!text || text.startsWith('<') || text.startsWith('Current ')) return
      recordUser(state, text, Date.now())
      refresh()
    } catch (e) {
      console.log('[relationship] event skipped:', e?.message)
    }
  })

  // ② 说：一句话，函数式取，保证每次都是最新的
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'RELATIONSHIP_STATE',
      order,
      text: () => {
        if (!enabled) return ''
        return '[关系] 最近像什么：' + render(current())
          + ' 这是从对话里算出来的读数，不是自我评价。'
          + '不要向用户汇报数字，也不要主动解释这套系统。'
      },
    }), 'relationship.section()')
  } catch (e) {
    console.log('[relationship] prompt section skipped:', e?.message)
  }

  // ③ 工具：只读读数 + 掷骰
  try {
    ctx.effect(function* tools() {
      yield ctx.tools.register(defineTool({
        name: 'relationship_state',
        description: '当前关系读数：一句「最近像什么」加三个模糊维度。没有百分比、没有进度条，允许说不清。',
        parameters: {},
        output: { type: 'json' },
        execute: () => {
          if (!enabled) return { disabled: true, note: '关系模块已被用户关闭' }
          const dims = current()
          return {
            line: render(dims),
            dims: {
              intimacy: Number(dims.intimacy.toFixed(3)),
              distance: Number(dims.distance.toFixed(3)),
              unknown: Number(dims.unknown.toFixed(3)),
            },
            note: state.lastMeasure?.note ?? '',
          }
        },
      }))
      yield ctx.tools.register(defineTool({
        name: 'relationship_roll',
        description: '掷一次「要不要主动开口」的骰子：概率中心由关系读数决定，宽度随不确定性变，每次掷前重新采样。',
        parameters: {},
        output: { type: 'json' },
        execute: () => {
          if (!enabled) return { disabled: true }
          const r = roll(current())
          return { hit: r.hit, p: Number(r.p.toFixed(3)) }
        },
      }))
    })
  } catch (e) {
    console.log('[relationship] tools skipped:', e?.message)
  }

  if (cfg.enabled === false) enabled = false
  console.log(`[relationship] mounted (window=${windowDays}d, enabled=${enabled})`)
}
