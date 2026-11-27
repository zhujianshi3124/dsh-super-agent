import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, type Assessor, type Candidate, type Executor, type Outcome, type Policy, type Trigger } from '../src/core/index.ts'
import { awaitingConfirmation, claimedByProposal, Proposals } from '../src/app/proposals.ts'
import { Store } from '../src/app/store.ts'

const member = { source: 'chat', id: 'alice' }
const trigger = (id: string, thread = 't1'): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: thread }], actor: member, human: true,
  at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread, address: { message: id } }, meta: {} })

const dirs: string[] = []
const opened: Store[] = []
function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sa-proposals-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'state', 'orchestrator.sqlite'))
  opened.push(store)
  return store
}
afterEach(() => {
  // Close every handle first: Windows refuses to unlink a SQLite file that is still open.
  for (const store of opened.splice(0)) { try { store.close() } catch { /* already closed */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const task = { title: '改错字', request: '登录页错字全改掉', accept: '页面上没有错字' }

describe('proposal numbering and status', () => {
  it('numbers drafts in order, keeps the person\'s own words beside the confirmed tasks, and survives a reopen', () => {
    const opened = store()
    const proposals = new Proposals(opened)
    const first = proposals.draft({ tasks: [task], heard: '把登录页错字改一下', origin: { source: 'chief', thread: 'chief-main', messageId: 'm1' } })
    const second = proposals.draft({ tasks: [{ ...task, title: '优化首页' }], heard: '再优化下首页' })
    expect([first.id, second.id]).toEqual(['pr-1', 'pr-2'])
    expect(first).toMatchObject({ status: 'draft', ticketIds: [], heard: '把登录页错字改一下' })
    expect(first.tasks[0]).toEqual(task)
    opened.close()

    const reopened = new Store(join(dirs[0]!, 'state', 'orchestrator.sqlite'))
    expect(reopened.proposals.get('pr-1')).toMatchObject({ tasks: [task], heard: '把登录页错字改一下' })
    // The counter survives too, so a later draft never reuses a number.
    expect(new Proposals(reopened).draft({ tasks: [task], heard: '第三件' }).id).toBe('pr-3')
    reopened.close()
  })

  it('drafts one instruction per user message, whatever the model asks for (C-09a)', () => {
    const proposals = new Proposals(store())
    const origin = { source: 'chief', thread: 'chief-main', messageId: 'm7' }
    const first = proposals.draft({ tasks: [task], heard: '把登录页错字改一下', origin })
    // The same message drafted twice returns the first instruction: one number, one wording, nothing sent twice.
    const again = proposals.draft({ tasks: [{ ...task, title: '另一件' }], heard: '把登录页错字改一下', origin })
    expect(again.id).toBe(first.id)
    expect(again.tasks).toEqual(first.tasks)
    expect(proposals.list()).toHaveLength(1)
    // Another message is another instruction, and so is a draft that names no message.
    expect(proposals.draft({ tasks: [task], heard: '再来一件', origin: { ...origin, messageId: 'm8' } }).id).toBe('pr-2')
    expect(proposals.draft({ tasks: [task], heard: '没有来源的一件' }).id).toBe('pr-3')
  })

  it('refuses a task without a title or what to do, more than eight criteria lines, and a draft with no words of the person', () => {
    const opened = store()
    const proposals = new Proposals(opened)
    expect(() => proposals.draft({ tasks: [], heard: 'x' })).toThrow('at least one task')
    expect(() => proposals.draft({ tasks: [{ ...task, title: ' ' }], heard: 'x' })).toThrow('at least one task')
    expect(() => proposals.draft({ tasks: [{ ...task, request: ' ' }], heard: 'x' })).toThrow('at least one task')
    // Completion criteria are optional (C-13a): a task without them is complete, and a blank one still drafts.
    expect(proposals.draft({ tasks: [{ title: 't', request: 'r' }], heard: 'x' }).tasks[0]).toEqual({ title: 't', request: 'r' })
    expect(proposals.draft({ tasks: [{ ...task, accept: ' ' }], heard: 'x' }).tasks[0]).toMatchObject({ title: '改错字', request: '登录页错字全改掉' })
    // At most eight lines of criteria, merged while drafting (N-08).
    expect(() => proposals.draft({ tasks: [{ ...task, accept: Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n') }], heard: 'x' }))
      .toThrow('more than 8 completion criteria lines')
    expect(() => proposals.draft({ tasks: [task], heard: '  ' })).toThrow('needs the person')
    opened.close()
  })

  it('approves once and keeps the first approval', () => {
    const opened = store()
    const proposals = new Proposals(opened)
    const draft = proposals.draft({ tasks: [task], heard: 'x' })
    const approved = proposals.approve(draft.id)
    expect(approved.status).toBe('approved')
    expect(proposals.approve(draft.id).approvedAt).toBe(approved.approvedAt)
    expect(() => proposals.approve('pr-99')).toThrow('Unknown instruction pr-99')
    opened.close()
  })
})

describe('who may confirm an instruction', () => {
  it('treats it as unconfirmed while the person\'s latest message is the one it was drafted from', () => {
    const proposals = new Proposals(store())
    const proposal = proposals.draft({ tasks: [task], heard: '把登录页错字改一下',
      origin: { source: 'chief', thread: 'chief-main', messageId: 'm1' } })
    expect(awaitingConfirmation(proposal, 'm1')).toBe(true)
    expect(awaitingConfirmation(proposal, 'm2')).toBe(false)
    // Without a reply at all, or without the message it was drafted from, nothing can confirm it.
    expect(awaitingConfirmation(proposal, undefined)).toBe(true)
    expect(awaitingConfirmation(proposals.draft({ tasks: [task], heard: 'x' }), 'm2')).toBe(true)
  })
})

describe('the approved-instruction gate', () => {
  const harness = (required: boolean) => {
    const repo = new MemoryRepositories()
    const requests: Candidate[] = []
    const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
    const launches: string[] = []
    const executor: Executor = { start: vi.fn(ticket => { launches.push(ticket.id) }), deliver: vi.fn(), stop: vi.fn() }
    const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true,
      admitsInferred: rules => rules.length > 0 }
    const outbox: { send: () => void; status: () => undefined; withdraw: () => void } = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor, outbox,
      proposalsRequired: () => required, now: () => '2026-11-18T12:00:00.000Z' })
    const decide = (id: string, outcome: Outcome, thread = 't1') => {
      engine.receive(trigger(id, thread)); engine.evaluateDue()
      return engine.decide(id, { ...outcome, evalId: requests.at(-1)!.evalId })
    }
    return { repo, engine, decide, launches, requests }
  }
  const accept = (proposal?: string, title = 'Fix'): Outcome => ({ kind: 'accept', title, scope: 'small', reason: 'requested',
    ...(proposal ? { audit: { proposal } } : {}) } as Outcome)

  it('leaves ticket creation exactly as before while the switch is off, and still links a named instruction', () => {
    const h = harness(false)
    expect(h.decide('1', accept())).toMatchObject({ kind: 'accept' })
    expect(h.repo.tickets.list()).toHaveLength(1)
    expect(h.launches).toHaveLength(1)
  })

  it('refuses an accept that names no instruction, or a draft one, and writes nothing', () => {
    const h = harness(true)
    const draft = { id: 'pr-1', status: 'draft' as const, tasks: [task], heard: 'x', createdAt: '2026-11-18T00:00:00.000Z', ticketIds: [] }
    h.repo.proposals.save(draft)
    expect(() => h.decide('1', accept())).toThrow('No approved instruction')
    expect(() => h.decide('1', accept('pr-1'))).toThrow('No approved instruction')
    expect(() => h.decide('1', accept('pr-404'))).toThrow('No approved instruction')
    expect(h.repo.tickets.list()).toHaveLength(0)
    expect(h.repo.decisions.byThread('chat:t1')).toHaveLength(0)
    expect(h.launches).toHaveLength(0)
    expect(h.repo.proposals.get('pr-1')?.status).toBe('draft')
  })

  it('creates the ticket under an approved instruction, marks it dispatched, and lets its sub-tickets join without a new approval', () => {
    const h = harness(true)
    h.repo.proposals.save({ id: 'pr-1', status: 'approved', tasks: [task], heard: 'x', createdAt: '2026-11-18T00:00:00.000Z',
      approvedAt: '2026-11-18T00:01:00.000Z', ticketIds: [] })
    const first = h.decide('1', accept('pr-1'))
    const second = h.decide('2', accept('pr-1', 'Sub-ticket'), 't2')
    expect([first.kind, second.kind]).toEqual(['accept', 'accept'])
    expect(h.repo.tickets.list()).toHaveLength(2)
    expect(h.repo.proposals.get('pr-1')).toMatchObject({ status: 'dispatched', ticketIds: [first.ticketId, second.ticketId] })
    expect(h.launches).toHaveLength(2)
  })
})

describe('claimedByProposal (C-09a)', () => {
  const draft = { id: 'pr-7', status: 'draft' as const, tasks: [], heard: '```\r\n新任务：初始化\r\n完成标准：绿灯', createdAt: '2026-11-24T02:12:05.000Z',
    origin: { source: 'chief', thread: 'S', messageId: 'B' }, ticketIds: [] }
  const message = (messageId: string, at: string, text: string, sessionId = 'S') => ({ at, text, meta: { sessionId, messageId } })
  it('claims the message an instruction was drafted from', () => {
    expect(claimedByProposal([draft], message('B', '2026-11-24T02:11:39.000Z', 'anything'))).toBe(true)
  })
  it('claims an earlier copy of the same words the person cut off and sent again, ignoring line endings and blanks', () => {
    expect(claimedByProposal([draft], message('A', '2026-11-24T02:10:21.000Z', '```\n新任务：初始化\n完成标准：绿灯\n'))).toBe(true)
  })
  it('does not claim different words, the same words in another Session, or the same words after the approval', () => {
    expect(claimedByProposal([draft], message('C', '2026-11-24T02:13:00.000Z', '新任务：初始化'))).toBe(false)
    expect(claimedByProposal([draft], message('D', '2026-11-24T02:13:00.000Z', draft.heard, 'other'))).toBe(false)
    const approved = { ...draft, status: 'approved' as const, approvedAt: '2026-11-24T02:30:00.000Z' }
    expect(claimedByProposal([approved], message('E', '2026-11-24T02:10:21.000Z', draft.heard))).toBe(true)
    expect(claimedByProposal([approved], message('F', '2026-11-25T02:00:00.000Z', draft.heard))).toBe(false)
  })
  it('still claims the confirmation between the draft and its approval', () => {
    const approved = { ...draft, status: 'approved' as const, approvedAt: '2026-11-24T02:30:00.000Z' }
    expect(claimedByProposal([approved], message('G', '2026-11-24T02:29:00.000Z', '确认'))).toBe(true)
  })
})

