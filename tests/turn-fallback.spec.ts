/** A managed Session's turn that ends in a provider error: the person hears of it, and a stranded instruction is handed over once more. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TurnFallback } from '../src/app/fallback.ts'
import type { SuperAgentHooks } from '../src/app/hooks.ts'
import { instructionText, Proposals } from '../src/app/proposals.ts'
import type { Rotation } from '../src/app/rotation.ts'
import type { Sessions } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import type { Proposal } from '../src/core/index.ts'

const dirs: string[] = []
const opened: Store[] = []
const fallbacks: TurnFallback[] = []
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sa-fallback-'))
  dirs.push(dir)
  const openedStore = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  opened.push(openedStore)
  return openedStore
}
afterEach(() => {
  for (const fallback of fallbacks.splice(0)) fallback.dispose()
  for (const openedStore of opened.splice(0)) { try { openedStore.close() } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

type Listener = (value: never) => void
const RATE_LIMIT = '429: {"message":"inference exceeds tpm/rpm limit","code":"RateLimitExceeded.EndpointRPMExceeded"}'

/** A handover the foreman never turned into a ticket: approved, handed off, and still undispatched. */
function stranded(openedStore: Store): Proposal {
  const proposals = new Proposals(openedStore)
  const draft = proposals.draft({ tasks: [{ title: '清理临时目录', request: '把 D:/tmp/x 删掉', accept: '目录不存在' }], heard: '删了那个目录' })
  proposals.approve(draft.id)
  return proposals.markHandedOff(draft.id)
}

function harness(seed?: (store: Store) => void) {
  const openedStore = store()
  seed?.(openedStore)
  const listeners = new Map<string, Listener>()
  const say = vi.fn()
  const hooks = { say } as unknown as SuperAgentHooks
  const prompt = vi.fn(async () => {})
  const relay = vi.fn()
  const context = { on: (event: string, listener: Listener) => { listeners.set(event, listener); return () => { listeners.delete(event) } } }
  const rotation = { isForemanSession: (id: string) => id === 'superagent-foreman' || id === 'superagent-foreman-r1',
    foremanSession: () => 'superagent-foreman-r1' } as unknown as Rotation
  let closing = false
  const fallback = new TurnFallback({ context: context as unknown as Context, store: openedStore,
    sessions: { prompt, relay } as unknown as Sessions, rotation, hooks, closing: () => closing })
  fallbacks.push(fallback)
  fallback.install()
  return { store: openedStore, prompt, relay, say, fallback,
    fail: (sessionId: string, error: string = RATE_LIMIT) => listeners.get('agent/error')!({ agent: { id: sessionId }, error } as never),
    close: () => { closing = true } }
}

describe('a foreman turn that ended in an error', () => {
  it('tells the main Session and hands the stranded instruction over once more', () => {
    let proposal: Proposal | undefined
    const h = harness(openedStore => { proposal = stranded(openedStore) })
    h.fail('superagent-foreman-r1')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    const [sessionId, requestId, text] = h.prompt.mock.calls[0] as unknown as [string, string, string]
    expect([sessionId, requestId]).toEqual(['superagent-foreman-r1', `handoff:${proposal!.id}:retry:1`])
    // The text is built from the stored instruction, so a retry cannot drift from what the person confirmed.
    expect(text).toBe(instructionText(proposal!))
    expect(h.relay).toHaveBeenCalledTimes(1)
    const [name, notice] = h.relay.mock.calls[0] as unknown as [string, string]
    expect(name).toBe(`fallback:${proposal!.id}:1`)
    expect(notice).toContain(proposal!.id)
    expect(notice).toContain('429')
    expect(notice).toContain('重投')
  })

  it('stops redelivering and asks the person to decide, so a broken line cannot loop forever', () => {
    let proposal: Proposal | undefined
    const h = harness(openedStore => { proposal = stranded(openedStore) })
    h.fail('superagent-foreman-r1')
    h.fail('superagent-foreman-r1')
    expect(h.prompt).toHaveBeenCalledTimes(1)
    expect(h.relay).toHaveBeenCalledTimes(2)
    const [, notice] = h.relay.mock.calls[1] as unknown as [string, string]
    expect(notice).toContain('仍未派发工单')
    expect(notice).toContain(proposal!.id)
  })

  it('leaves a dispatched instruction alone: its ticket already owns the work', () => {
    const h = harness(openedStore => {
      const proposals = new Proposals(openedStore)
      const draft = proposals.draft({ tasks: [{ title: '改错字', request: '改掉', accept: '没有错字' }], heard: '改一下' })
      proposals.approve(draft.id)
      const handed = proposals.markHandedOff(draft.id)
      openedStore.proposals.save({ ...handed, status: 'dispatched', dispatchedAt: '2026-11-18T00:00:00.000Z' })
    })
    h.fail('superagent-foreman-r1')
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.relay).not.toHaveBeenCalled()
    expect(h.say).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })

  it('ignores the other slots and another session entirely', () => {
    const h = harness(openedStore => { stranded(openedStore) })
    h.fail('superagent-chief')
    h.fail('worker-t1')
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.relay).not.toHaveBeenCalled()
  })

  it('does nothing while the host is closing', () => {
    const h = harness(openedStore => { stranded(openedStore) })
    h.close()
    h.fail('superagent-foreman-r1')
    expect(h.prompt).not.toHaveBeenCalled()
    expect(h.relay).not.toHaveBeenCalled()
  })
})
