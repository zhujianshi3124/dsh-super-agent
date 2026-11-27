/**
 * The bundled context-guard extension must activate on a fresh installation: the host's context-threshold rotation is driven
 * entirely by it, so the loader seeds it from the package into the watched directory. These tests cover the seeding (an upgrade
 * replaces only a copy the operator left unchanged; a `.disabled` marker switches an extension off) and the extension's own
 * logic from a real usage event to a rotation request.
 *
 * The extension logic is exercised by calling its `apply` directly with a stub context: the loader mounts plugins through a
 * `new Function` dynamic import that escapes the bundler's static graph, which vitest's VM module runner cannot perform
 * ("A dynamic import callback was not specified"). That path runs under real Node; every runtime test exercises the loader's
 * seeding through `extensions.start()`. The extension gets the configuration the loader would give it, with a temporary
 * `stateDir`, and the home directory is a temporary one too, so nothing it writes leaves the sandbox.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { enabledExtensions, extensionConfig, seedBundledExtensions } from '../src/app/extensions.ts'
import { SuperAgentHooks, type HooksHost } from '../src/app/hooks.ts'
// @ts-ignore -- the bundled extension is plain ESM JavaScript shipped without a declaration file
import { apply as contextGuard, name as guardName } from '../extensions/context-guard.mjs'

const temp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
/** A seeding pass that changed nothing. */
const nothing = { seeded: [], upgraded: [], kept: [], disabled: [] }
/** Writes one version of a stand-in bundled extension `guard`, with its config, into `directory`. */
const bundle = (directory: string, version: number): void => {
  writeFileSync(join(directory, 'guard.mjs'), `export const version = ${version}\n`)
  writeFileSync(join(directory, 'guard.json'), `{"version":${version}}\n`)
}

