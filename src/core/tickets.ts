/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { awaitingAdjudication, latestAssignment, latestReport, liveTicket, readUntil, runningAssignment, settled, threadKey } from './model.ts'
import type { Assignment, ChannelRef, Evaluation, Follow, Mandate, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome,
  TicketStopReason, Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'
/**
 * The one sentence a worker that stopped halfway gets when the foreman lets it go on (C-13e item 2): fixed by the host,
 * it carries no new requirement and is no clarification of the ticket (C-24).
 */
export const CONTINUE_REQUEST = '从停下的地方接着干这张工单。'
/** The one sentence a worker gets when the foreman passes on the person's wrap-up (C-17b item 2): fixed by the host, no new requirement (C-24). */
export const WRAP_UP_REQUEST = '用户收工：做完手上这一步，把进度写进交接文档，报收工，不要开始下一步。'

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    // A ticket belongs to the instruction the person confirmed, named by the accept's audit; with the gate on, one that
    // names no instruction or a draft one is refused before anything is written, so no ticket exists without approval.
    const proposalId = typeof outcome.audit?.proposal === 'string' ? outcome.audit.proposal : undefined
    const proposal = proposalId === undefined ? undefined : this.repo.proposals.get(proposalId)
    if (this.options.proposalsRequired?.() && proposal?.status !== 'approved' && proposal?.status !== 'dispatched') {
      throw new UserError('notApproved', { proposal: proposalId ?? 'none' })
    }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin }
    // The instruction and task this ticket carries (C-22, C-29), and the stopped ticket it continues, if any (N-13a).
    const taskNumber = typeof outcome.audit?.task === 'number' ? outcome.audit.task : undefined
    if (proposalId !== undefined) ticket.proposal = proposalId
    if (taskNumber !== undefined) ticket.task = taskNumber
    const continues = typeof outcome.audit?.continues === 'string' ? outcome.audit.continues : undefined
    if (continues) ticket.continues = continues
    // Completion criteria: the accept's copied lines, else the instruction task's own wording split into lines (N-08, C-13a).
    const task = proposal && taskNumber !== undefined ? proposal.tasks[taskNumber - 1] : undefined
    const criteria = (outcome.acceptance?.length ? outcome.acceptance : task?.accept?.split('\n') ?? [])
      .map(item => item.trim()).filter(Boolean).slice(0, 8)
    if (criteria.length) ticket.criteria = criteria
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const assignment = this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    // The person may have named the worker session that takes this ticket (C-12); the slot is bound before its first launch.
    // While that session finishes another ticket, this one waits for it: the launch reads its actual usage when it is free.
    if ('workerSession' in outcome && outcome.workerSession) {
      this.options.bindWorker?.(id, outcome.workerSession)
      ticket.waitingFor = outcome.workerSession
      this.repo.tickets.save(ticket)
    }
    // The instruction now has this ticket; later sub-tickets of the same instruction join it rather than needing a new approval.
    if (proposal) this.repo.proposals.save({ ...proposal, status: 'dispatched', approvedAt: proposal.approvedAt ?? at,
      dispatchedAt: proposal.dispatchedAt ?? at, ticketIds: proposal.ticketIds.includes(id) ? proposal.ticketIds : [...proposal.ticketIds, id] })
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    this.options.executor.start(this.require(id), assignment)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at, undefined, 'delivered')
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or the ticket ended — an ended ticket takes nothing (C-11, N-13).
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    // A ticket that ended stays ended: what continues from its result is new work, which a new ticket carries (C-11).
    if (!liveTicket(current)) throw new UserError('ticketEnded')
    return trigger
  }
  /**
   * Subscribe an open ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's
   * worker then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold
   * the message as its ticket's takes it as a new Input.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, or its worker read it for context only,
    // so the worker gets it again.
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Whether a ticket's worker stopped halfway (C-13e item 1): the ticket is open, its latest report is `waiting` — its turn
   * ended with no report and no question — it waits for no adjudication (C-16a), and nothing reached it since: no Input
   * waits for delivery and none was delivered after that report, either of which means its worker has work again.
   */
  stalled(ticket: Ticket): boolean {
    const assignment = runningAssignment(ticket), report = assignment?.report
    if (!liveTicket(ticket) || ticket.attention || !report || report.state !== 'waiting' || ticket.undelivered.length > 0) return false
    return !(assignment?.deliveredAt && assignment.deliveredAt >= report.at)
  }
  /**
   * Lets a worker that stopped halfway go on (C-13e item 2): the fixed sentence `CONTINUE_REQUEST` goes to it as an Input.
   * Its delivery fulfils a pending rotation first, so a successor continues when one waits (C-13b).
   * @returns whether the sentence was queued: false when the ticket did not stop halfway (see `stalled`).
   * @throws UserError when the ticket is unknown.
   */
  continueStalled(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    if (!this.stalled(ticket)) return false
    this.addInput(ticket, { id: `continue:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: CONTINUE_REQUEST, at: this.now() })
    return true
  }
  /**
   * Passes the person's wrap-up to a ticket's worker (C-17b item 2): the fixed sentence `WRAP_UP_REQUEST` goes to it as an Input.
   * @throws UserError when the ticket is unknown or ended.
   */
  wrapUp(ticketId: string): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    this.addInput(ticket, { id: `wrap-up:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: WRAP_UP_REQUEST, at: this.now() })
  }
  /**
   * Ends a ticket whose worker settled at the person's wrap-up (C-17b item 3): stop reason `wrapped`; the task goes on in a
   * new ticket under the same instruction once the person starts work (N-13a).
   * @throws UserError when the ticket is unknown.
   */
  endWrapped(ticketId: string, by: 'foreman' | 'system', reason?: string): Ticket {
    this.end(ticketId, by, 'stopped', this.now(), reason, 'wrapped')
    return this.require(ticketId)
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments (C-17a): stopped means ended, immediately.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason, 'user-stopped')
    return this.require(ticketId)
  }
  /**
   * The foreman stops a ticket's worker session: a stuck one (C-12b), every worker in an emergency (C-16b), or one that
   * keeps stopping halfway with no progress, which ends failed (C-13e, N-13).
   * The ticket ends with that stop reason; continuing the task takes a new ticket (N-13a).
   * @throws UserError when the ticket is unknown.
   */
  stopByForeman(ticketId: string, stop: 'stuck' | 'emergency' | 'failed', reason?: string): Ticket {
    this.end(ticketId, 'foreman', 'stopped', this.now(), reason, stop)
    return this.require(ticketId)
  }
  /**
   * Resumes a ticket whose worker stopped at a clean node awaiting adjudication (C-16a): the person's decision reaches the
   * worker as an input and its session starts again at once. The ticket never ended, so this is no reopening (C-11).
   * @throws UserError when the ticket is unknown, ended, or not awaiting adjudication.
   */
  resume(ticketId: string, instruction: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (!ticket.attention) throw new UserError('notAdjudication')
    delete ticket.attention
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.addInput(ticket, { id: key('input', ticketId, 'adjudication', ticket.updatedAt), kind: 'text', text: instruction, at: this.now() })
    return this.require(ticketId)
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker waits at a clean node for the person's adjudication (C-16a).
    const held = liveTicket(ticket) && automatic(input) && awaitingAdjudication(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !awaitingAdjudication(ticket)) this.options.executor.start(ticket, latest)
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    return acked ? acked.includes(ticket.id) : this.options.outbox.status(key('ack', trigger.id)) !== undefined
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ends lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string, stop?: TicketStopReason): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    // The canonical stop reason (N-13); a caller that passes none maps the legacy outcome onto one.
    const stopped: TicketStopReason = stop ?? (outcome === 'stopped' ? (by === 'human' ? 'user-stopped' : 'failed') : 'delivered')
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, stop: stopped, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery; delete ticket.waitingFor
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, stop: stopped, ...why })
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work started
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now() }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * Record what the foreman decided about a ticket, so a successor foreman reads it instead of deciding or asking again (C-30).
   * @throws UserError when the ticket is unknown.
   */
  decide(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    const at = this.now()
    ticket.decisions = [...ticket.decisions ?? [], { at, text }]
    ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
