/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import type { Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** Which C-15 situation the question is (item number 2-7), labelled on the panel's pending list (C-37.1). */
  questionKind?: number
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
  /** The Executor's own stop reason for a `failed` report: the session stopped working (N-13b), else the work failed. */
  stopReason?: 'session-stopped' | 'failed'
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the working directory and what was already done before continuing. Do not repeat an already completed operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, records the worker Session that runs it, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string, sessionId?: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    if (sessionId) assignment.sessionId ??= sessionId
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting` and no input was delivered after that report, or its worker waits at a clean node for adjudication (C-16a),
   * in which case it keeps its session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = (!!report && report.state === 'waiting' && !busy) || !!ticket.attention
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment (N-13: a ticket is working or stopped).
   * A question stops the worker at a clean node awaiting adjudication and keeps the ticket open (C-16a). A `ready` report
   * delivers: the ticket ends as `delivered`. A `dropped` report ends it the same way with nothing to do. A `failed` report,
   * or a `blocked` one without a question, ends the ticket as `failed` (or `session-stopped` when the Executor says the
   * session stopped working, N-13b); continuing the task takes a new ticket (N-13a).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}),
      ...(report.questionKind ? { kind: report.questionKind } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id)
    assignment.report = { state: report.state, summary: report.summary, at }
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    this.repo.tickets.save(ticket)
    // Delivery ends the ticket: a ready result, or nothing left to do (dropped). Followed threads, when they already closed,
    // name the legacy outcome; the stop reason is `delivered` either way (N-13).
    if (report.state === 'ready' || report.state === 'dropped') {
      const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped'
        : !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome ?? 'completed'
      this.tickets.end(ticketId, 'executor', outcome, at, undefined, 'delivered')
      return this.require(ticketId)
    }
    // A worker that settled at the person's wrap-up ends its ticket as wrapped (C-17b item 3); the task goes on in a new ticket (N-13a).
    if (report.state === 'wrapped') {
      this.tickets.end(ticketId, 'executor', 'stopped', at, report.summary, 'wrapped')
      return this.require(ticketId)
    }
    // Failure ends the ticket; a blocked report without a question is a failure too — a question would have kept it open (C-16a).
    if (report.state === 'failed' || (report.state === 'blocked' && !attention)) {
      this.tickets.end(ticketId, report.stopReason === 'session-stopped' ? 'system' : 'executor', 'stopped', at, report.summary,
        report.stopReason ?? 'failed')
    }
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
