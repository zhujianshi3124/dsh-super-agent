/**
 * The bundled context-guard extension must activate on a fresh installation: the host's context-threshold rotation is driven
 * entirely by it, so the loader seeds it from the package into the watched directory. These tests cover the seeding (never
 * overwriting the operator's file) and the extension's own logic from a real usage event to a rotation request.
 *
 * The extension logic is exercised by calling its `apply` directly with a stub context: the loader mounts plugins through a
 * `new Function` dynamic import that escapes the bundler's static graph, which vitest's VM module runner cannot perform
 * ("A dynamic import callback was not specified"). That path runs under real Node; every runtime test exercises the loader's
 * seeding through `extensions.start()`. Every write the extension makes here is sandboxed via a temporary `stateDir`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { seedBundledExtensions } from '../src/app/extensions.ts'
import { SuperAgentHooks, type HooksHost } from '../src/app/hooks.ts'
// @ts-ignore -- the bundled extension is plain ESM JavaScript shipped without a declaration file
import { apply as contextGuard, name as guardName } from '../extensions/context-guard.mjs'

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

describe('bundled extension seeding', () => {
  it('seeds the bundled context-guard and its config into a fresh directory, and never overwrites the operator file', () => {
    const dir = temp('ext-seed-')
    try {
      const seeded = seedBundledExtensions(dir)
      expect(seeded).toContain('context-guard.mjs')
      expect(existsSync(join(dir, 'context-guard.mjs'))).toBe(true)
      expect(existsSync(join(dir, 'context-guard.json'))).toBe(true)
      // An operator edit to the bundled config survives a later seeding (restart or upgrade).
      writeFileSync(join(dir, 'context-guard.json'), '{"warnRatio":0.5,"hardRatio":0.6}')
      expect(seedBundledExtensions(dir)).toEqual([])
      expect(JSON.parse(readFileSync(join(dir, 'context-guard.json'), 'utf8')).warnRatio).toBe(0.5)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('context-guard logic', () => {
  it('reports real usage, files a rotation request past the hard threshold, and exempts the main Session', () => {
    const state = temp('ext-state-')
    const host: HooksHost = {
      masterId: () => 'orchestrator-x',
      openTickets: () => [{ id: 't1', title: 'Fix' }],
      sessionIdFor: id => `worker-${id}`,
      advise: vi.fn(),
      ticketInfo: () => ({ title: 'Fix', assignment: 'do the work', directory: join(state, 't1') }),
    }
    // A minimal cordis-like context for the extension: the hooks service plus effect registration, as the loader provides.
    const disposers: (() => void)[] = []
    const hooks = new SuperAgentHooks(new Context(), host)
    const ctx = { superagentHooks: hooks, effect: (fn: () => unknown) => { const d = fn(); if (typeof d === 'function') disposers.push(d as () => void) } }
    try {
      contextGuard(ctx, { warnRatio: 0.35, hardRatio: 0.4, stateDir: state })
      expect((hooks.status().plugins as Record<string, { state: string }>)[guardName]?.state).toBe('ready')

      // Below the warn threshold: usage is reported, but no rotation is requested.
      hooks.broadcastSessionEvent({ sessionId: 'worker-t1', role: 'worker', contextWindow: 1000,
        event: { type: 'assistant/message', data: { contextWindow: 1000, usage: { totalTokens: 200 } } } })
      expect(hooks.status().rotationRequests).toEqual([])

      // Past the hard threshold (50%): a rotation request naming its ticket, and a pre-written handoff in the sandbox.
      hooks.broadcastSessionEvent({ sessionId: 'worker-t1', role: 'worker', contextWindow: 1000,
        event: { type: 'assistant/message', data: { contextWindow: 1000, usage: { totalTokens: 500 } } } })
      const requests = hooks.status().rotationRequests as { sessionId: string; ticketId?: string }[]
      expect(requests.some(request => request.sessionId === 'worker-t1' && request.ticketId === 't1')).toBe(true)
      expect(existsSync(join(state, 'handoffs', 'worker-t1.md'))).toBe(true)

      // The main Session is exempt (C-13c): the same usage on the orchestrator files no rotation.
      hooks.broadcastSessionEvent({ sessionId: 'orchestrator-x', role: 'orchestrator', contextWindow: 1000,
        event: { type: 'assistant/message', data: { contextWindow: 1000, usage: { totalTokens: 900 } } } })
      expect((hooks.status().rotationRequests as { sessionId: string }[]).some(request => request.sessionId === 'orchestrator-x')).toBe(false)
    } finally { for (const dispose of disposers) dispose(); rmSync(state, { recursive: true, force: true }) }
  })
})