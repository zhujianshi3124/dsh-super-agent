/** Trigger timestamp normalization and neighbour lookup, as the store keeps them. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Engine, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-timeline-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(githubKind)
const engine = () => new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(SettingsSchema.parse({}), sources),
  assessor: { request: () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
const comment = (id: string, at: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'alice' },
  human: true, at, text: `comment ${id}`, meta: {} })

it('finds the Triggers before and after one among Triggers of the same time', () => {
  for (const item of [comment('a', '2026-10-01T00:00:01.000Z'), comment('b', '2026-10-01T00:00:01.000Z'), comment('c', '2026-10-01T00:00:01.000Z')]) store.triggers.save(item)
  const around = store.read.neighbours('github:7', '2026-10-01T00:00:01.000Z', 'b')
  expect([around.before?.id, around.after?.id]).toEqual(['a', 'c'])
})

it('stores every received Trigger\'s time in the one form stored times take', () => {
  engine().receive(comment('raw', '2026-10-01T08:00:00+08:00'))
  expect(store.triggers.get('raw')?.at).toBe('2026-10-01T00:00:00.000Z')
  expect(store.read.threadTriggers('github:7').map(item => item.at)).toEqual(['2026-10-01T00:00:00.000Z'])
})
