/** Where the main Session runs, and the rule that makes a new one the person's to open: dsh-superagent adopts it, never creates it. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SuperAgentHooks } from '../src/app/hooks.ts'
import { Rotation } from '../src/app/rotation.ts'
import { Store } from '../src/app/store.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { KV } from '../src/kv.ts'

const dirs: string[] = []
const opened: Store[] = []
const rotations: Rotation[] = []
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sa-master-'))
  dirs.push(dir)
  const openedStore = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  opened.push(openedStore)
  return openedStore
}
afterEach(() => {
  vi.useRealTimers()
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
  const say = vi.fn(), rotationDone = vi.fn()
  const hooks = { on: (event: string, listener: Listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    say, broadcastRotationDone: rotationDone } as unknown as SuperAgentHooks
  const agents = new Map<string, { id: string; inbox: { nextTurn: { id: string }[]; nextStep: { id: string }[]; remove: () => boolean }
    followup: () => void; whenIdle: () => Promise<void> }>()
  const agent = (id: string, cwd?: string) => {
    const value = { id, session: { header: { cwd } }, inbox: { nextTurn: [], nextStep: [], remove: () => false }, followup: vi.fn(), whenIdle: async () => {} }
    agents.set(id, value)
    return value
  }
  const context = { agents: { get: (id: string) => agents.get(id) }, on: () => () => {} }
  const ensure = vi.fn(async (): Promise<never> => ({} as never))
  const prompt = vi.fn(async () => {})
  const rename = vi.fn(async () => {})
  const notify = vi.fn()
  const inherit = vi.fn(async () => {})
  const redecorate = vi.fn(async () => {})
  const dir = dirs.at(-1)!
  const rotation = new Rotation({ store: openedStore, sessions: { ensure, prompt, rename, notify, inherit, redecorate }, context: context as unknown as Context, hooks,
    rootMasterId: 'superagent-master', masterWorkspace: join(dir, 'chief'), rootForemanId: 'superagent-foreman',
    foremanWorkspace: join(dir, 'foreman'), lifetime: new AbortController().signal, closing: () => false })
  rotations.push(rotation)
  rotation.install()
  return { store: openedStore, dir, rotation, ensure, prompt, rename, notify, inherit, redecorate, say, rotationDone, agent,
    request: (request: { reason: string; sessionId?: string }) => listeners.get('rotation')!({ sessionId: 'superagent-master',
      requestedBy: 'plugin', at: '2026-11-18T10:00:00.000Z', ...request } as never) }
}

describe('the main Session workspace', () => {
  it('defaults to the person\'s own directory, and a configured one wins', () => {
    expect(machineOf(Config({ stateDir: '/srv/state' })).masterWorkspace).toBe('D:/chief')
    expect(machineOf(Config({ stateDir: '/srv/state', masterWorkspace: 'D:/work' })).masterWorkspace).toBe('D:/work')
    // A relative workspace would put the person's files wherever the process happens to run.
    expect(() => Config({ stateDir: '/srv/state', masterWorkspace: 'relative/dir' })).toThrow()
  })
})

describe('the main slot and the Session the person opens', () => {
  it('notes a main-session rotation request without acting on it; the person opens the successor (C-13c)', async () => {
    const h = harness()
    h.agent('superagent-master')
    h.request({ reason: 'context threshold reached' })
    // The main Session does not follow the 35/40 scheme: the request is noted, no Session is created, no rotation recorded.
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.say).toHaveBeenCalledWith(expect.objectContaining({ level: 'info', text: expect.stringContaining('C-13c') }))
    expect(h.store.get(KV.rotation.master)).toBeUndefined()

    // The person opens a new main Session in the main workspace: the host adopts it, inheriting the old one's settings once.
    h.agent('chief-2', join(h.dir, 'chief'))
    await h.rotation.designate('chief-2')
    expect(h.inherit).toHaveBeenCalledWith('chief-2', 'superagent-master', true)
    // The Session the swap replaced keeps its transcript; only its title says it is history and a fake main Session (N-01a).
    expect(h.rename).toHaveBeenCalledWith('superagent-master', 'dsh-superagent orchestrator（已换下 · 假主会话 · 历史保留）')
    expect(h.redecorate).toHaveBeenCalled()
    expect(h.store.get(KV.rotation.master)).toMatchObject({ current: 'chief-2', generation: 1,
      previous: ['superagent-master'], rotatedAt: expect.any(String) })
    expect(h.rotationDone).toHaveBeenCalledWith({ sessionId: 'superagent-master', successorId: 'chief-2' })
    expect(h.rotation.masterSession()).toBe('chief-2')
    expect(h.rotation.isFakeMaster('superagent-master')).toBe(true)
    // A Session outside the main workspace cannot become the main Session (C-13d).
    h.agent('elsewhere', join(h.dir, 'other'))
    await expect(h.rotation.designate('elsewhere')).rejects.toThrow('not in the main workspace')
    expect(h.rotation.masterSession()).toBe('chief-2')
  })

  it('keeps the slot when the new Session cannot inherit the old one\'s settings', async () => {
    const h = harness()
    h.agent('superagent-master')
    h.agent('chief-2', join(h.dir, 'chief'))
    h.inherit.mockRejectedValueOnce(new Error('not ready'))
    await expect(h.rotation.designate('chief-2')).rejects.toThrow('not ready')
    expect(h.store.get(KV.rotation.master)).toBeUndefined()
    expect(h.rename).not.toHaveBeenCalled()
    expect(h.rotationDone).not.toHaveBeenCalled()
    expect(h.rotation.masterSession()).toBe('superagent-master')
  })

  it('follows the mapping when it names another Session, and still knows the ones it replaced', () => {
    const h = harness()
    // What adoption writes: the slot points at the Session the person opened.
    h.store.set(KV.rotation.master, { current: 'superagent-chief', generation: 2, previous: ['superagent-master-r1', 'superagent-master'] })
    expect(h.rotation.masterSession()).toBe('superagent-chief')
    // An earlier one is a fake main Session: it keeps its history and has no main-Session effect (N-01a).
    expect(h.rotation.isMasterSession('superagent-master-r1')).toBe(false)
    expect(h.rotation.isFakeMaster('superagent-master-r1')).toBe(true)
    expect(h.rotation.isMasterSession('someone-else')).toBe(false)
    expect(h.rotation.isFakeMaster('someone-else')).toBe(false)
  })
})
