/** StuckWatch (C-12b): the dual signal, one report per episode, the grace, the exemptions, and the live threshold. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { StuckWatch, type StuckHost, type WatchedSession } from '../src/app/stuck.ts'

const MINUTE = 60_000
/** A context that only records what StuckWatch subscribes to, and the agents it looks up. */
function fakeContext(agents: Map<string, { status: string }>) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  const context = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1) }
    },
    agents: { get: (id: string) => agents.get(id) },
  } as unknown as Context
  const emit = (event: string, ...args: unknown[]) => { for (const handler of [...handlers.get(event) ?? []]) handler(...args) }
  return { context, emit }
}
/** A watch over one running worker, with the host's readings as mocks the test drives. The first check runs five minutes in. */
function setup(options: { threshold?: number; watched?: WatchedSession[] } = {}) {
  const agents = new Map<string, { status: string }>([['worker-1', { status: 'running' }]])
  const { context, emit } = fakeContext(agents)
  const exempt = new Set<string>()
  const host: StuckHost = {
    context,
    watched: () => options.watched ?? [{ sessionId: 'worker-1', role: 'worker', ticketId: 't-1' }],
    thresholdMinutes: vi.fn(() => options.threshold ?? 60),
    exempt: id => exempt.has(id),
    onStuck: vi.fn(),
    closing: vi.fn(() => false),
  }
  const watch = new StuckWatch(host)
  watch.install()
  return {
    host, watch, agents, exempt,
    minutes: (n: number) => vi.advanceTimersByTime(n * MINUTE),
    /** A model action: the model said something. */
    action: (id = 'worker-1') => emit('session/event', { id }, { type: 'assistant/message' }),
    /** Context growth: a usage reading on an event that is no model action. */
    grow: (tokens: number, id = 'worker-1') => emit('session/event', { id }, { type: 'user/message', data: { usage: { totalTokens: tokens } } }),
    status: (status: string, id = 'worker-1') => { const agent = agents.get(id); if (agent) agent.status = status; emit('agent/status', { agent: { id }, status }) },
  }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T00:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

it('reports once when both the model action and the context growth stayed flat past the threshold', () => {
  const s = setup()
  s.minutes(65)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
  expect(s.host.onStuck).toHaveBeenCalledWith({ sessionId: 'worker-1', role: 'worker', ticketId: 't-1', minutes: 60 })
  // The same episode is not reported again, however long it stays flat.
  s.minutes(15)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
})

it('a model action starts a fresh stretch: the threshold counts from it, and a new episode may report again', () => {
  const s = setup()
  s.minutes(55)
  s.action()
  s.minutes(10)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.minutes(50)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
  expect(s.host.onStuck).toHaveBeenCalledWith({ sessionId: 'worker-1', role: 'worker', ticketId: 't-1', minutes: 60 })
  // An action after the report opens a new episode, which reports again once flat past the threshold.
  s.action()
  s.minutes(60)
  expect(s.host.onStuck).toHaveBeenCalledTimes(2)
})

it('context growth resets the stretch, and a usage reading that did not grow does not', () => {
  const s = setup()
  s.minutes(55)
  s.grow(100)
  s.minutes(10)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.minutes(45)
  s.grow(100)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.minutes(5)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
  expect(s.host.onStuck).toHaveBeenCalledWith({ sessionId: 'worker-1', role: 'worker', ticketId: 't-1', minutes: 60 })
})

it('does not judge an idle session, and a turn that ended clears its episode (C-12b.4)', () => {
  const s = setup()
  s.minutes(30)
  s.status('idle')
  s.minutes(200)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  // A new turn is a new episode, judged from its own start.
  s.status('running')
  s.minutes(65)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
})

it('skips a session waiting at a clean node for adjudication, and judges it once the wait ends (C-16a)', () => {
  const s = setup({ threshold: 1 })
  s.exempt.add('worker-1')
  s.minutes(20)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.exempt.delete('worker-1')
  s.minutes(5)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.minutes(5)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
})

it('gives a session first seen running the five-minute grace before judging it', () => {
  const s = setup({ threshold: 1 })
  s.minutes(5)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  s.minutes(5)
  expect(s.host.onStuck).toHaveBeenCalledTimes(1)
})

it('reads the threshold from the execution settings at every check (C-12b.5)', () => {
  const s = setup({ threshold: 120 })
  s.minutes(65)
  expect(s.host.onStuck).not.toHaveBeenCalled()
  vi.mocked(s.host.thresholdMinutes).mockReturnValue(1)
  s.minutes(5)
  expect(s.host.onStuck).toHaveBeenCalledWith({ sessionId: 'worker-1', role: 'worker', ticketId: 't-1', minutes: 65 })
})

it('judges nothing while the host is closing', () => {
  const s = setup()
  vi.mocked(s.host.closing).mockReturnValue(true)
  s.minutes(200)
  expect(s.host.onStuck).not.toHaveBeenCalled()
})

it('watches the foreman entry with its role, and reports it the same way', () => {
  const s = setup({ watched: [{ sessionId: 'superagent-foreman', role: 'foreman' }] })
  s.agents.set('superagent-foreman', { status: 'running' })
  s.minutes(65)
  expect(s.host.onStuck).toHaveBeenCalledWith({ sessionId: 'superagent-foreman', role: 'foreman', minutes: 60 })
})

it('dispose stops the timer and unsubscribes the events', () => {
  const s = setup()
  s.watch.dispose()
  s.minutes(200)
  s.action()
  s.grow(10)
  s.minutes(200)
  expect(s.host.onStuck).not.toHaveBeenCalled()
})