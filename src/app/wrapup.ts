/**
 * The person's wrap-up and start of work (C-17b): wrapping up holds every launch and tells the foreman, who passes it to each
 * open ticket so its worker settles at a clean node; the panel shows when every one settled, so the person can shut down.
 * Starting work lifts the hold and tells the foreman to continue the unfinished tasks with new tickets under their original
 * confirmed instructions (N-13a). The state is stored, so it survives the shutdown it exists for.
 */
import { liveTicket, ticketStop, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** The one sentence the foreman gets when the person wraps up (C-17b item 2): fixed by the host, no new requirement (C-24). */
export const WRAP_UP_NOTICE = '用户收工：让每张正在工作的工单停在干净节点。'
/** The one sentence the foreman gets when the person starts work (C-17b item 6): fixed by the host, no new requirement (C-24). */
export const START_WORK_NOTICE = '用户开工：按原来的已确认清单，接着做收工时没做完的任务。'
/** One wrap-up or start of work, kept for the panel's history (C-17b item 7). */
export interface WrapUpEvent { kind: 'wrap-up' | 'start-work'; at: string }
/** What the panel shows of a wrap-up (C-17b items 4 and 7). */
export interface WrapUpView { active: boolean; since: string | null; settled: number; working: { id: string; title: string }[]
  ready: boolean; history: WrapUpEvent[] }
export interface WrapUpHost {
  readonly store: Pick<Store, 'get' | 'set' | 'delete' | 'tickets' | 'atomic'>
  readonly sessions: Pick<Sessions, 'foremanRelay'>
  /** Schedules a pass, so held launches go out once work starts. */
  requestPass(): void
}
const HISTORY = 20
const brief = (ticket: Ticket) => ({ ticket_id: ticket.id, title: ticket.title, ...(ticket.proposal ? { proposal: ticket.proposal } : {}),
  ...(ticket.task !== undefined ? { task: ticket.task } : {}) })
/** Holds the person's wrap-up across a shutdown, passes it and the start of work to the foreman, and reports how far workers settled (C-17b). */
export class WrapUp {
  constructor(private readonly host: WrapUpHost) {}
  /** Whether the person wrapped up and has not started work since. */
  active(): boolean { return !!this.host.store.get(KV.wrapUp.state) }
  /**
   * What the panel shows (C-17b item 4): since when, how many tickets settled — ended wrapped since then, or waiting at a
   * clean node for adjudication (C-16a) — which ones still work, and whether every one settled, which means it is safe to shut down.
   */
  status(): WrapUpView {
    const { store } = this.host
    const state = store.get(KV.wrapUp.state)
    const history = store.get(KV.wrapUp.history) ?? []
    if (!state) return { active: false, since: null, settled: 0, working: [], ready: false, history }
    const open = store.tickets.open()
    const working = open.filter(ticket => !ticket.attention)
    const wrapped = store.tickets.list().filter(ticket => ticketStop(ticket) === 'wrapped' && (ticket.ended?.at ?? '') >= state.since)
    return { active: true, since: state.since, settled: wrapped.length + open.length - working.length,
      working: working.map(ticket => ({ id: ticket.id, title: ticket.title })), ready: working.length === 0, history }
  }
  /** The person wraps up on the panel (C-38 item 7): launches are held, and the foreman hears the fixed sentence. */
  wrapUp(): WrapUpView {
    const { store, sessions } = this.host
    if (this.active()) return this.status()
    const at = new Date().toISOString()
    store.atomic(() => {
      store.set(KV.wrapUp.state, { since: at })
      this.record({ kind: 'wrap-up', at })
      sessions.foremanRelay(`wrap-up:${at}`, JSON.stringify({ kind: 'wrap_up', text: WRAP_UP_NOTICE,
        open_tickets: store.tickets.open().filter(liveTicket).map(brief),
        note: 'The person wrapped up on the panel (C-17b). Call orchestrator_ticket_wrapup for every open ticket, none left out; write where each stopped and which tasks remain into your handoff document. Report nothing.' }))
    })
    return this.status()
  }
  /** The person starts work on the panel (C-38 item 7): the hold lifts, and the foreman hears the fixed sentence. */
  startWork(): WrapUpView {
    const { store, sessions } = this.host
    const state = store.get(KV.wrapUp.state)
    if (!state) return this.status()
    const at = new Date().toISOString()
    store.atomic(() => {
      const wrapped = store.tickets.list().filter(ticket => ticketStop(ticket) === 'wrapped' && (ticket.ended?.at ?? '') >= state.since)
      store.delete(KV.wrapUp.state)
      this.record({ kind: 'start-work', at })
      sessions.foremanRelay(`start-work:${at}`, JSON.stringify({ kind: 'start_work', text: START_WORK_NOTICE, wrapped_tickets: wrapped.map(brief),
        note: 'The person started work (C-17b). Continue every unfinished task with a new ticket under its original confirmed instruction and task number (N-13a), on the wrapped tickets\' results.' }))
    })
    this.host.requestPass()
    return this.status()
  }
  private record(event: WrapUpEvent): void {
    const { store } = this.host
    store.set(KV.wrapUp.history, [event, ...store.get(KV.wrapUp.history) ?? []].slice(0, HISTORY))
  }
}
