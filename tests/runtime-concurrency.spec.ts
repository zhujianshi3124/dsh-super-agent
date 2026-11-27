/** Concurrent runtime behavior across overlapping triggers, deliveries, and worker launches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, type Ticket, type Trigger } from '../src/core/index.ts'
import { Later } from '../src/app/effects.ts'
import { reportRelay } from '../src/app/notices.ts'
import { WorkerSlots, inputMessage, mandateInstructions, ticketExecution, transient, triggerMessage } from '../src/executor/dsh.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
const linkLookedUp = (messageId: string) =>
  vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('+messages-mget') && args.includes(messageId))
/** Hold the first resolution of a Session until `gate` resolves; `held()` says whether it began. */
function holdSession(sessionId: string, gate: Promise<void>) {
  let held = false
  h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === sessionId && !held) { held = true; await gate } return h.resolveDefault(id) })
  return () => held
}
/** The turn of a Session's agent ends, and DSH says so. */
const idle = (sessionId: string) => {
  const agent = h.agents.get(sessionId)!
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}

it('evaluates a message that arrives on a thread while an earlier candidate\'s card waits for its link, in the thread\'s next Eval', async () => {
  const gate = deferred()
  // The first candidate's source link lookup is slow; Feishu allows it up to linkTimeoutMs.
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => { if (args.includes('+messages-mget') && args.includes('om_1')) await gate.promise; return lark })
  await h.runtime.settings.pause(true, 'panel')
  const a1 = feishu('1', '@bot 修 A'), b1 = feishu('2', '@bot 修 B'), b2 = feishu('3', '@bot B 还有这个', { root_id: 'om_2' })
  h.runtime.receive(a1); h.runtime.receive(b1)
  await h.runtime.settings.pause(false, 'panel')
  await waitUntil(() => linkLookedUp('om_1'))
  h.runtime.receive(b2)
  gate.resolve(); await h.runtime.idle()
  const threadB = `feishu:${CHAT}:om_2`
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b1.id] }, pending: [b2.id] })
  await h.route({ kind: 'ignore', trigger_id: b1.id, reason: 'duplicate' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b2.id] }, pending: [] })
  // A slow link lookup holds only its own candidate's card.
  expect(h.candidates()).toEqual([b1.id, a1.id, b2.id])
})

it('delivers nothing to a ticket a person stopped while an earlier ticket\'s delivery waited', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  h.runtime.receive(feishu('6', '二的补充', { mentions: [], root_id: 'om_5', sender_id: 'ou_guest' }))
  // Tickets are processed newest-first, so holding ticket two pauses the pass before ticket one is delivered.
  const gate = deferred()
  const held = holdSession(two.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ ended: { by: 'human' }, undelivered: [] })
})

it('drops a delivery whose ticket a person stopped while it waited for the worker Session', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  const gate = deferred()
  const held = holdSession(one.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await resumed; await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).not.toHaveProperty('delivery')
})

const botMessage = () => feishu('2', 'CI 失败', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' })
it('wakes an idle worker for a bot\'s Input only when a worker slot is free, and creates a worker Session someone deleted again', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(botMessage()); await h.runtime.idle()
  // Ticket two's worker takes the only slot, so ticket one's Input waits.
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  h.agents.get(two.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})

it('wakes an idle worker for a person\'s message at once, in the slot kept beyond the limit', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})

it('records on the ticket that its worker Session could not be created again', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.agents.get(one.sessionId)!.status = 'idle'
  h.agents.delete(one.sessionId)
  h.controller.resolveAgent.mockImplementation(async (id: string) => {
    if (id === one.sessionId) throw new Error('The Session store is offline')
    return h.resolveDefault(id)
  })
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ delivery: { error: expect.stringContaining('The Session store is offline') } })
})

