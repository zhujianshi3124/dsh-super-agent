/** The person's wrap-up and start of work (C-17b): wrapping up holds launches and reaches every worker through the foreman,
 * each settles at a clean node and its ticket ends wrapped, the panel says when it is safe to shut down, and starting work
 * tells the foreman to continue the unfinished tasks under their original instructions (N-13a). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ticketStop } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const foreman = () => h.runtime.rotation.foremanSession()
/** The three sentences C-17b items 2 and 6 fix, word for word. */
const WRAP_TO_FOREMAN = '用户收工：让每张正在工作的工单停在干净节点。'
const WRAP_TO_WORKER = '用户收工：做完手上这一步，把进度写进交接文档，报收工，不要开始下一步。'
const START_TO_FOREMAN = '用户开工：按原来的已确认清单，接着做收工时没做完的任务。'
/** The worker's turn ends, as DSH says it does. */
function endTurn(sessionId: string): void {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
const wrap = (ticketId: string) => h.runTool(foreman(), 'orchestrator_ticket_wrapup', { ticket_id: ticketId })
const stopOf = (ticketId: string) => ticketStop(h.runtime.store.tickets.get(ticketId)!)
const foremanNotice = (kind: string) => h.relays(foreman()).find(item => item.kind === kind)

it('wraps up through the foreman with the fixed sentence, once, and keeps the state for after a shutdown (C-17b items 2, 4)', async () => {
  const { ticket } = await h.acceptedTicket(feishu('1', '@bot 写第一章'))
  const view = h.runtime.wrapUp.wrapUp()
  expect(view).toMatchObject({ active: true, ready: false, settled: 0, working: [{ id: ticket.id }] })
  await vi.waitFor(() => expect(foremanNotice('wrap_up')).toMatchObject({ text: WRAP_TO_FOREMAN, open_tickets: [{ ticket_id: ticket.id }] }))
  expect(h.runtime.store.get(KV.wrapUp.state)).toEqual({ since: view.since })
  // A second click changes nothing and tells nobody again.
  expect(h.runtime.wrapUp.wrapUp().since).toBe(view.since)
  expect(h.relays(foreman()).filter(item => item.kind === 'wrap_up')).toHaveLength(1)
})

it('passes the wrap-up to a running worker, which reports wrapped: its ticket ends wrapped and it is safe to shut down (C-17b item 3)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写第一章'))
  h.runtime.wrapUp.wrapUp()
  expect(await wrap(ticket.id)).toMatchObject({ wrapping: true })
  await vi.waitFor(() => expect(h.relays(sessionId).map(item => item.text)).toContain(WRAP_TO_WORKER))
  expect(h.runtime.store.tickets.get(ticket.id)!.decisions?.at(-1)?.text).toContain('C-17b')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'wrapped', summary: '第一章写到第 3 节，进度写进了 STATE.md' })
  expect(stopOf(ticket.id)).toBe('wrapped')
  expect(h.runtime.wrapUp.status()).toMatchObject({ active: true, ready: true, settled: 1, working: [] })
})

it('ends a ticket wrapped when its worker\'s turn ends quietly, at its context threshold too, with no stop halfway and no successor (C-17b item 3, C-13b, C-13e)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写第一章'))
  h.runtime.hooks.requestRotation({ sessionId, ticketId: ticket.id, reason: 'real context usage 41% (>= 40% hard)', requestedBy: 'test' })
  h.runtime.wrapUp.wrapUp()
  expect(await wrap(ticket.id)).toMatchObject({ wrapping: true })
  endTurn(sessionId)
  await vi.waitFor(() => expect(stopOf(ticket.id)).toBe('wrapped'))
  // No successor opened, and the sentence was not sent to a worker that stops after this step anyway.
  expect(h.runtime.rotation.workerSession(ticket.id)).toBe(sessionId)
  expect(h.relays(`${sessionId}-r1`)).toEqual([])
  expect(h.relays(sessionId).map(item => item.text)).not.toContain(WRAP_TO_WORKER)
  const reports = h.relays(foreman()).filter(item => item.kind === 'worker_report'
    && (item.ticket as { ticket_id?: string } | undefined)?.ticket_id === ticket.id)
  expect(reports.at(-1)).toMatchObject({ state: 'wrapped' })
  expect(reports.some(item => item.state === 'waiting')).toBe(false)
})

it('keeps a ticket awaiting adjudication open and counts it settled; refuses outside a wrap-up and refuses new tickets during one (C-16a, C-17b)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写第一章'))
  await expect(wrap(ticket.id)).rejects.toThrow('No wrap-up is on')
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '主角名字用哪个？', human_action_kind: 3 })
  endTurn(sessionId)
  await h.runtime.idle()
  h.runtime.wrapUp.wrapUp()
  expect(await wrap(ticket.id)).toMatchObject({ settled: true, open: true })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  expect(h.runtime.wrapUp.status()).toMatchObject({ ready: true, settled: 1, working: [] })
  await expect(h.acceptedTicket(feishu('2', '@bot 写第二章'))).rejects.toThrow()
})

it('starts work: the hold lifts, the foreman hears the fixed sentence with the wrapped tickets, and history keeps both (C-17b items 6, 7)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 写第一章'))
  h.runtime.wrapUp.wrapUp()
  endTurn(sessionId)
  await vi.waitFor(() => expect(stopOf(ticket.id)).toBe('wrapped'))
  const view = h.runtime.wrapUp.startWork()
  expect(view).toMatchObject({ active: false, ready: false })
  expect(view.history.map(event => event.kind)).toEqual(['start-work', 'wrap-up'])
  expect(h.runtime.store.get(KV.wrapUp.state)).toBeUndefined()
  await vi.waitFor(() => expect(foremanNotice('start_work')).toMatchObject({ text: START_TO_FOREMAN, wrapped_tickets: [{ ticket_id: ticket.id }] }))
  // Starting again changes nothing; a new ticket may be dispatched once more.
  expect(h.runtime.wrapUp.startWork().history).toHaveLength(2)
  await expect(h.acceptedTicket(feishu('2', '@bot 写第二章'))).resolves.toMatchObject({ ticket: expect.anything() })
})
