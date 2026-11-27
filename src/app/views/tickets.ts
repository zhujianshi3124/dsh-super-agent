/** Ticket list, ticket detail, and executor load views. */
import { liveTicket, threadKey, ticketStage, type Ticket } from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { Store } from '../store.ts'
import { newestFirst, page, snapshot, ticketLine, type Snapshot, type ViewHost } from './records.ts'
import { markdown, preview } from './text.ts'

/** The execution page's three filters (C-37d): working (every open ticket), stopped, and all. */
export type TicketFilter = 'working' | 'ended' | 'all'
export function ticketList(host: ViewHost, filter: TicketFilter, offset: number, limit: number) {
  const view = snapshot(host)
  const { store } = view
  const tickets = (filter === 'working' ? store.tickets.open() : store.tickets.list())
    .filter(ticket => filter === 'all' || (filter === 'working' ? liveTicket(ticket) : !liveTicket(ticket))).sort(newestFirst)
  const result = page(tickets, offset, limit)
  return { ...result, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
export type TicketListView = ReturnType<typeof ticketList>
export function ticketRow(view: Snapshot, ticket: Ticket) {
  return ticketLine(view, ticket)
}
/** Executor slot utilization: `running` worker Sessions in an active turn (which occupy slots and are interrupted by a restart), and tickets `queued` for a slot or a named session. */
export interface ExecutorLoad { running: number; queued: number }
export function executorLoad(store: Store, running: number): ExecutorLoad {
  return { running, queued: store.tickets.open().filter(ticket => ticketStage(ticket).stage === 'queued').length }
}
export function ticketDetail(host: ViewHost, id: string) {
  const { store } = host
  const ticket = store.tickets.get(id)
  if (!ticket) return undefined
  const view = snapshot(host)
  const { stage } = ticketStage(ticket)
  const input = (value: Ticket['inputs'][number]) => {
    const trigger = value.kind === 'trigger' ? store.triggers.get(value.triggerId) : undefined
    const handback = trigger && store.triggers.disposition(trigger.id)?.handbacks?.find(item => item.ticketId === id)
    const shown = trigger && { id: trigger.id, actor: view.actor(trigger.actor, trigger.human), human: trigger.human,
      preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!),
      ...handback ? { handback: { reason: handback.reason, at: handback.at } } : {} }
    const text = (value.kind === 'text' || value.kind === 'note') && value.text ? { text: markdown(value.text) } : {}
    return { ...value, ...text, delivered: !ticket.undelivered.includes(value.id), ...shown ? { trigger: shown } : {} }
  }
  // C-37d: status, the question awaiting adjudication, the stop reason, inputs, dispatch history with generations,
  // the working directory, and the identifier. External channels and mandate internals are not part of the page.
  return { ...ticketLine(view, ticket), paused: store.settings().paused,
    criteria: ticket.criteria ?? [],
    // Every started Assignment ran in the ticket's one worker Session. Each Assignment names the Session it ran in, so a
    // rotation shows which generation did which round (C-29); one recorded before that was kept falls back to the current worker.
    assignments: ticket.assignments.map(assignment => ({ ...assignment, ...assignment.startedAt
      ? { ref: assignment.sessionId ?? host.workerSession?.(ticket.id) ?? workerSessionId(ticket.id) } : {},
      ...assignment.state === 'running' && assignment.report && assignment.report.state !== 'progress' && stage !== 'working'
        ? { turnEndedAt: assignment.report.at } : {} })),
    // Every worker session the ticket has used, so a rotation is traceable after the fact (C-29).
    sessions: (host.workerSessions?.(id) ?? [workerSessionId(id)]).map(session => ({ id: session,
      current: session === (host.workerSession?.(id) ?? workerSessionId(id)) })),
    // What the foreman decided about this ticket, oldest first (C-30).
    decisions: ticket.decisions ?? [],
    inputs: ticket.inputs.slice().reverse().map(input) }
}
export type TicketDetailView = NonNullable<ReturnType<typeof ticketDetail>>
