// @vitest-environment jsdom
// The Execution status, a Ticket page, and the Execution settings (C-37d, C-37f.1, C-38).
import { act } from 'react'
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, type, text, field, at } from './fixtures/panel.tsx'
import { MEMBER, actor, problemOf, server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
const openTicket = async (id = 't1') => {
  await mount()
  await click(zh['tab.execution'])
  await click(all('.dt-ticket .dt-open').find(button => button.textContent === (id === 't1' ? '修复回归' : '旧工单'))!)
}

it('lists tickets under Execution by the three filters, with the executor state and its pause as a confirmed action', async () => {
  await mount()
  await click(zh['tab.execution'])
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh.statusTitle)
  expect(server.requests.some(request => request.path === 'tickets?state=working&limit=20')).toBe(true)
  expect(text()).toContain(zh.executorRunning)
  expect(all('.dt-status-line .dt-lv').map(item => item.textContent)).toEqual(['执行中 2 / 3', '排队 0'])
  expect(all('.dt-ticket .dt-open').map(button => button.textContent)).toEqual(['修复回归'])
  await click(zh['ticketFilter.ended'])
  expect(server.requests.some(request => request.path === 'tickets?state=ended&limit=20')).toBe(true)
  expect(all('.dt-ticket .dt-open').map(button => button.textContent)).toEqual(['旧工单'])
  await click(zh['ticketFilter.all'])
  expect(all('.dt-ticket .dt-open').map(button => button.textContent)).toEqual(['修复回归', '旧工单'])
  // Pausing only stops dispatching new tickets; no ticket's state changes (C-37d.1).
  await click(zh.pauseDispatch)
  expect(text()).toContain(zh.pauseDispatchConfirm)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'executor/pause' && request.method === 'POST'
    && JSON.stringify(request.body) === '{"paused":true}')).toBe(true)
  expect(text()).toContain(zh.dispatchPaused)
  expect(all('.dt-ticket').length).toBe(2)
})

it('shows the executor waiting for the deployment check instead of load, keeping pause available', async () => {
  server.setup.problem = problemOf('agentCliUnset')
  await mount()
  await click(zh['tab.execution'])
  expect(text()).toContain(zh.executorWaitingSetup)
  expect(all('.dt-status-line .dt-lv')).toHaveLength(0)
})

it('stops an open ticket from its row after confirmation; an ended ticket offers no stop', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(zh.stop)
  expect(text()).toContain('停止“修复回归”？')
  await click(zh.confirm)
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toHaveLength(1)
  expect(all('.dt-ticket')).toHaveLength(0)
  expect(text()).toContain(zh.none)
  await click(zh['ticketFilter.ended'])
  expect(all('.dt-ticket .dt-open').map(button => button.textContent)).toEqual(['修复回归', '旧工单'])
  expect(all('.dt-ticket-actions button').some(button => button.textContent === zh.stop)).toBe(false)
})

