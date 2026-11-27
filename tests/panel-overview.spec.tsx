// @vitest-environment jsdom
// The overview (C-37): pending adjudications, system problems, executor load, instructions, main Session, foreman.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, click, text } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
const quiet = () => {
  server.person = []; server.proposals = []; server.load = { running: 0, queued: 0 }
  server.master = { id: '', generation: 0, usage: null }
  server.foreman = { session: '', generation: 0, pending: false, usage: null, rotatedAt: null, open: true }
}

it('leads the overview with the tickets awaiting adjudication, each labelled by its C-15 kind', async () => {
  server.person = [ticketSummary({ attention: { id: 'q1', kind: 5, question: '要删除这个文件吗' },
    note: { text: '要删除这个文件吗', error: false } }, { stage: 'adjudication' }),
  ticketSummary({ id: 't2', title: '改文案', attention: { id: 'q2', kind: 3, question: '完成标准要变' },
    note: { text: '完成标准要变', error: false } }, { stage: 'adjudication' })]
  await mount()
  const pending = all('.dt-cards .dt-ticket')
  expect(pending.map(row => row.querySelector('.dt-ticket-stage')?.textContent)).toEqual(['危险操作', '目标或完成标准要变'])
  expect(text()).toContain('待处理工单')
  // Opening a pending ticket reads its report word for word on its own page.
  await click('修复回归')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('names a missing main Session or foreman with the workspace to open one in, linking to the Deployment settings', async () => {
  server.masterMissing = true; server.foremanMissing = true
  await mount()
  expect(text()).toContain('缺主会话')
  expect(text()).toContain('/w/chief')
  expect(text()).toContain('缺工头')
  expect(text()).toContain('D:/gongtou')
  await click(all('.dt-att-what button')[0]!)
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.deployment'])
})

it('collapses a seen problem in this browser only, and shows it again on request (C-38.6)', async () => {
  server.masterMissing = true
  await mount()
  const before = server.requests.length
  await click(zh.collapse)
  // Collapsing makes no request and changes no host state.
  expect(server.requests.length).toBe(before)
  expect(text()).not.toContain('缺主会话')
  expect(text()).toContain('已收起 1 条系统问题')
  await remount()
  expect(text()).not.toContain('缺主会话')
  await click('已收起 1 条系统问题 · 展开查看')
  await click(zh.problemShowAgain)
  expect(text()).toContain('缺主会话')
})

it('shows the executor load with a link to the Execution page, and nothing while idle', async () => {
  server.load = { running: 2, queued: 1 }
  await mount()
  expect(text()).toContain('2 / 3')
  expect(text()).toContain('排队')
  await click(zh['tab.execution'])
  expect(all('.dt-filters button').length).toBe(3)
})

it('lists the confirmed instructions read-only and opens one with its own words and tickets', async () => {
  await mount()
  expect(text()).toContain('pr-1')
  expect(text()).toContain('把登录页错字改一下')
  await click(all('.dt-open').find(button => button.textContent?.startsWith('pr-1'))!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('指令清单 pr-1')
  // The four times and every task stay readable; confirming happens in the conversation, never here (C-06).
  expect(text()).toContain('整理于')
  expect(text()).toContain('确认于')
  expect(text()).toContain('交给工头')
  expect(text()).toContain('派出工单')
  expect(text()).toContain('改登录页错字')
  expect(text()).toContain('首页加载优化')
  expect(all('button').some(button => button.textContent === zh.confirm)).toBe(false)
})

it('shows which main Session is current, its generation and context usage, and opens it', async () => {
  server.person = []
  server.master = { id: 'orchestrator-abc123', generation: 2, usage: 0.42 }
  await mount()
  expect(text()).toContain('orchestrator-abc123')
  expect(text()).toContain('第 3 代')
  expect(text()).toContain('42%')
  await click(zh.openSession)
  expect(server.opened).toEqual(['orchestrator-abc123'])
})

it('shows the foreman generation, usage, last rotation and a pending rotation', async () => {
  server.foreman = { session: 'superagent-foreman', generation: 1, pending: true, usage: null,
    rotatedAt: '2026-11-18T00:00:00Z', open: true }
  await mount()
  expect(text()).toContain('superagent-foreman')
  expect(text()).toContain('第 2 代')
  expect(text()).toContain('未记录')
  expect(text()).toContain('等换代')
  expect(text()).toContain('最近换代')
})

it('says all is quiet when nothing waits for the person, and shows the overview in English', async () => {
  quiet()
  await mount()
  expect(text()).toContain(zh.overviewQuiet)
  expect(text()).not.toContain('待处理工单')
  await remount(en)
  expect(text()).toContain('All quiet: nothing waits for the person.')
  expect(text()).toContain('Main Session')
  expect(text()).toContain('Foreman')
})