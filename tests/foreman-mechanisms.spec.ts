/** The foreman mechanisms on a running host: the stuck stop (C-12b.1), the emergency stop (C-16b), the named-session wait's
 * three decisions (C-12, C-12a, C-30), one live ticket per task and its continuation (C-09, N-13a), the foreman replacement
 * (C-12b.2, C-09c, N-02a), and the adjudication relay (C-16a). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KV } from '../src/kv.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

// The replacement writes its handoff into the real foreman workspace (`D:/gongtou`): wrap the two writes so the test records
// the handoff path without leaving a file there. Everything else delegates to the real functions.
const real = vi.hoisted(() => ({
  mkdirSync: (() => undefined) as (...args: unknown[]) => unknown,
  writeFileSync: (() => undefined) as (...args: unknown[]) => unknown,
}))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  real.mkdirSync = actual.mkdirSync as (...args: unknown[]) => unknown
  real.writeFileSync = actual.writeFileSync as (...args: unknown[]) => unknown
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync) }
})

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const foreman = () => h.runtime.rotation.foremanSession()

it('stops a stuck worker\'s ticket with stop reason stuck, and its worker takes nothing more (C-12b.1, C-11)', async () => {
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const result = await h.runTool(foreman(), 'orchestrator_ticket_stop_stuck', { ticket_id: ticket.id, reason: '模型一小时没动，上下文也没涨' })
  expect(result).toMatchObject({ stopped: true, by: 'foreman', stop: 'stuck',
    ticket: { ticket_id: ticket.id, state: 'stuck', ended: { by: 'foreman', stop: 'stuck', reason: '模型一小时没动，上下文也没涨' } } })
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ by: 'foreman', stop: 'stuck' })
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '做完了' })).rejects.toThrow('Ticket ended')
})

it('emergency stop ends every open ticket at once with stop reason emergency, and points at orchestrator_say (C-16b)', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const two = await h.acceptedTicket(feishu('2', '@bot 再修一个'))
  const result = await h.runTool(foreman(), 'orchestrator_emergency_stop', { reason: '未批准的危险操作已经开始' }) as { stopped: string[]; note: string }
  expect(new Set(result.stopped)).toEqual(new Set([one.ticket.id, two.ticket.id]))
  expect(result.note).toContain('orchestrator_say')
  for (const item of [one, two]) {
    expect(h.runtime.store.tickets.get(item.ticket.id)!.ended).toMatchObject({ by: 'foreman', stop: 'emergency', reason: '未批准的危险操作已经开始' })
  }
  expect(h.runtime.store.tickets.open()).toHaveLength(0)
})

it('decides a ticket waiting for its named session: small_task keeps the wait, new_session and refuse take a fresh session, each recorded (C-12, C-12a, C-30)', async () => {
  const first = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const busy = h.runtime.rotation.workerSession(first.ticket.id)
  /** A second ticket naming the busy session: it is created and waits for it (C-12). */
  const namedWait = async (id: string) => {
    const trigger = feishu(id, `@bot 第 ${id} 件事`)
    h.runtime.receive(trigger); await h.runtime.idle()
    const result = await h.route({ kind: 'accept', trigger_id: trigger.id, title: `Task ${id}`, worktree_name: `task-${id}`,
      acknowledgement: '收到。', worker_session: busy })
    const ticket = h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    expect(ticket.waitingFor).toBe(busy)
    return ticket
  }
  const small = await namedWait('2'), fresh = await namedWait('3'), refused = await namedWait('4')
  const dispatch = (ticketId: string, action: string, reason: string) =>
    h.runTool(foreman(), 'orchestrator_ticket_dispatch', { ticket_id: ticketId, action, reason })
  // The small-task exception dispatches to the named session; the wait stands while that session is busy.
  expect(await dispatch(small.id, 'small_task', '预计占用 3%，干完不到 40%')).toMatchObject({ dispatched: 'small_task', ticket: { ticket_id: small.id } })
  await h.runtime.idle()
  const smallStored = h.runtime.store.tickets.get(small.id)!
  expect(smallStored.smallTask).toBe(true)
  expect(smallStored.waitingFor).toBe(busy)
  expect(smallStored.decisions?.some(item => item.text.includes('Small-task dispatch'))).toBe(true)
  // A fresh session takes the same ticket number; the named one is left alone.
  expect(await dispatch(fresh.id, 'new_session', '任务太大，点名会话余量不够')).toMatchObject({ dispatched: 'new_session', ticket: { ticket_id: fresh.id } })
  await h.runtime.idle()
  const freshStored = h.runtime.store.tickets.get(fresh.id)!
  expect(freshStored.waitingFor).toBeUndefined()
  expect(h.runtime.store.get(KV.rotation.worker(fresh.id))).toEqual({ current: workerSessionId(fresh.id), generation: 0, previous: [] })
  expect(freshStored.decisions?.some(item => item.text.includes('Dispatched to a new session'))).toBe(true)
  // A refusal names why, and gives the ticket a fresh session too; the reason stays in the ticket, not with the person.
  expect(await dispatch(refused.id, 'refuse', '该会话正在别的工单上，且余量不足')).toMatchObject({ dispatched: 'refuse', ticket: { ticket_id: refused.id } })
  await h.runtime.idle()
  const refusedStored = h.runtime.store.tickets.get(refused.id)!
  expect(refusedStored.waitingFor).toBeUndefined()
  expect(h.runtime.store.get(KV.rotation.worker(refused.id))).toEqual({ current: workerSessionId(refused.id), generation: 0, previous: [] })
  expect(refusedStored.decisions?.some(item => item.text.includes('Refused the named session'))).toBe(true)
  // A ticket that waits for no named session has nothing to decide.
  await expect(dispatch(first.ticket.id, 'new_session', '不该等')).rejects.toThrow('does not wait for a named session')
})