it('lets a worker go on after a passing provider failure, three times, before its ticket fails', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  const fail = (error: unknown) => { h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error } as never) }
  const busy = Object.assign(new Error('Service Unavailable'), { status: 503 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    fail(busy)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === one.sessionId).at(-1)!.text)
      .toContain('Your last turn failed for a passing reason')
    expect(latestAssignment(ticket())?.report).toBeUndefined()
  } finally { vi.useRealTimers() }
  fail(busy); fail(busy)
  expect(latestAssignment(ticket())?.report).toBeUndefined()
  // The fourth passing failure fails the ticket, as any other failure does at once.
  fail(busy)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Service Unavailable') }))
})
describe('a worker that goes on after a passing failure', () => {
  const busy = () => Object.assign(new Error('Service Unavailable'), { status: 503 })
  const told = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === sessionId && call.text.includes('Your last turn failed for a passing reason'))
  it('starts the count of passing failures again once its turn ends as turns do', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const fail = () => { h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never) }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try { fail(); fail(); fail(); await vi.advanceTimersByTimeAsync(60_000) } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(3)
    // Once the resumed turn ends normally, a later passing failure starts a new retry count rather than counting as the fourth in a row.
    agent.status = 'idle'
    h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    fail()
    await h.runtime.idle()
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
  })
  it('waits while processing is paused, and goes on once it resumes', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    agent.status = 'idle'
    await h.runtime.settings.pause(true, 'panel')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: busy() } as never)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(told(one.sessionId)).toEqual([])
      await h.runtime.settings.pause(false, 'panel')
      await vi.advanceTimersByTimeAsync(5000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(1)
  })
  it('drops its timer when the host stops within the backoff', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.ctx.emit('agent/error', { agent: h.agents.get(one.sessionId), turn: 1, step: 1, error: busy() } as never)
      await h.runtime.stop()
      // Its timer is cleared with the Executor, so nothing reads the closed database.
      await vi.advanceTimersByTimeAsync(60_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toEqual([])
  })
})
describe('a worker whose work runs in the background', () => {
  it('stays busy while its shell job runs, holding its slot, and reports waiting once the job ended and its turn ends', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    // No waiting report and nothing relayed while the job runs; the next ticket waits for the slot the job holds.
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(latestAssignment(h.runtime.store.tickets.get(two.ticket.id)!)).toMatchObject({ state: 'pending' })
    // The job ends, which wakes the worker with its result; its turn ends, and it reports waiting.
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('stays busy while a subagent of it works, and reports waiting once the turn its end woke it for ends', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    const child = h.subagents.spawn(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    expect(latestAssignment(ticket())?.report).toBeUndefined()
    h.subagents.settle(child)
    expect(h.agents.get(one.sessionId)!.status).toBe('running')
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
  })
  it('kills its shell jobs and releases its subagents when its ticket stops, whose ends wake no one, and lets it start new ones', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    h.runtime.engine.stopTicket(one.ticket.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalledWith(agent, [child]))
    // The kill's end released the stop's own wait, which is how DSH tells the worker's job tools it was collected; the
    // released subagent's end, which DSH delivers before the release returns, is dropped with the turn it woke.
    expect(h.jobs.released).toBe(1)
    await vi.waitFor(() => expect(agent.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder[0]!))
    expect(agent.cancel).toHaveBeenLastCalledWith({ kind: 'user' }, { keepInbox: false })
    // Its Session still admits subagents, as when the ticket resumes.
    expect(() => h.subagents.spawn(one.sessionId)).not.toThrow()
  })
  /**
   * A worker that hands off to a person, with `report`, frees its slot and stops its subagents; its job, a server for the
   * person, runs on, and its end wakes no one.
   */
  async function handsOff(report: Record<string, unknown>, before?: (ticketId: string) => void) {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    before?.(one.ticket.id)
    const job = h.jobs.run(one.sessionId, 'pnpm dev'), child = h.subagents.spawn(one.sessionId)
    await h.runTool(one.sessionId, 'orchestrator_report', report); await h.runtime.idle()
    const relayed = h.relays(h.runtime.rotation.foremanSession()).length
    idle(one.sessionId); await h.runtime.idle()
    // The subagent stops, and the turn its end woke is cancelled; the job's end is collected.
    await vi.waitFor(() => expect(h.subagents.live(child)).toBe(false))
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.status).toBe('idle'))
    expect(h.jobs.service.wait).toHaveBeenCalledWith(job, expect.any(Number), one.sessionId, expect.anything())
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.jobs.service.kill).not.toHaveBeenCalled()
    h.jobs.end(job)
    expect(h.agents.get(one.sessionId)!.status).toBe('idle')
    expect(h.jobs.released).toBe(1)
    // The worker reads of the end at its next turn.
    await vi.waitFor(() => expect(h.agents.get(one.sessionId)!.inject).toHaveBeenCalledWith(expect.objectContaining({
      content: [expect.objectContaining({ text: `Your background job ${job} (pnpm dev) ended: completed.` })] })))
    await h.runtime.idle()
    expect(h.runtime.executor.activeCount()).toBe(0)
    expect(h.relays(h.runtime.rotation.foremanSession())).toHaveLength(relayed)
    expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toMatchObject({ state: report.state })
    return one
  }
  it('frees the slot of a worker that asks a person a question with a progress report', async () => {
    await handsOff({ state: 'progress', summary: 'The server runs.', human_action: 'Does the button look right?' })
  })
  it('leaves the background work of a turn a person started in the worker\'s Session after a hand-off to that turn', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'The server runs.', human_action: 'Which color?' }); await h.runtime.idle()
    // A person answers in the worker's Session, which the ticket does not record; the turn starts a subagent and a job.
    await new Promise(resolve => setTimeout(resolve, 5))
    h.ctx.emit('agent/inbox/claimed', { agent, message: { id: 'typed', role: 'user', content: [], source: { kind: 'user' } }, turn: 2 } as never)
    const child = h.subagents.spawn(one.sessionId), job = h.jobs.run(one.sessionId)
    idle(one.sessionId); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    // They keep the worker busy, as any turn's background work does.
    expect(h.subagents.live(child)).toBe(true)
    expect(h.jobs.service.wait).not.toHaveBeenCalled()
    expect(h.runtime.executor.activeCount()).toBe(1)
    h.subagents.settle(child); h.jobs.end(job)
    expect(agent.status).toBe('running')
  })
  it('records each end of a worker\'s turn on its Assignment, also after its hand-off to a person', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'The server runs.', human_action: 'Which color?' }); await h.runtime.idle()
    const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report!
    await new Promise(resolve => setTimeout(resolve, 5))
    idle(one.sessionId); await h.runtime.idle()
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.idleAt! > report.at).toBe(true))
  })
  it('shows no turn end on a running Assignment whose worker works again, whatever turn ends were recorded', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'On it again' })
    const page = await h.api('GET', `tickets/${one.ticket.id}`)
    expect((page.body as { assignments: Record<string, unknown>[] }).assignments[0]).not.toHaveProperty('turnEndedAt')
  })
  it('keeps an Input a restart found handed over to a settled worker, and delivers a waiting one once its subagents stopped', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!, ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    // A subagent still runs, whose release is slow; one Input waits in the Session's inbox, another in the ticket.
    h.subagents.spawn(one.sessionId)
    const gate = deferred(), drain = h.subagents.service.drainChildren.getMockImplementation()!
    h.subagents.service.drainChildren.mockImplementationOnce(async (parent, ids) => { await gate.promise; await drain(parent, ids) })
    agent.inbox.nextStep.push({ id: 'taken-later', role: 'user', content: [{ type: 'text', text: 'Handed over' }], source: { kind: 'user' } } as never)
    const stored = ticket()
    stored.inputs.push({ id: 'input-late', kind: 'text', text: 'One more thing', at: new Date().toISOString() })
    stored.undelivered.push('input-late')
    h.runtime.store.tickets.save(stored)
    // The delivery waits for the release, so the effects are not idle until it ends.
    h.runtime.executor.resume()
    await new Promise(resolve => setTimeout(resolve, 20))
    const late = expect.objectContaining({ sessionId: one.sessionId, text: expect.stringContaining('One more thing') })
    expect(h.deliveries).not.toHaveBeenCalledWith(late)
    const reports = () => h.relays(h.runtime.rotation.foremanSession()).filter(item => item.kind === 'worker_report').length
    const reported = reports()
    gate.resolve()
    await vi.waitFor(() => expect(h.deliveries).toHaveBeenCalledWith(late))
    expect(agent.cancel).not.toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(agent.inbox.nextStep.map(message => message.id)).toContain('taken-later')
    // The turn the subagent's end woke and the release cancelled reports nothing.
    await h.runtime.idle()
    expect(reports()).toBe(reported)
  })
  it('collects the end of a job left to a person until dsh-superagent stopped its workers', async () => {
    const one = await handsOff({ state: 'progress', summary: 'The server runs.', human_action: 'Which color?' })
    const agent = h.agents.get(one.sessionId)!
    const server = h.jobs.run(one.sessionId, 'pnpm dev')
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Still running.', human_action: 'Which size?' }); await h.runtime.idle()
    idle(one.sessionId)
    await vi.waitFor(() => expect(h.jobs.service.wait).toHaveBeenCalledWith(server, expect.any(Number), one.sessionId, expect.anything()))
    // The server ends while the host stops, after it cancelled the workers.
    const cancel = agent.cancel.getMockImplementation()!
    agent.cancel.mockImplementationOnce((...args: unknown[]) => { h.jobs.end(server); return cancel(...args as [unknown, { keepInbox?: boolean }]) })
    const woken = agent.followup.mock.calls.length
    await h.stop()
    expect(agent.followup.mock.calls.length).toBe(woken)
    expect(agent.status).toBe('idle')
  })
  it('stops every worker\'s jobs and subagents when dsh-superagent stops, before it releases their tool limits', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId), child = h.subagents.spawn(one.sessionId)
    await h.stop()
    expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String))
    expect(h.subagents.live(child)).toBe(false)
  })
  it('cancels no worker for a subagent that ended before, and cancels the turn a release woke also when the release fails', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const agent = h.agents.get(one.sessionId)!
    h.subagents.settle(h.subagents.spawn(one.sessionId))
    // Its ready report ends the ticket, and it ends its own turn.
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' })
    await h.runtime.idle(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(agent.cancel).not.toHaveBeenCalled()
    // A release that fails after the ends woke the worker still cancels that turn.
    const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
    const other = h.agents.get(two.sessionId)!
    const child = h.subagents.spawn(two.sessionId)
    h.subagents.service.drainChildren.mockImplementationOnce(async () => { h.subagents.settle(child); throw new Error('ACTIVATION_TEARDOWN_FAILED') })
    h.runtime.engine.stopTicket(two.ticket.id)
    await vi.waitFor(() => expect(h.subagents.service.drainChildren).toHaveBeenCalled())
    await vi.waitFor(() => expect(other.cancel.mock.invocationCallOrder.at(-1)).toBeGreaterThan(h.subagents.service.drainChildren.mock.invocationCallOrder.at(-1)!))
  })
  it('stops the jobs and the turn of a worker a restart in this process left running, before its Assignment starts again', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const job = h.jobs.run(one.sessionId)
    h.runtime.executor.resume()
    expect(h.agents.get(one.sessionId)!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(job, one.sessionId, expect.any(String)))
    expect(h.runtime.store.tickets.get(one.ticket.id)!.inputs).toEqual([expect.objectContaining({ kind: 'text', text: expect.stringContaining('host restarted') })])
  })
  it('stops a ticket whose worker Session was never created without a health error, and goes on past a failing kill', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    await h.acceptedTicket(feishu('1', '@bot 修一'))
    const queued = await h.acceptedTicket(feishu('5', '@bot 修二'))
    expect(h.agents.has(queued.sessionId)).toBe(false)
    // DSH cannot list the children of a Session that does not exist.
    const list = h.subagents.service.listChildren.getMockImplementation()!
    h.subagents.service.listChildren.mockImplementation(async (id: string) => {
      if (id === queued.sessionId) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      return list(id)
    })
    h.runtime.engine.stopTicket(queued.ticket.id); await h.runtime.idle()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.runtime.health.worker?.state).not.toBe('error')
    // A kill that throws leaves the other jobs to be killed.
    const one = h.runtime.store.tickets.list().find(ticket => ticket.id !== queued.ticket.id)!
    const sessionId = `worker-${one.id}`
    const [first, second] = [h.jobs.run(sessionId), h.jobs.run(sessionId)]
    h.jobs.service.kill.mockImplementationOnce(() => { throw new Error('No such process') })
    h.runtime.engine.stopTicket(one.id)
    await vi.waitFor(() => expect(h.jobs.service.kill).toHaveBeenCalledWith(second, sessionId, expect.any(String)))
    expect(h.jobs.service.kill).toHaveBeenCalledWith(first, sessionId, expect.any(String))
  })
})
describe('what a worker read', () => {
  const later = () => new Promise(resolve => setTimeout(resolve, 5))
  it('counts a delivered message as read only once its step took it into the Session, not when a cut-off step claimed it', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const input = () => h.runtime.store.tickets.get(one.ticket.id)!.inputs.find(item => item.kind === 'trigger' && item.triggerId === more.id) as
      { readAt?: string | null }
    await vi.waitFor(() => expect(input().readAt).toBe(null))
    // A step claims it and is cut off before the Session took it, as a cancel in its pre-step does, which drops the message.
    h.claim(one.sessionId); await h.runtime.idle(); await later()
    expect(input().readAt).toBe(null)
  })
  it('keeps a note waiting in a worker\'s Session across an in-process restart, for the next Assignment\'s first step', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.note(one.ticket.id, 'Ticket B changes the same page.'); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('Ticket B changes the same page.'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    const claimed: string[] = []
    h.ctx.on('agent/inbox/claimed', ({ message }) => { claimed.push(message.id) })
    // The restart cancels the worker's turn and keeps its inbox, where the note waits.
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(claimed).toContain(copies()[0]![0].id))
    expect(copies()).toHaveLength(1)
  })
  it('delivers once a message a crash left waiting in a worker\'s Session, which the restart puts back for the next Assignment', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const copies = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下'))
    await vi.waitFor(() => expect(copies()).toHaveLength(1))
    // The process dies: the worker's agent is not loaded when the restart runs, and its inbox, which holds the message,
    // persists for the launch that loads it.
    const agent = h.agents.get(one.sessionId)!
    h.agents.delete(one.sessionId); agent.status = 'idle'
    h.controller.resolveAgent.mockImplementation(async (id: string) => { if (id === one.sessionId) h.agents.set(id, agent); return h.resolveDefault(id) })
    const waiting: string[][] = [], launch = agent.followup.getMockImplementation()!
    agent.followup.mockImplementation(message => { waiting.push([...agent.inbox.nextTurn, ...agent.inbox.nextStep].map(item => item.id)); launch(message) })
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(copies()).toHaveLength(2))
    // The launch's message found no copy of it waiting, which its step would take beside the copy delivered after.
    expect(waiting[0]).not.toContain(copies()[0]![0].id)
  })
  it('gives the Assignment an in-process restart starts a message a cut-off step had claimed, once', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.receive(feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
    const sent = () => h.deliveries.mock.calls.filter(([call]) => call.sessionId === one.sessionId && call.text.includes('再改一下')).length
    await vi.waitFor(() => expect(sent()).toBe(1))
    // A step claims it and the restart cuts the step off before the Session took it, which drops it.
    h.claim(one.sessionId)
    h.runtime.executor.resume()
    await vi.waitFor(() => expect(sent()).toBe(2))
    await h.runtime.idle(); await later()
    expect(sent()).toBe(2)
  })
})
it('reports nothing for a worker whose turn ends while it waits out the backoff of a passing failure', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const agent = h.agents.get(one.sessionId)!
  const relayed = h.relays(h.runtime.rotation.foremanSession()).length
  h.ctx.emit('agent/error', { agent, turn: 1, step: 1, error: Object.assign(new Error('Service Unavailable'), { status: 503 }) } as never)
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await h.runtime.idle()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
  expect(h.relays(h.runtime.rotation.foremanSession())).toHaveLength(relayed)
})
it('wakes an idle worker for a status request in the slot kept for a person, while every other slot is taken', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Its worker ended its turn without a report, so it waits.
  h.agents.get(one.sessionId)!.status = 'idle'
  h.ctx.emit('agent/status', { agent: h.agents.get(one.sessionId), status: 'idle' } as never)
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  expect(h.agents.get(two.sessionId)!.status).toBe('running')
  expect(h.runtime.engine.requestStatus(one.ticket.id)).toBe(true); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.agents.get(one.sessionId)!.status).toBe('running')
})
it('tells a passing failure of the provider or the network from one that a later try would meet again', () => {
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }),
    Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed'), new Error('getaddrinfo EAI_AGAIN api.example.com')]) {
    expect(transient(error)).toBe(true)
  }
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'LlmError: offline']) {
    expect(transient(error)).toBe(false)
  }
})
it('sends a message a person wrote to an ended ticket during a pause to Eval once it lifts, under the Policy then', async () => {
  const pass = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  const ended = async (id: string) => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu(id, `@bot 修${id}`, { root_id: `om_${id}` }))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    return ticket.id
  }
  const first = await ended('1'), second = await ended('3')
  const followUp = async (id: string, root: string) => {
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: root })); await h.runtime.idle()
  }
  // While processing is paused, the message waits on the Thread, not on the ended ticket.
  await followUp('2', 'om_1')
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ ended: expect.anything(), undelivered: [] })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(first)!.ended).toBeDefined()
  expect(h.runtime.store.tickets.get(first)!.assignments).toHaveLength(1)
  const thread = h.runtime.store.threads.get(`feishu:${CHAT}:om_1`)!
  expect(thread.evaluating ?? thread.pending.includes('2')).toBeTruthy()
  // A Mandate the Policy no longer holds when the pause lifts does not admit it: its sender left the list meanwhile.
  await followUp('4', 'om_3')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(second)).toMatchObject({ ended: expect.anything(), undelivered: [] })
  expect(h.candidates()).not.toContain('4')
})

