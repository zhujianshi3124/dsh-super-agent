/** A worker that stops before its ticket is done goes on (C-13b, C-13e): at its context threshold its successor continues at
 * once with no message from anyone and nothing told to anyone; halfway, the foreman lets it continue with the host's fixed
 * sentence, or ends a ticket that keeps stopping with no progress failed, and records why (C-30). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runningAssignment } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const foreman = () => h.runtime.rotation.foremanSession()
/** The sentence C-13e item 2 fixes, word for word. */
const CONTINUE = '从停下的地方接着干这张工单。'
/** The worker's turn ends, as DSH says it does. */
function endTurn(sessionId: string): void {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
/** The worker reports about `ticketId` that reached the foreman. */
const reportsOf = (ticketId: string) => h.relays(foreman()).filter(item => item.kind === 'worker_report'
  && (item.ticket as { ticket_id?: string } | undefined)?.ticket_id === ticketId)
/** A ticket whose worker's turn ended with no report and no question: it stopped halfway (C-13e item 1). */
async function stalledTicket(id = '1') {
  const accepted = await h.acceptedTicket(feishu(id, `@bot 第 ${id} 件事`))
  endTurn(accepted.sessionId)
  await vi.waitFor(() => expect(runningAssignment(h.runtime.store.tickets.get(accepted.ticket.id)!)?.report).toMatchObject({ state: 'waiting' }))
  return accepted
}
const decide = (ticketId: string, action: 'continue' | 'spinning', reason = '看过进展') =>
  h.runTool(foreman(), 'orchestrator_ticket_continue', { ticket_id: ticketId, action, reason })

it('continues a worker that stopped at its context threshold in its successor at once, telling nobody (C-13b, N-11)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  h.runtime.hooks.requestRotation({ sessionId, ticketId: ticket.id, reason: 'real context usage 41% (>= 40% hard)', requestedBy: 'test' })
  expect(h.runtime.rotation.workerRotationPending(ticket.id)).toBe(true)
  h.deliveries.mockClear()
  // The worker finishes its step at the line and its turn ends; no Input, launch or foreman message follows.
  endTurn(sessionId)
  const successor = `${sessionId}-r1`
  await vi.waitFor(() => expect(h.runtime.rotation.workerSession(ticket.id)).toBe(successor))
  await vi.waitFor(() => expect(h.relays(successor).some(item => 'rotation' in item)).toBe(true))
  expect(h.agents.get(successor)!.status).toBe('running')
  expect(h.runtime.store.get(KV.rotation.worker(ticket.id))).toMatchObject({ current: successor, generation: 1, previous: [sessionId] })
  expect(h.runtime.rotation.workerRotationPending(ticket.id)).toBe(false)
  // The same ticket goes on: no stop, no stop halfway, and the rotation is reported to nobody (C-13b).
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.ended).toBeUndefined()
  expect(runningAssignment(stored)?.report?.state).not.toBe('waiting')
  expect(reportsOf(ticket.id)).toEqual([])
})

it('tells the foreman of a worker that stopped halfway and continues it with the fixed sentence, recorded in the ticket (C-13e, C-30)', async () => {
  const { ticket, sessionId } = await stalledTicket()
  expect(reportsOf(ticket.id).at(-1)).toMatchObject({ state: 'waiting', summary: expect.stringContaining('orchestrator_ticket_continue') })
  h.deliveries.mockClear()
  expect(await decide(ticket.id, 'continue', '上次停下前写完了第 3 章，有进展')).toMatchObject({ continued: true, ticket: { ticket_id: ticket.id } })
  await vi.waitFor(() => expect(h.relays(sessionId).map(item => item.text)).toContain(CONTINUE))
  const stored = h.runtime.store.tickets.get(ticket.id)!
  expect(stored.ended).toBeUndefined()
  expect(stored.decisions?.at(-1)?.text).toMatch(/C-13e.*上次停下前写完了第 3 章/)
  // The sentence reached the worker: it has work again, so it did not stop halfway until its turn ends once more.
  await vi.waitFor(() => expect(runningAssignment(h.runtime.store.tickets.get(ticket.id)!)?.deliveredAt).toBeDefined())
  await expect(decide(ticket.id, 'continue')).rejects.toThrow('did not stop halfway')
})

it('lets the successor continue when a rotation waits as the foreman continues a ticket (C-13e item 2, C-13b)', async () => {
  const { ticket, sessionId } = await stalledTicket()
  h.runtime.hooks.requestRotation({ sessionId, ticketId: ticket.id, reason: 'real context usage 40% (>= 40% hard)', requestedBy: 'test' })
  h.deliveries.mockClear()
  await decide(ticket.id, 'continue')
  const successor = `${sessionId}-r1`
  await vi.waitFor(() => expect(h.relays(successor).map(item => item.text)).toContain(CONTINUE))
  expect(h.relays(successor).some(item => 'rotation' in item)).toBe(true)
  expect(h.relays(sessionId).map(item => item.text)).not.toContain(CONTINUE)
  expect(h.runtime.rotation.workerSession(ticket.id)).toBe(successor)
})

it('ends a ticket that keeps stopping halfway failed, with the reason recorded, and its worker takes nothing more (C-13e, N-13)', async () => {
  const { ticket, sessionId } = await stalledTicket()
  expect(await decide(ticket.id, 'spinning', '连续停下三次，中间没有新进展')).toMatchObject({ stopped: true, by: 'foreman', stop: 'failed',
    note: expect.stringContaining('N-13a') })
  const ended = h.runtime.store.tickets.get(ticket.id)!
  expect(ended.ended).toMatchObject({ by: 'foreman', stop: 'failed', reason: '连续停下三次，中间没有新进展' })
  expect(ended.decisions?.at(-1)?.text).toContain('C-13e')
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '做完了' })).rejects.toThrow()
})

it('refuses a ticket whose worker still works or waits for the person, either way (C-13e item 1, C-16a)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  await expect(decide(ticket.id, 'continue')).rejects.toThrow('did not stop halfway')
  await expect(decide(ticket.id, 'spinning')).rejects.toThrow('did not stop halfway')
  // A question at a clean node waits for the person's adjudication; it is no stop halfway.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'need a decision', human_action: '桌面端也改吗？', human_action_kind: 3 })
  endTurn(sessionId)
  await h.runtime.idle()
  await expect(decide(ticket.id, 'continue')).rejects.toThrow('did not stop halfway')
  await expect(decide(ticket.id, 'spinning')).rejects.toThrow('did not stop halfway')
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeUndefined()
  await expect(decide('no-such-ticket', 'continue')).rejects.toThrow('Unknown ticket')
})
