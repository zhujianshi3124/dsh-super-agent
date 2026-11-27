// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession } from '../src/navigation.ts'
import { initialLocation, lastSettingsGroup, parseRoute, remember, settingsRoute } from '../src/client/route.ts'
const id = 'orchestrator-test' as SessionId
function fixture(ready = false) {
  const pending = Promise.withResolvers<void>()
  const state = { phase: ready ? 'ready' : 'pending', byId: ready ? { [id]: {} } : {} as Record<string, object> }
  const refresh = vi.fn(async () => { await pending.promise })
  // Navigation reads only catalog readiness and membership, not summary fields.
  const sessions = { list: { getSnapshot: () => state }, refresh } as unknown as Pick<ISessions, 'list' | 'refresh'>
  return { sessions, pending, state, refresh }
}
it('waits for initial catalog hydration before opening the linked master', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  expect(open).not.toHaveBeenCalled()
  state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id)
})
it('opens known Sessions without another network refresh', async () => {
  const { sessions, refresh } = fixture(true); const open = vi.fn()
  await expect(openKnownSession(sessions, id, open, new AbortController().signal)).resolves.toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(id); expect(refresh).not.toHaveBeenCalled()
})
it('reports unavailable targets without calling the throwing Session selector', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn()
  const navigation = openKnownSession(sessions, id, open, new AbortController().signal)
  state.phase = 'ready'; pending.resolve()
  await expect(navigation).rejects.toMatchObject({ code: 'not-listed' })
  expect(open).not.toHaveBeenCalled()
})
it('does not navigate after the panel unmounts or a newer request supersedes it', async () => {
  const { sessions, pending, state } = fixture(); const open = vi.fn(); const controller = new AbortController()
  const navigation = openKnownSession(sessions, id, open, controller.signal)
  controller.abort(); state.phase = 'ready'; state.byId[id] = {}; pending.resolve()
  await expect(navigation).resolves.toBe(false); expect(open).not.toHaveBeenCalled()
})
it('reopens the page this tab showed last, and the overview for a route that no longer exists', () => {
  remember({ route: { page: 'execution', query: { filter: 'ended' } }, stack: [{ page: 'overview' }] })
  expect(initialLocation()).toEqual({ route: { page: 'execution', query: { filter: 'ended' } }, stack: [{ page: 'overview' }] })
  // The source/trigger/eval tabs are gone; a route saved under one of them falls back to overview.
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'eval', query: { filter: 'stop' } }, stack: [] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger', id: 'github:1' }, stack: [{ page: 'policy' }, { page: 'execution' }] }))
  expect(initialLocation()).toEqual({ route: { page: 'overview' }, stack: [] })
  sessionStorage.setItem('dsh-superagent/route', '{')
  expect(initialLocation().route).toEqual({ page: 'overview' })
})
it('reads each page a tab remembered with the parameters it takes, and leaves out what it does not know', () => {
  expect(parseRoute({ page: 'execution', query: { filter: 'nope', trigger: 'e1' } })).toEqual({ page: 'execution' })
  expect(parseRoute({ page: 'execution', id: 't1', query: { filter: 'ended' } })).toEqual({ page: 'execution', id: 't1' })
  expect(parseRoute({ page: 'execution', id: 5, query: { filter: 'ended' } })).toEqual({ page: 'execution', query: { filter: 'ended' } })
  expect(parseRoute({ page: 'proposal', id: 'pr-1' })).toEqual({ page: 'proposal', id: 'pr-1' })
  expect(parseRoute({ page: 'proposal' })).toBeUndefined()
  expect(parseRoute({ page: 'settings', query: { group: 'prompts', source: 'feishu' } }))
    .toEqual({ page: 'settings', query: { group: 'prompts' } })
  expect(parseRoute({ page: 'settings', query: { group: 'policy' } })).toEqual({ page: 'settings', query: { group: 'execution' } })
  expect(parseRoute({ page: 'settings' })).toEqual({ page: 'settings', query: { group: 'execution' } })
  expect([parseRoute('overview'), parseRoute(null)]).toEqual([undefined, undefined])
})
it('opens the settings group that fixes a missing role, and keeps the last group opened', () => {
  // A missing main Session or foreman points at the Deployment group (C-37.2).
  expect(settingsRoute('deployment')).toEqual({ page: 'settings', query: { group: 'deployment' } })
  for (const group of ['execution', 'prompts', 'deployment'] as const) expect(settingsRoute(group)).toEqual({ page: 'settings', query: { group } })
  expect(lastSettingsGroup({ route: settingsRoute('prompts'), stack: [] })).toBe('prompts')
  expect(lastSettingsGroup({ route: { page: 'overview' }, stack: [], group: 'deployment' })).toBe('deployment')
  expect(lastSettingsGroup({ route: { page: 'overview' }, stack: [] })).toBe('execution')
})