it('ends a worker\'s turn only when the stop that ended its Assignment commits', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const worker = h.agents.get(one.sessionId)! as unknown as { cancel: ReturnType<typeof vi.fn> }
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(one.ticket.id); throw new Error('rolled back') })).toThrow('rolled back')
  expect(worker.cancel).not.toHaveBeenCalled()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.ended).toBeUndefined()
  h.runtime.engine.stopTicket(one.ticket.id)
  expect(worker.cancel).toHaveBeenCalledOnce()
})

describe('the Executor\'s parts', () => {
  it('holds one worker slot per ticket that runs or starts, and lets launches take the slots no worker or wake holds', () => {
    const running = ['t1']
    const slots = new WorkerSlots(() => running, () => 3)
    slots.reserve('t2', 'launch')
    slots.reserve('t3', 'wake')
    expect(slots.used()).toBe(3)
    // launches() excludes 'launch' reservations because the launch queue tracks active launches separately.
    expect(slots.launches()).toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    expect(() => slots.reserve('t3', 'wake')).not.toThrow()
    slots.free('t3')
    expect(slots.used()).toBe(2)
    slots.reserve('t4', 'launch')
    expect(slots.used()).toBe(3)
  })
  it('wakes a worker for a person\'s message in the one slot beyond the limit, and ahead of launches once a slot frees up', () => {
    const running = ['t1', 't2', 't3']
    const slots = new WorkerSlots(() => running, () => 3)
    expect(() => slots.reserve('t4', 'launch')).toThrow(Later)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    slots.reserve('t5', 'person')
    expect(slots.used()).toBe(4)
    expect(slots.launches()).toBeLessThanOrEqual(0)
    // No second person's wake fits beyond the limit; once a worker ends, it does, while a launch still waits.
    expect(() => slots.reserve('t6', 'person')).toThrow(Later)
    running.splice(0, 1)
    expect(() => slots.reserve('t7', 'launch')).toThrow(Later)
    slots.reserve('t6', 'person')
    expect(slots.used()).toBe(4)
  })
  it('words an assignment, and the limits an inferred mandate sets, from the ticket alone', () => {
    const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true,
      instruction: 'Fix typos only.' }] } })
    const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
      mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy'] }, actor: { source: 'github', id: 'alice' },
        scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never,
      settings, '/state')
    expect(execution).toEqual(expect.objectContaining({ name: 'fix-typo-ticket-01234' }))
    expect(execution).not.toHaveProperty('session')
    // The source Trigger goes with the assignment, so the text does not point at it.
    expect(execution.assignment).toContain('Scope: the typo.')
    expect(execution.assignment).not.toContain('trigger/tr1')
    expect(ticketExecution({ ...ticket, mandate: { ...ticket.mandate, strength: 'explicit' } } as Ticket,
      { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'r', name: 'fix-login', note: 'the login page' } as never, settings, '/state').assignment)
      .toBe('Routing note (not the source request): the login page')
    // The worker's system prompt holds the limits an inferred Mandate sets, so the assignment does not repeat them.
    expect(execution.assignment).not.toContain(mandateInstructions(ticket.mandate))
    expect(execution.assignment).toContain('- Copy fixes (copy): Fix typos only.')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })
  it('renders each kind of Input as its worker reads it, inline, and no reopen Input', () => {
    const asked = { id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Which page?', meta: {} } as Trigger
    const reply = { ...asked, id: 'tr2', text: 'The login page. '.repeat(50) }
    const card = triggerMessage(reply, { source_url: 'https://x' }, 'see the log', asked)
    expect(card).toEqual({ trigger_id: 'tr2', from: 'ou_a', thread: 'feishu:oc:om_1', at: '2026-09-01T00:00:00Z', text: expect.stringMatching(/^The login page\./),
      chars: reply.text.length, read: 'trigger/tr2', source_url: 'https://x', routing_note: 'see the log', replies_to: { trigger_id: 'tr1', preview: 'Which page?' } })
    expect(card.text).toHaveLength(601)
    expect(triggerMessage(asked, {})).toEqual({ trigger_id: 'tr1', from: 'ou_a', thread: 'feishu:oc:om_1', at: asked.at, text: 'Which page?' })
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '' }, card)!)).toEqual(card)
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'gone', at: '' })!)).toEqual({ trigger_id: 'gone', read: 'trigger/gone' })
    expect(inputMessage({ id: 'i2', kind: 'text', at: '', text: 'Please also update the docs' })).toBe('Please also update the docs')
    // A Policy change says what it means for the ticket, without version hashes.
    const changed = inputMessage({ id: 'i3', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { requesterAllowed: false,
      requester: { source: 'github', id: 'ci-bot' },
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }, { id: 'visual', name: 'Visual', change: 'disabled' }] } })!
    expect(changed).toContain('Rule Copy fixes (copy), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Fix typos only.')
    expect(changed).toContain('Rule Visual (visual), which this ticket was accepted under, no longer applies')
    // The sender is named, a bot as a person.
    expect(changed).toContain('The sender this ticket is for, ci-bot on github, may no longer start work here')
    expect(changed).not.toContain('person')
    expect(changed).not.toContain('v2')
    const mode = inputMessage({ id: 'i6', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { proactive: false } })!
    expect(mode).toContain('Work inferred from a rule is no longer accepted: finish only what is in progress within the assignment, and take on nothing new.')
    expect(mode).not.toContain('sender')
    expect(inputMessage({ id: 'i5', kind: 'resumed', at: '', triggerId: 'tr2' })).not.toContain('tr2')
    expect(inputMessage({ id: 'i4', kind: 'reopen', at: '' } as never)).toBeUndefined()
  })
  it('relays a worker\'s question, result or answer to the main Session, and keeps its progress internal', () => {
    const ticket = { id: 't1', title: 'Fix', updatedAt: '2026-09-01T00:00:00Z', attention: { id: 'a1', question: 'Which color?' }, assignments: [],
      mandate: { strength: 'explicit' }, origin: { triggerId: 'tr1' } } as unknown as Ticket
    expect(reportRelay(ticket, { state: 'progress', summary: 'halfway' })).toBeUndefined()
    expect(reportRelay(ticket, { state: 'blocked', summary: 'need input', question: 'Which color?' }))
      .toMatchObject({ id: 'attention:t1:a1', text: expect.stringContaining('"kind":"worker_attention"') })
    const ready = reportRelay({ ...ticket, attention: undefined } as unknown as Ticket, { state: 'ready', summary: 'Done',
      answers: 'tr9' })!
    expect(ready.id).toMatch(/^report:/)
    expect(JSON.parse(ready.text)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: 't1' }, trigger_id: 'tr1', state: 'ready', answer_to: 'tr9', summary: 'Done' })
  })
})