it('dispatches one task once while its ticket lives, and continues a stopped task with a new ticket under the same instruction (C-09, N-13a, C-11)', async () => {
  const proposal = h.runtime.proposals.approve(h.runtime.proposals.draft({
    tasks: [{ title: '改错字', request: '登录页错字改掉', accept: '没有错字' }], heard: '把登录页错字改一下' }).id)
  const accept = async (id: string) => {
    const trigger = feishu(id, `@bot 改错字 ${id}`)
    h.runtime.receive(trigger); await h.runtime.idle()
    return await h.route({ kind: 'accept', trigger_id: trigger.id, title: '改错字', worktree_name: `typo-${id}`,
      acknowledgement: '收到。', proposal: proposal.id, task: 1 })
  }
  const firstId = ((await accept('1')).ticket as { ticket_id: string }).ticket_id
  // A second accept of the same task while its ticket lives is refused (C-09).
  await expect(accept('2')).rejects.toThrow('already has a live ticket')
  // The worker fails; the ticket ends with that stop reason (N-13).
  await h.runTool(`worker-${firstId}`, 'orchestrator_report', { state: 'failed', summary: '构建坏了' })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(firstId)!.ended).toMatchObject({ stop: 'failed' })
  // Continuing the task is a NEW ticket under the same instruction and task; the old one stays ended (N-13a, C-11).
  const secondId = ((await accept('3')).ticket as { ticket_id: string }).ticket_id
  expect(secondId).not.toBe(firstId)
  expect(h.runtime.store.tickets.get(secondId)).toMatchObject({ proposal: proposal.id, task: 1 })
  expect(h.runtime.store.tickets.get(firstId)!.ended).toBeDefined()
  expect(h.runtime.proposals.view(proposal.id).ticketIds).toEqual(expect.arrayContaining([firstId, secondId]))
})

it('replaces a stuck foreman with a successor that inherits the slot, and the old one keeps history only (C-12b.2, C-09c, N-02a)', async () => {
  const old = foreman()
  const oldRoute = h.tools.get(old)!.get('orchestrator_route')!
  const fs = await import('node:fs')
  const mkdir = vi.mocked(fs.mkdirSync), write = vi.mocked(fs.writeFileSync)
  const handoffs: string[] = []
  const inForemanWorkspace = (path: unknown) => String(path).replaceAll('\\', '/').includes('gongtou')
  mkdir.mockImplementation(((path: unknown, ...rest: unknown[]) => inForemanWorkspace(path) ? undefined : real.mkdirSync(path, ...rest)) as never)
  write.mockImplementation(((path: unknown, ...rest: unknown[]) => {
    if (inForemanWorkspace(path)) { handoffs.push(String(path)); return }
    return real.writeFileSync(path, ...rest)
  }) as never)
  try {
    const result = await h.runTool(h.runtime.masterId, 'orchestrator_foreman_replace', { reason: '工头卡住：一小时没动' })
    expect(result).toEqual({ replaced: true, successor: `${old}-r1` })
    expect(foreman()).toBe(`${old}-r1`)
    expect(h.runtime.rotation.isForemanSession(old)).toBe(false)
    expect(h.runtime.rotation.isFakeForeman(old)).toBe(true)
    expect(h.runtime.store.get(KV.rotation.foreman)).toMatchObject({ current: `${old}-r1`, generation: 1, previous: [old] })
    // The successor holds the foreman tools and reads the handoff; the old one's bound tool refuses by its live role (N-02a).
    expect(h.tools.get(`${old}-r1`)!.has('orchestrator_route')).toBe(true)
    expect(h.relays(`${old}-r1`)[0]).toMatchObject({ rotation: { successor: `${old}-r1`, previous: old, reason: '工头卡住：一小时没动' } })
    expect(h.tools.get(old)!.has('orchestrator_route')).toBe(false)
    // The bound wrapper checks the live role before it parses, so it throws synchronously: call it inside the promise.
    await expect((async () => oldRoute.execute({ decisions: [{ kind: 'ignore', trigger_id: 'x', reason: 'y' }] }, { signal: new AbortController().signal }))())
      .rejects.toThrow('no longer holds that role')
    expect(handoffs.some(path => path.replaceAll('\\', '/').endsWith('handoffs/foreman-1.md'))).toBe(true)
  } finally {
    mkdir.mockImplementation(real.mkdirSync as never)
    write.mockImplementation(real.writeFileSync as never)
  }
})

it('passes the person\'s adjudication to the foreman word for word (C-16a)', async () => {
  const text = '按钮用蓝色；文案照原样'
  expect(await h.runTool(h.runtime.masterId, 'orchestrator_adjudicate', { text })).toEqual({ delivered: true, foreman: foreman() })
  await h.runtime.idle()
  expect(h.relays(foreman())).toEqual([expect.objectContaining({ kind: 'adjudication', text })])
})