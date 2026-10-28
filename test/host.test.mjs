// 插件层测试：用 mock 宿主跑 apply()，测坏文件、开关、大量事件
// 注意：会临时改写 ~/.dsh/relationship/state.json，跑完自动恢复
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const STATE = join(homedir(), '.dsh', 'relationship', 'state.json')
const BAK = `${STATE}.testbak`
if (existsSync(STATE)) copyFileSync(STATE, BAK)

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail += 1
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

function makeCtx() {
  const sections = []
  const tools = []
  const handlers = new Map()
  return {
    sections,
    tools,
    handlers,
    ctx: {
      effect: (fn) => {
        const it = fn()
        if (it && typeof it.next === 'function') {
          let r = it.next()
          while (!r.done) r = it.next()
        }
        return () => {}
      },
      on: (ev, fn) => { handlers.set(ev, fn) },
      systemPrompt: {
        section: (s) => { sections.push(s); return () => {} },
        getSectionOrder: () => 50,
      },
      tools: { register: (t) => { tools.push(t); return () => {} } },
    },
  }
}

// 直接测「部署后」的那份：它旁边就有真的 schemastery
const PLUGIN_ENTRY = 'C:/Users/XZN10/.dsh/profiles/desktop/node_modules/dsh-relationship-heart/lib/index.js'
const { apply } = await import(pathToFileURL(PLUGIN_ENTRY).href)

console.log('【普通测试：真实状态】')
{
  const m = makeCtx()
  apply(m.ctx, { enabled: true, windowDays: 7, order: 50, backfillOnFirstRun: false })

  await check('注册了一个 prompt 段', () => {
    if (m.sections.length !== 1) throw new Error(`sections=${m.sections.length}`)
    if (m.sections[0].name !== 'RELATIONSHIP_STATE') throw new Error(m.sections[0].name)
  })
  await check('段文本有内容且含「关系」', () => {
    const t = m.sections[0].text()
    if (!t.includes('关系')) throw new Error(t)
    if (t.length < 10 || t.length > 200) throw new Error(`len=${t.length}`)
  })
  await check('注册了两个工具', () => {
    const names = m.tools.map((t) => t.name)
    if (!names.includes('relationship_state')) throw new Error(names.join(','))
    if (!names.includes('relationship_roll')) throw new Error(names.join(','))
  })
  await check('工具能返回读数', async () => {
    const st = m.tools.find((t) => t.name === 'relationship_state')
    const out = await st.execute({}, {})
    if (!out.line) throw new Error(JSON.stringify(out))
    for (const k of ['intimacy', 'distance', 'unknown']) {
      const v = out.dims[k]
      if (!(v >= 0 && v <= 1)) throw new Error(`${k}=${v}`)
    }
  })
  await check('模拟一条 user/message 不崩', () => {
    const h = m.handlers.get('session/event')
    if (!h) throw new Error('没有 session/event 监听')
    h({}, { type: 'user/message', time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试一下' }] } })
  })
}

console.log('【暴力测试】')
{
  const m = makeCtx()
  apply(m.ctx, { enabled: true, windowDays: 7, order: 50, backfillOnFirstRun: false })
  const h = m.handlers.get('session/event')

  await check('10000 条事件：不崩、读数仍在范围内', async () => {
    const words = ['宝宝', '滚', '谢谢', '烦', 'x'.repeat(3000), '']
    for (let i = 0; i < 10000; i += 1) {
      h({}, {
        type: 'user/message',
        time: Date.now() - (i % 5000) * 60000,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: words[i % words.length] }] },
      })
    }
    const st = m.tools.find((t) => t.name === 'relationship_state')
    const out = await st.execute({}, {})
    if (!out.line) throw new Error('返回空')
    if (!(out.dims.intimacy >= 0 && out.dims.intimacy <= 1)) throw new Error('越界')
  })

  await check('坏事件（缺字段/坏时间/系统注入）被忽略', () => {
    h({}, { type: 'user/message', data: {} })
    h({}, { type: 'user/message', time: 'abc', data: { source: { kind: 'user' }, content: [] } })
    h({}, { type: 'user/message', time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>xx' }] } })
    h({}, { type: 'assistant/message', data: {} })
    h({}, null)
  })

  await check('掷骰结果在 [0,1]', async () => {
    const t = m.tools.find((x) => x.name === 'relationship_roll')
    for (let i = 0; i < 200; i += 1) {
      const r = await t.execute({}, {})
      if (!(r.p >= 0 && r.p <= 1)) throw new Error(`p=${r.p}`)
    }
  })
}

console.log('【开关】')
{
  const m = makeCtx()
  apply(m.ctx, { enabled: false, windowDays: 7, order: 50, backfillOnFirstRun: false })
  await check('enabled=false 时段文本为空', () => {
    const t = m.sections[0].text()
    if (t !== '') throw new Error(JSON.stringify(t))
  })
  await check('enabled=false 时工具返回 disabled', async () => {
    const st = m.tools.find((t) => t.name === 'relationship_state')
    const out = await st.execute({}, {})
    if (!out.disabled) throw new Error(JSON.stringify(out))
  })
}

console.log('【坏文件】')
{
  if (existsSync(STATE)) unlinkSync(STATE)
  writeFileSync(STATE, '{ 这不是 JSON', 'utf8')
  const m = makeCtx()
  await check('state.json 是坏 JSON 时不崩', () => {
    apply(m.ctx, { enabled: true, windowDays: 7, order: 50, backfillOnFirstRun: false })
    const t = m.sections[0].text()
    if (!t.includes('关系')) throw new Error(t)
  })
}

if (existsSync(BAK)) {
  copyFileSync(BAK, STATE)
  unlinkSync(BAK)
  console.log('\n（原 state.json 已恢复）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
