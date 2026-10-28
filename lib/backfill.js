// 回填历史：从 DSH 的会话日志里读过去几天的对话，补进 perDay。
//
// 为什么要它：插件是今天才装的，之前几天的对话它没看见，读数就会偏"远"。
// 这里把历史事件重放一遍，让读数从一开始就是真的。
//
// 实现要点：
//   · DSH 的会话日志是「多帧 zstd 拼接」，Node 的 zstdDecompressSync 只解第一帧；
//     这里按帧魔数切分后逐帧解（实测 1639 帧 0 失败）。
//   · 只读 user/message 且 source.kind === 'user'，跳过宿主注入的上下文。
//   · 用 (时间, 文本) 去重，避免 fork 出来的会话重复计数。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { recordUser } from './heart.js'

const MAGIC = Buffer.from('28b52ffd', 'hex')
const DAY = 86_400_000

/** 解一个多帧 zstd 文件，返回拼接后的文本。 */
export function readZstdFrames(file) {
  const buf = readFileSync(file)
  const pieces = []
  let i = buf.indexOf(MAGIC)
  let start = i
  while (i !== -1) {
    const next = buf.indexOf(MAGIC, i + 4)
    const end = next === -1 ? buf.length : next
    try {
      pieces.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      /* 坏帧跳过，不打断整份 */
    }
    start = next
    i = next
  }
  return Buffer.concat(pieces).toString('utf8')
}

/** 从会话日志里抽出 (时间, 文本) 事件，只保留最近 days 天。 */
export function extractUserEvents(text, sinceMs) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj?.type !== 'user/message') continue
    const ts = obj.time
    if (!Number.isFinite(ts) || ts < sinceMs) continue
    const msg = obj.data || {}
    if (msg.source?.kind !== 'user') continue
    const body = (msg.content || [])
      .filter((c) => c?.type === 'text')
      .map((c) => c.text)
      .join(' ')
      .trim()
    if (!body || body.startsWith('<') || body.startsWith('Current ')) continue
    out.push([ts, body])
  }
  out.sort((a, b) => a[0] - b[0])
  return out
}

/** 扫 ~/.dsh/sessions 下的全部会话，把窗口内的事件重放进 state。 */
export function backfill(state, { root, days = 9, now = Date.now() } = {}) {
  const sessionsRoot = root || join(homedir(), '.dsh', 'sessions')
  const since = now - days * DAY
  const seen = new Set()
  let files = 0
  let events = 0

  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(sessionsRoot, d.name))
  } catch {
    return { files: 0, events: 0, note: 'sessions 目录读不到' }
  }

  for (const ws of workspaces) {
    let sessions = []
    try {
      sessions = readdirSync(ws, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      continue
    }
    for (const s of sessions) {
      const file = join(ws, s.name, 'session.v4.jsonl.zstd')
      let st
      try {
        st = statSync(file)
      } catch {
        continue
      }
      if (st.mtimeMs < since) continue
      files += 1
      let text = ''
      try {
        text = readZstdFrames(file)
      } catch {
        continue
      }
      for (const [ts, body] of extractUserEvents(text, since)) {
        const key = `${ts}|${body.slice(0, 40)}`
        if (seen.has(key)) continue
        seen.add(key)
        recordUser(state, body, ts, days)
        events += 1
      }
    }
  }
  return { files, events, note: 'ok' }
}