it('sends one stop for a double click on Confirm', async () => {
  await openTicket()
  await click(all('.dt-danger-zone button').find(button => button.textContent === zh.stop)!)
  const confirm = all('[role="dialog"] button').find(button => button.textContent === zh.confirm)!
  await act(async () => { confirm.click(); confirm.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(server.requests.filter(request => request.path === 'tickets/t1/stop' && request.method === 'POST')).toHaveLength(1)
})

it('shows a ticket with its stage, report word for word, criteria, inputs, dispatch history, sessions and identifiers', async () => {
  await openTicket()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  expect(document.querySelector('.dt-status-line .dt-stage')?.textContent).toBe('干活中')
  expect(text()).toContain('正在工作')
  expect(text()).toContain('working on it')
  expect(text()).toContain('按钮文案没有错字')
  // Undelivered and delivered inputs are apart, each saying whether it reached the worker.
  expect(text()).toContain('未送达的输入')
  expect(text()).toContain('顺便改标题')
  expect(text()).toContain('已投递的输入 · 1')
  expect(text()).toContain('记得跑一遍测试')
  expect(text()).toContain('第 1 次派工')
  expect(text()).toContain('第 1 代会话')
  expect(text()).toContain('worker-t1')
  expect(text()).toContain('当前')
  // The environment disclosure masks a secret by name only (C-37d.4).
  await click(zh.environmentTitle)
  expect(text()).toContain('DSH_SUPERAGENT_DIR')
  expect(text()).toContain('/w/t1')
  expect(text()).toContain('DSH_SUPERAGENT_GITHUB_TOKEN')
  expect(text()).toContain(zh.environmentMasked)
  await click(zh.identifiers)
  expect(text()).toContain('干活目录')
})

it('words an ended ticket by its stop reason on its row and its page, with who stopped it and why', async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(zh['ticketFilter.ended'])
  expect(document.querySelector('.dt-ticket .dt-stage')?.textContent).toBe('用户叫停')
  await click('旧工单')
  expect(text()).toContain('停止 · 用户叫停')
  expect(text()).toContain('由谁停止')
  expect(text()).toContain('用户')
  expect(text()).toContain('Human asked to stop')
  expect(all('.dt-danger-zone')).toHaveLength(0)
})

it('shows the adjudication question, the instruction it carries, the task, and the ticket it continues', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'adjudication',
    attention: { id: 'q1', kind: 2, question: '需要登录授权' }, proposal: 'pr-1', task: 0, continues: 't0', waitingFor: 'worker-named' }
  await openTicket()
  expect(document.querySelector('.dt-banner')?.textContent).toContain('只有用户能做：登录、授权、凭据、按钮')
  expect(document.querySelector('.dt-banner')?.textContent).toContain('需要登录授权')
  expect(text()).toContain('指令清单 pr-1')
  expect(text()).toContain('任务序号 1')
  expect(text()).toContain('续自工单 t0')
  expect(text()).toContain('点名等待的会话')
  expect(text()).toContain('worker-named')
  await click('续自工单 t0')
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('旧工单')
})

it('folds consecutive automated messages among inputs, and shows a hand-back with why', async () => {
  const bot = actor('feishu', '', false)
  const automated = (id: string, at: string) => ({ id, kind: 'trigger' as const, triggerId: id, at, delivered: true,
    trigger: { id, actor: bot, human: false, preview: `自动消息 ${id}`, thread: 'feishu:oc_1:om_root' } })
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, inputs: [
    { id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:05:00Z', delivered: true,
      trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root',
        handback: { reason: '不是这张工单的事', at: '2026-09-22T00:06:00Z' } } },
    automated('a3', '2026-09-22T00:04:00Z'), automated('a2', '2026-09-22T00:03:00Z'), automated('a1', '2026-09-22T00:02:00Z')] }
  await openTicket()
  expect(text()).toContain('工人已交回：不是这张工单的事')
  expect(text()).toContain('自动消息 a3')
  expect(text()).not.toContain('自动消息 a2')
  await click('同一发送者之前还有 2 条自动消息')
  expect(text()).toContain('自动消息 a2')
  expect(text()).toContain('自动消息 a1')
})

it('says why an input was not delivered: paused dispatch, or a delivery that keeps retrying', async () => {
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, paused: true }
  await openTicket()
  expect(text()).toContain(zh.inputPausedHint)
})

it('keeps what a person types in the Execution settings, converting it once on save', async () => {
  at({ page: 'settings', query: { group: 'execution' } })
  await mount()
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  await type(field<HTMLInputElement>(zh.stuckMinutes), '30')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal, foo')
  // The draft keeps the raw text; only the save parses it.
  expect(field<HTMLInputElement>(zh.blockedCommands).value).toBe('gh-personal, foo')
  expect(text()).toContain('留空时用 D:/buzhiding')
  await type(field<HTMLInputElement>(zh.executionDirectory), 'D:/work')
  await click(zh.save)
  const save = server.requests.find(request => request.path === 'settings/executor' && request.method === 'PUT')!
  expect(save.body).toMatchObject({ revision: 0, value: { maxWorkers: 5, stuckMinutes: 30, blockedCommands: ['gh-personal', 'foo'],
    directory: 'D:/work' } })
  expect(text()).toContain(zh.saved)
})