describe('bundled extension seeding', () => {
  it('seeds the bundled context-guard and its config into a fresh directory, and keeps an operator edit', () => {
    const dir = temp('ext-seed-')
    try {
      expect(seedBundledExtensions(dir).seeded).toEqual(['context-guard.mjs', 'context-guard.json'])
      expect(existsSync(join(dir, 'context-guard.mjs'))).toBe(true)
      expect(existsSync(join(dir, 'context-guard.json'))).toBe(true)
      // An operator edit to the bundled config survives a later seeding (a restart), silently while the bundled one is unchanged.
      writeFileSync(join(dir, 'context-guard.json'), '{"warnRatio":0.5,"hardRatio":0.6}')
      expect(seedBundledExtensions(dir)).toEqual(nothing)
      expect(JSON.parse(readFileSync(join(dir, 'context-guard.json'), 'utf8')).warnRatio).toBe(0.5)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('on an upgrade replaces a copy the operator left unchanged, and keeps and reports one they changed', () => {
    const pkg = temp('ext-pkg-')
    const dir = temp('ext-seed-')
    try {
      bundle(pkg, 1)
      expect(seedBundledExtensions(dir, pkg).seeded).toEqual(['guard.mjs', 'guard.json'])
      writeFileSync(join(dir, 'guard.json'), '{"version":1,"mine":true}\n')
      bundle(pkg, 2)
      expect(seedBundledExtensions(dir, pkg)).toEqual({ ...nothing, upgraded: ['guard.mjs'], kept: ['guard.json'] })
      expect(readFileSync(join(dir, 'guard.mjs'), 'utf8')).toBe('export const version = 2\n')
      expect(readFileSync(join(dir, 'guard.json'), 'utf8')).toBe('{"version":1,"mine":true}\n')
      // The changed copy is reported on every start until the operator takes the bundled one by deleting theirs.
      expect(seedBundledExtensions(dir, pkg)).toEqual({ ...nothing, kept: ['guard.json'] })
      rmSync(join(dir, 'guard.json'))
      expect(seedBundledExtensions(dir, pkg)).toEqual({ ...nothing, seeded: ['guard.json'] })
      expect(readFileSync(join(dir, 'guard.json'), 'utf8')).toBe('{"version":2}\n')
      expect(seedBundledExtensions(dir, pkg)).toEqual(nothing)
    } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
  })

  it('never overwrites a copy seeded before the record existed, and upgrades it later only if it was unchanged', () => {
    const pkg = temp('ext-pkg-')
    const dir = temp('ext-seed-')
    try {
      // What an earlier version of the plugin left: copies without a record, the config tuned by the operator.
      bundle(pkg, 1)
      bundle(dir, 1)
      writeFileSync(join(dir, 'guard.json'), '{"version":1,"mine":true}\n')
      expect(seedBundledExtensions(dir, pkg)).toEqual(nothing)
      expect(readFileSync(join(dir, 'guard.json'), 'utf8')).toBe('{"version":1,"mine":true}\n')
      bundle(pkg, 2)
      expect(seedBundledExtensions(dir, pkg)).toEqual({ ...nothing, upgraded: ['guard.mjs'], kept: ['guard.json'] })
    } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) }
  })

  it('leaves alone, and does not mount, an extension a <name>.disabled marker switches off', () => {
    const dir = temp('ext-seed-')
    try {
      writeFileSync(join(dir, 'context-guard.disabled'), '')
      expect(seedBundledExtensions(dir)).toEqual({ ...nothing, disabled: ['context-guard'] })
      expect(existsSync(join(dir, 'context-guard.mjs'))).toBe(false)
      // The loader mounts only extensions without a marker, the operator's own included; deleting a marker brings its extension back.
      writeFileSync(join(dir, 'context-guard.mjs'), 'export function apply() {}\n')
      writeFileSync(join(dir, 'mine.mjs'), 'export function apply() {}\n')
      writeFileSync(join(dir, 'mine.disabled'), '')
      expect(enabledExtensions(dir)).toEqual([])
      rmSync(join(dir, 'context-guard.disabled'))
      expect(enabledExtensions(dir)).toEqual(['context-guard.mjs'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('extension configuration', () => {
  it('mounts an extension with its .json over the host defaults, a key the operator file sets deciding', () => {
    const dir = temp('ext-config-')
    try {
      const file = join(dir, 'guard.json')
      expect(extensionConfig(file, { stateDir: '/srv/state' })).toEqual({ stateDir: '/srv/state' })
      writeFileSync(file, '{"warnRatio":0.5}')
      expect(extensionConfig(file, { stateDir: '/srv/state' })).toEqual({ stateDir: '/srv/state', warnRatio: 0.5 })
      writeFileSync(file, '{"stateDir":"/srv/elsewhere"}')
      expect(extensionConfig(file, { stateDir: '/srv/state' })).toEqual({ stateDir: '/srv/elsewhere' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('context-guard logic', () => {
  it('reports real usage, files a rotation request past the hard threshold, and exempts the main Session', () => {
    const state = temp('ext-state-')
    // A temporary home directory: a guard that ignored the state directory it is given would write its handoffs there.
    const home = temp('ext-home-')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
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
      // The configuration the loader mounts it with: the seeded .json over the plugin's state directory.
      seedBundledExtensions(join(state, 'extensions'))
      contextGuard(ctx, extensionConfig(join(state, 'extensions', 'context-guard.json'), { stateDir: state }))
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
      expect(existsSync(join(home, '.dsh'))).toBe(false)

      // The main Session is exempt (C-13c): the same usage on the orchestrator files no rotation.
      hooks.broadcastSessionEvent({ sessionId: 'orchestrator-x', role: 'orchestrator', contextWindow: 1000,
        event: { type: 'assistant/message', data: { contextWindow: 1000, usage: { totalTokens: 900 } } } })
      expect((hooks.status().rotationRequests as { sessionId: string }[]).some(request => request.sessionId === 'orchestrator-x')).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      vi.unstubAllEnvs()
      rmSync(state, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
    }
  })
})
