import { describe, expect, it } from 'vitest'
import { ticketStage, ticketStop, type Assignment, type ReportState, type Ticket, type TicketEndBy, type TicketOutcome, type TicketStopReason } from '../src/core/index.ts'

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'a', state: 'running', createdAt: '', ...overrides })
const reported = (state: ReportState, overrides: Partial<Assignment> = {}) => assignment({ report: { state, summary: '', at: '' }, ...overrides })
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
  channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides })
const attention = { id: 'q', question: '?' }
const ended = { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const }

// A ticket is working or stopped (N-07); an open ticket's stage only describes how it works, and a stopped one is ended.
describe('ticketStage', () => {
  it.each([
    ['an ended Ticket', ticket({ ended, attention, assignments: [reported('failed')] }), { stage: 'ended' }],
    ['an Attention', ticket({ attention }), { stage: 'adjudication' }],
    ['an Attention beside a ready Report', ticket({ attention, assignments: [reported('ready')] }), { stage: 'adjudication' }],
    ['an Attention beside a failed Report', ticket({ attention, assignments: [reported('failed')] }), { stage: 'adjudication' }],
    ['an Attention beside a delivery failure', ticket({ attention, delivery: { error: 'offline', at: '' } }), { stage: 'adjudication' }],
    ['no Assignment', ticket({ assignments: [] }), { stage: 'queued' }],
    ['a pending Assignment', ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }), { stage: 'queued' }],
    ['a running Assignment', ticket(), { stage: 'working' }],
    ['a progress Report', ticket({ assignments: [reported('progress')] }), { stage: 'working' }],
    ['a waiting Report of a running Assignment', ticket({ assignments: [reported('waiting')] }), { stage: 'working' }],
    ['a ready Report of a running Assignment', ticket({ assignments: [reported('ready')] }), { stage: 'working' }],
    ['a blocked Report of a running Assignment', ticket({ assignments: [reported('blocked')] }), { stage: 'working' }],
    ['a failed Report of a running Assignment', ticket({ assignments: [reported('failed')] }), { stage: 'working' }],
    ['a delivery failure on a running Assignment', ticket({ delivery: { error: 'offline', at: '' } }), { stage: 'working' }],
    ['an ended Assignment', ticket({ assignments: [assignment({ state: 'ended' })] }), { stage: 'idle' }],
    ['a waiting Report of an ended Assignment', ticket({ assignments: [reported('waiting', { state: 'ended' })] }), { stage: 'idle' }],
    ['a ready Report of an ended Assignment', ticket({ assignments: [reported('ready', { state: 'ended' })] }), { stage: 'idle' }],
  ])('%s', (_name, value, stage) => { expect(ticketStage(value)).toEqual(stage) })
})

// The six stop reasons (N-13): ticketStop reads ended.stop, and maps the legacy outcomes of records written before it.
describe('ticketStop', () => {
  it('reads nothing for an open Ticket', () => {
    expect(ticketStop(ticket())).toBeUndefined()
    expect(ticketStop({})).toBeUndefined()
  })
  it.each([
    ['delivered', 'executor'], ['user-stopped', 'human'], ['stuck', 'foreman'], ['emergency', 'foreman'],
    ['session-stopped', 'system'], ['failed', 'executor'],
  ] as [TicketStopReason, TicketEndBy][])('reads the recorded stop reason %s', (stop, by) => {
    expect(ticketStop(ticket({ ended: { at: '', by, outcome: 'stopped', stop } }))).toBe(stop)
  })
  it.each([
    ['completed', 'delivered'], ['merged', 'delivered'], ['closed', 'delivered'], ['dropped', 'delivered'],
  ] as [TicketOutcome, TicketStopReason][])('maps the legacy outcome %s onto delivered', (outcome, stop) => {
    expect(ticketStop(ticket({ ended: { at: '', by: 'executor', outcome } }))).toBe(stop)
  })
  it('maps a legacy stop by a person onto user-stopped, and any other onto failed', () => {
    expect(ticketStop(ticket({ ended: { at: '', by: 'human', outcome: 'stopped' } }))).toBe('user-stopped')
    for (const by of ['executor', 'foreman', 'system'] as TicketEndBy[]) {
      expect(ticketStop(ticket({ ended: { at: '', by, outcome: 'stopped' } }))).toBe('failed')
    }
  })
  it('prefers the recorded stop reason over the legacy outcome', () => {
    expect(ticketStop(ticket({ ended: { at: '', by: 'executor', outcome: 'merged', stop: 'emergency' } }))).toBe('emergency')
  })
})
