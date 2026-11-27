/** The foreman slot: the instruction text it receives, and how it is handed over to a successor without losing the tickets in flight. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SuperAgentHooks } from '../src/app/hooks.ts'
import { instructionText, Proposals } from '../src/app/proposals.ts'
import { Rotation } from '../src/app/rotation.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'

const dirs: string[] = []
const opened: Store[] = []
const rotations: Rotation[] = []
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sa-foreman-'))
  dirs.push(dir)
  const openedStore = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  openedStore.saveSettings({ executor: { foreman: { workspace: '' } } })
  opened.push(openedStore)
  return openedStore
}
afterEach(() => {
  for (const rotation of rotations.splice(0)) rotation.dispose()
  // Close every handle first: Windows refuses to unlink a SQLite file that is still open.
  for (const openedStore of opened.splice(0)) { try { openedStore.close() } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

type Listener = (value: never) => void
/** A Rotation wired to fake Sessions and a fake context, so no DSH session is created and no model request is made. */
function harness() {
  const openedStore = store()
  const listeners = new Map<string, Listener>()
  const statusListeners: Listener[] = []
  const say = vi.fn(), rotationDone = vi.fn()
  const hooks = { on: (event: string, listener: Listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    say, broadcastRotationDone: rotationDone } as unknown as SuperAgentHooks
  const inbox = () => ({ nextTurn: [] as { id: string }[], nextStep: [] as { id: string }[], remove: () => false })
  const agents = new Map<string, { id: string; inbox: ReturnType<typeof inbox>; followup: () => void }>()
  const agent = (id: string) => { const value = { id, inbox: inbox(), followup: vi.fn() }; agents.set(id, value); return value }
  const context = { agents: { get: (id: string) => agents.get(id) },
    on: (event: string, listener: Listener) => { if (event === 'agent/status') statusListeners.push(listener); return () => {} } }
  const ensure = vi.fn(async (): Promise<never> => ({} as never))
  const prompt = vi.fn(async () => {})
  const rename = vi.fn(async () => {})
  const notify = vi.fn()
  const dir = dirs.at(-1)!
  const rotation = new Rotation({ store: openedStore, sessions: { ensure, prompt, rename, notify, inherit: vi.fn(async () => {}), redecorate: vi.fn(async () => {}) }, context: context as unknown as Context, hooks,
    rootMasterId: 'superagent-master', masterWorkspace: join(dir, 'master'), rootForemanId: 'superagent-foreman',
    foremanWorkspace: join(dir, 'foreman'), lifetime: new AbortController().signal, closing: () => false })
  rotations.push(rotation)
  rotation.install()
  return { store: openedStore, dir, rotation, ensure, prompt, rename, say, rotationDone, agent, inbox,
    usage: (value: { sessionId: string; ratio?: number }) => listeners.get('usage')!({ role: 'foreman', used: 1, source: 'plugin',
      at: '2026-11-18T10:00:00.000Z', ...value } as never),
    request: (request: { reason: string; sessionId?: string }) => listeners.get('rotation')!({ sessionId: 'superagent-foreman', requestedBy: 'plugin',
      at: '2026-11-18T10:00:00.000Z', ...request } as never),
    endTurn: (id: string, status = 'idle') => statusListeners.forEach(listener => listener({ agent: agents.get(id), status } as never)) }
}
const ticket = (id: string, title: string, summary?: string): Ticket => ({ id, title, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: '' },
  channels: [], assignments: summary ? [{ id: 'a1', state: 'returned', createdAt: '2026-11-18T00:00:00.000Z',
    report: { state: 'ready', summary } } as never] : [], inputs: [], undelivered: [],
  createdAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z', origin: { triggerId: `t-${id}`, triggerIds: [] } })

describe('the instruction text a foreman reads', () => {
  it('words the confirmed tasks from the store, and marks the person\'s own message as cross-checking only', () => {
    const proposals = new Proposals(store())
    const proposal = proposals.draft({ tasks: [
      { title: '改错字', request: '登录页错字全改掉', accept: '页面上没有错字' },
      { title: '优化首页', request: '首页首屏快一点', accept: '首屏一秒内出来', workspace: 'D:/site' }], heard: '把错字改一下，首页也优化下' })
    expect(instructionText(proposal)).toBe([
      `【指令清单 ${proposal.id}】这是用户已确认的最终形态，请据此定方案并派发工单。`,
      '1. 改错字', '   要做：登录页错字全改掉', '   完成标准：页面上没有错字', '   目录：（没说，用默认）',
      '2. 优化首页', '   要做：首页首屏快一点', '   完成标准：首屏一秒内出来', '   目录：D:/site',
      '', '（用户原话，只用于核对有没有理解偏，不当作任务正文：把错字改一下，首页也优化下）',
      '\n你派出的每一张工单都要挂这个指令清单编号；同一指令清单下的子工单不用再问用户。'].join('\n'))
    // Completion criteria are optional (C-13a), and a task may name the worker session that takes it (C-12).
    const named = proposals.draft({ tasks: [{ title: '小修', request: '改一处', session: 'worker-abc' }], heard: '改一处' })
    expect(instructionText(named)).toContain('   完成标准：（没写，只看结果）')
    expect(instructionText(named)).toContain('   点名会话：worker-abc（C-12：它在忙就等它干完，再按实际占用判）')
  })

  it('records the handover once, so repeating it neither re-delivers nor moves the first time', () => {
    const proposals = new Proposals(store())
    const proposal = proposals.approve(proposals.draft({ tasks: [{ title: '改错字', request: '改掉', accept: '没有错字' }],
      heard: '改一下错字' }).id)
    const handed = proposals.markHandedOff(proposal.id)
    expect(handed.handoffAt).toBeTruthy()
    expect(proposals.markHandedOff(proposal.id).handoffAt).toBe(handed.handoffAt)
    expect(() => proposals.markHandedOff('pr-9')).toThrow('Unknown instruction pr-9')
  })
})

describe('the foreman slot and its rotation', () => {
  it('names the generation the person sees in the session list', () => {
    const h = harness()
    expect(h.rotation.foremanTitle()).toBe('superagent 工头（后台，不用管）')
    h.store.set(KV.rotation.foreman, { current: 'superagent-foreman', generation: 2, previous: ['a', 'b'] })
    expect(h.rotation.foremanTitle()).toBe('superagent 工头（后台，不用管）· 第 3 代')
    // An earlier generation is a fake foreman: it keeps its history and plans nothing (N-02a).
    expect(h.rotation.isForemanSession('a')).toBe(false)
    expect(h.rotation.isFakeForeman('a')).toBe(true)
    expect(h.rotation.isForemanSession('stranger')).toBe(false)
    expect(h.rotation.isFakeForeman('stranger')).toBe(false)
  })

  it('waits for the turn to end with nothing queued, then hands the tickets in flight to the successor', async () => {
    const h = harness()
    h.store.tickets.save(ticket('t1', '登录页报错', '已定位到空指针，正在改'))
    h.store.tickets.save({ ...ticket('t2', '首页慢'), ended: { at: '2026-11-18T00:00:00.000Z', by: 'human', reason: 'done', outcome: 'completed' } })
    h.agent('superagent-foreman')
    h.request({ reason: 'context threshold reached' })
    expect(h.store.get(KV.rotation.foreman)).toMatchObject({ current: 'superagent-foreman', generation: 0,
      pending: { reason: 'context threshold reached' } })
    expect(h.ensure).not.toHaveBeenCalled()

    // A worker's report wakes the foreman: while anything waits for it, the rotation waits too.
    h.agent('superagent-foreman').inbox.nextTurn.push({ id: 'm1' })
    h.endTurn('superagent-foreman')
    expect(h.ensure).not.toHaveBeenCalled()
    h.agent('superagent-foreman').inbox.nextTurn.length = 0

    h.endTurn('superagent-foreman')
    await vi.waitFor(() => expect(h.rotationDone).toHaveBeenCalledTimes(1))
    // The successor inherits its predecessor's model, reasoning effort and permissions, not the main session's.
    expect(h.ensure).toHaveBeenCalledWith('superagent-foreman-r1', join(h.dir, 'foreman'), 'superagent 工头（后台，不用管）· 第 2 代',
      'foreman', 'superagent-foreman')
    expect(h.store.get(KV.rotation.foreman)).toMatchObject({ current: 'superagent-foreman-r1', generation: 1,
      previous: ['superagent-foreman'], rotatedAt: expect.any(String) })
    // The earlier generation is kept, renamed so it is not mistaken for the live one.
    expect(h.rename).toHaveBeenCalledWith('superagent-foreman', 'superagent 工头（已换下 · 假工头 · 第 1 代 · 历史保留）')
    // The successor reads the tickets still in flight, their last report, and where the decisions live.
    expect(h.prompt).toHaveBeenCalledTimes(1)
    const [sessionId, key, text] = h.prompt.mock.calls[0] as unknown as [string, string, string]
    expect([sessionId, key]).toEqual(['superagent-foreman-r1', 'rotation:foreman:1'])
    const payload = JSON.parse(text) as { rotation: { previous: string; reason: string; handoff_file: string } }
    expect(payload.rotation).toMatchObject({ previous: 'superagent-foreman', reason: 'context threshold reached' })
    expect(payload.rotation.handoff_file).toBe(join(h.dir, 'foreman', 'handoffs', 'foreman-1.md'))
    expect(existsSync(payload.rotation.handoff_file)).toBe(true)
    const handoff = readFileSync(payload.rotation.handoff_file, 'utf8')
    expect(handoff).toContain('工头第 2 代接手（上一代 superagent-foreman）')
    expect(handoff).toContain('t1「登录页报错」：ready — 已定位到空指针，正在改')
    // An ended ticket is not in flight.
    expect(handoff).not.toContain('t2')
    expect(h.rotationDone).toHaveBeenCalledWith({ sessionId: 'superagent-foreman', successorId: 'superagent-foreman-r1' })
    expect(h.rotation.foremanSession()).toBe('superagent-foreman-r1')
  })

  it('keeps the earlier foreman and its ticket work when the successor cannot be created', async () => {
    const h = harness()
    h.store.tickets.save(ticket('t1', '登录页报错'))
    h.agent('superagent-foreman')
    h.request({ reason: 'context threshold reached' })
    h.ensure.mockRejectedValueOnce(new Error('create failed'))
    h.endTurn('superagent-foreman')
    await vi.waitFor(() => expect(h.say).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' })))
    expect(h.store.get(KV.rotation.foreman)).toMatchObject({ current: 'superagent-foreman', generation: 0, previous: [],
      pending: { reason: 'context threshold reached' } })
    expect(h.rotation.foremanSession()).toBe('superagent-foreman')
    expect(h.rotationDone).not.toHaveBeenCalled()
  })

  it('keeps the context reading a plugin reports for the foreman, so the panel can show how full it is', () => {
    const h = harness()
    h.store.set(KV.rotation.foreman, { current: 'superagent-foreman', generation: 0, previous: [] })
    h.usage({ sessionId: 'superagent-foreman', ratio: 0.42 })
    expect(h.store.get(KV.rotation.foreman)?.usage).toEqual({ ratio: 0.42, at: '2026-11-18T10:00:00.000Z' })
    // A reading without a ratio, or for another session, changes nothing.
    h.usage({ sessionId: 'superagent-foreman' })
    h.usage({ sessionId: 'worker-t1', ratio: 0.9 })
    expect(h.store.get(KV.rotation.foreman)?.usage?.ratio).toBe(0.42)
  })

  it('ignores a rotation request from a fake foreman and from an unmanaged session (N-02a)', () => {
    const h = harness()
    h.store.set(KV.rotation.foreman, { current: 'superagent-foreman-r1', generation: 1, previous: ['superagent-foreman'] })
    // A fake foreman accepts no rotation request: only the current one owns the slot.
    h.request({ reason: 'context threshold reached', sessionId: 'superagent-foreman' })
    expect(h.store.get(KV.rotation.foreman)?.pending).toBeUndefined()
    // Nor is anything recorded for a session that is not the foreman at all.
    h.request({ reason: 'noise', sessionId: 'someone-else' })
    expect(h.store.get(KV.rotation.foreman)?.pending).toBeUndefined()
  })
})
