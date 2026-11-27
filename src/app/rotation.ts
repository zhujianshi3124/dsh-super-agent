/** Host-owned session rotation: the mechanism behind C-05, C-09c, C-13b and C-13c.
 *
 * A plugin observes real context usage and files a rotation request through `hooks.requestRotation`.
 * The host — never the plugin — decides when and how to actually swap the session, so session ids,
 * inbox dedup and shutdown enumeration stay consistent. Two slots rotate:
 *   - a ticket's worker session, rotated when the executor next launches or delivers to it (the
 *     current turn has ended by then, so the running task is never interrupted);
 *   - the foreman session, rotated when its turn ends and nothing is queued for it: a worker's report
 *     may wake it, so waiting for the next dispatch would postpone the swap indefinitely.
 * The main Session is never rotated by the plugin (C-13c): the person opens a new one in D:\chief,
 * and the latest session there is always the true main Session.
 * Each successor reads a pre-written handoff file and the ticket assignment, then continues without
 * redoing completed work. The logical slot keeps its identity; only the underlying DSH session changes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KV, type RotationRequest, type RotationState } from '../kv.ts'
import { liveTicket, type Ticket } from '../core/index.ts'
import { workerSessionId, ticketOfSession } from '../executor/dsh.ts'
import { sameDirectory } from '../infra/environment.ts'
import type { Store } from './store.ts'
import type { Sessions } from './sessions.ts'
import type { SuperAgentHooks } from './hooks.ts'

/** Cap on the assignment text carried inline in a worker handoff message. */
const ASSIGNMENT_CHARS = 1500

/** Host dependencies used by `Rotation`. */
export interface RotationHost {
  readonly store: Pick<Store, 'get' | 'set' | 'tickets'>
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'rename' | 'notify' | 'inherit' | 'redecorate'>
  readonly context: Context
  readonly hooks: SuperAgentHooks
  /** The original main Session id, before any rotation. */
  readonly rootMasterId: string
  /** Workspace the main Session runs in (the person's own directory, `D:/chief` by default). */
  readonly masterWorkspace: string
  /** The original foreman Session id, before any rotation, and the workspace only it uses. */
  readonly rootForemanId: string
  readonly foremanWorkspace: string
  readonly lifetime: AbortSignal
  closing(): boolean
}

/**
 * Executes session rotation for the worker and foreman slots, and adopts the main Session the person opens. Reads and writes
 * the current session of each slot in `Store` (`KV.rotation`), creates successors through `Sessions.ensure`, delivers a handoff
 * message, and carries any pending inbox across so nothing is lost or duplicated. Plugins only request; this class acts.
 * The main Session is never rotated by the plugin (C-13c): the person opens a new one in `D:/chief`, and the latest one there
 * is always the true main Session.
 */
export class Rotation {
  private readonly disposers: (() => void)[] = []
  private rotatingForeman = false
  /** True while a foreman replacement runs: no new ticket is dispatched in that window (C-12b.2, C-37.2). */
  private replacingForemanFlag = false
  constructor(private readonly host: RotationHost) {}
  /** Whether a foreman replacement is in progress: the short window that does not count as a missing foreman (C-37.2). */
  get replacingForeman(): boolean { return this.replacingForemanFlag }

  /** The DSH session currently filling a ticket's worker slot. */
  workerSession(ticketId: string): string {
    return this.host.store.get(KV.rotation.worker(ticketId))?.current ?? workerSessionId(ticketId)
  }
  /**
   * Whether a ticket's worker has a rotation request waiting: it reached the hard line, and the host fulfils it when that
   * worker's turn ends (C-13b) or, should an Input or a launch come first, before that lands.
   */
  workerRotationPending(ticketId: string): boolean { return !!this.host.store.get(KV.rotation.worker(ticketId))?.pending }
  /** The DSH session currently filling the main slot. */
  masterSession(): string {
    return this.host.store.get(KV.rotation.master)?.current ?? this.host.rootMasterId
  }
  /** Whether `id` is the current main Session. An earlier one is a fake main Session (N-01a), with no main-Session effect. */
  isMasterSession(id: string): boolean {
    return id === this.masterSession()
  }
  /** Whether `id` once was the main Session and now only keeps its history: it drafts no instruction, relays nothing, reports nothing (N-01a). */
  isFakeMaster(id: string): boolean {
    if (this.isMasterSession(id)) return false
    const state = this.host.store.get(KV.rotation.master)
    return id === this.host.rootMasterId || !!state?.previous.includes(id)
  }
  /** The DSH session currently filling the foreman slot. */
  foremanSession(): string {
    return this.host.store.get(KV.rotation.foreman)?.current ?? this.host.rootForemanId
  }
  /** Whether `id` is the current foreman. */
  isForemanSession(id: string): boolean {
    return id === this.foremanSession()
  }
  /**
   * Whether `id` once was the foreman and now only keeps its history: it plans nothing, dispatches nothing, collects nothing
   * and accepts no rotation request, and holds no ticket-related tool (N-02a).
   */
  isFakeForeman(id: string): boolean {
    if (this.isForemanSession(id)) return false
    const state = this.host.store.get(KV.rotation.foreman)
    return id === this.host.rootForemanId || !!state?.previous.includes(id)
  }
  /** The title of the current foreman generation, which the person sees in the session list. */
  foremanTitle(): string {
    const generation = this.host.store.get(KV.rotation.foreman)?.generation ?? 0
    return generation ? `superagent 工头（后台，不用管）· 第 ${generation + 1} 代` : 'superagent 工头（后台，不用管）'
  }
  /** Every worker session a ticket has used, current first, for shutdown enumeration. */
  allWorkerSessions(ticketId: string): string[] {
    const state = this.host.store.get(KV.rotation.worker(ticketId))
    return state ? [state.current, ...state.previous] : [workerSessionId(ticketId)]
  }

  /** Subscribes to rotation requests. Call once at startup. The main Session is not rotated by the plugin (C-13c). */
  install(): void {
    const hooks = this.host.hooks
    this.disposers.push(hooks.on('rotation', (request) => {
      // A worker request names its ticket (derive it from the session id, stripping any rotation suffix);
      // a foreman request names the current session of that slot.
      const ticketId = ticketOfSession(request.sessionId) ?? request.ticketId
      if (ticketId !== undefined && this.host.store.tickets.get(ticketId)) {
        this.requestWorker(ticketId, request)
        return
      }
      if (this.isForemanSession(request.sessionId)) { this.requestForeman(request); return }
      // A main-session request is noted and dropped: the main Session does not follow the 35/40 scheme (C-13b, C-13c).
      hooks.say({ plugin: 'rotation', level: 'info', text: `rotation request for ${request.sessionId} noted; the main Session is replaced only by the person opening a new one (C-13c)` })
    }))
    // A plugin's usage reading for the foreman and main slots is kept, so the panel can show how full each is (C-37.5, C-37.6).
    this.disposers.push(hooks.on('usage', ({ sessionId, ratio, at }) => {
      if (ratio === undefined) return
      const slot = this.isForemanSession(sessionId) ? KV.rotation.foreman : this.isMasterSession(sessionId) ? KV.rotation.master : undefined
      if (!slot) return
      const state = this.host.store.get(slot)
      // Before the first rotation the slot may hold no record yet; the usage reading creates it so the panel shows it at once.
      this.host.store.set(slot, { ...(state ?? { current: sessionId, generation: 0, previous: [] }), usage: { ratio, at } })
    }))
    // A ticket that ends no longer needs its pending worker rotation.
    this.disposers.push(hooks.on('ticketEnded', ({ ticketId }) => {
      const key = KV.rotation.worker(ticketId), state = this.host.store.get(key)
      if (state?.pending) this.host.store.set(key, { ...state, pending: undefined })
    }))
    // A foreman rotation is fulfilled when the foreman's turn ends and nothing waits for it: it may be woken by a worker's
    // report, so waiting for the next dispatch would postpone it indefinitely.
    // `global`: DSH dispatches `agent/status` through the agent's own scope carrier, so a listener owned by the plugin's
    // scope does not receive it even for the foreman this plugin created.
    this.disposers.push(this.host.context.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.host.closing() || !this.isForemanSession(agent.id)) return
      const state = this.host.store.get(KV.rotation.foreman)
      if (!state?.pending) return
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return
      void this.rotateForeman()
    }, { global: true }))
  }

  /**
   * Records a pending rotation for a ticket's worker; the executor fulfils it once the worker's current turn ends, with no
   * message from anyone, or at the next launch or delivery if one comes first (C-13b).
   */
  private requestWorker(ticketId: string, request: RotationRequest): void {
    const key = KV.rotation.worker(ticketId)
    const state = this.host.store.get(key) ?? { current: workerSessionId(ticketId), generation: 0, previous: [] }
    if (state.pending) return
    this.host.store.set(key, { ...state, pending: request })
    this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `worker rotation pending for ticket ${ticketId}; continues after the current task ends` })
  }

  /** Records a pending foreman rotation; the turn-end watcher performs it once the foreman is idle and nothing is queued. */
  private requestForeman(request: RotationRequest): void {
    const key = KV.rotation.foreman
    const state = this.host.store.get(key) ?? { current: this.host.rootForemanId, generation: 0, previous: [] }
    if (state.pending) return
    this.host.store.set(key, { ...state, pending: request })
    this.host.hooks.say({ plugin: 'rotation', level: 'info', text: 'foreman rotation pending; happens when its turn ends with nothing queued' })
  }

  /** Writes the handoff a foreman successor reads: which generation it follows, the tickets still in flight, and how to continue. */
  private foremanHandoff(state: RotationState, generation: number): string {
    const open = this.host.store.tickets.open().map(ticket => {
      const report = ticket.assignments.at(-1)?.report
      return `- ${ticket.id}「${ticket.title}」：${report?.state ?? '未开始'}${report?.summary ? ` — ${report.summary.slice(0, 200)}` : ''}`
    })
    const path = join(this.host.foremanWorkspace, 'handoffs', `foreman-${generation}.md`)
    const body = [`# 工头第 ${generation + 1} 代接手（上一代 ${state.current}）`,
      '', `- 换代原因：${state.pending?.reason ?? '上下文到阈值'}`, `- 手上的工单：${open.length ? '' : '没有'}`]
      .concat(open, ['', '每张工单的处置记录在工单备注里；先读它们再决定下一步，不要重复已完成的处置、也不要重复问用户同一个问题。', ''].join('\n'))
      .join('\n')
    try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body, 'utf8') }
    catch (error) { this.host.hooks.say({ plugin: 'rotation', level: 'warn', text: `foreman handoff file not written: ${String(error)}` }) }
    return path
  }

  /** Creates the foreman successor, delivers its handoff, carries the inbox, and switches the slot. */
  private async rotateForeman(): Promise<void> {
    if (this.rotatingForeman) return
    this.rotatingForeman = true
    this.replacingForemanFlag = true
    const key = KV.rotation.foreman
    const state = this.host.store.get(key)
    try {
      if (!state?.pending) return
      const current = state.current
      const generation = state.generation + 1
      const successorId = `${this.host.rootForemanId}-r${generation}`
      const path = this.foremanHandoff(state, generation)
      const previous = this.host.context.agents.get(current as SessionId)
      this.host.store.set(key, { current: successorId, generation, previous: [...state.previous, current],
        rotatedAt: new Date().toISOString() })
      try {
        await this.host.sessions.ensure(successorId, this.host.foremanWorkspace, this.foremanTitle(), 'foreman', current)
        await this.host.sessions.prompt(successorId, `rotation:foreman:${generation}`, JSON.stringify({ rotation: {
          successor: successorId, previous: current, reason: state.pending.reason, handoff_file: path,
          note: 'You are the successor of the foreman session. Read the handoff file first, then the ticket notes it names. Continue the '
            + 'tickets in flight; do not repeat completed decisions or ask the person again what was already answered. The earlier session keeps its full transcript.' } }), 'queue')
        const successor = this.host.context.agents.get(successorId as SessionId)
        if (previous && successor) this.carryInbox(current, successor)
        await this.retire(current, `superagent 工头（已换下 · 假工头 · 第 ${generation} 代 · 历史保留）`)
        if (previous) await this.host.sessions.redecorate(previous)
        this.host.hooks.broadcastRotationDone({ sessionId: current, successorId })
        this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `foreman rotated to ${successorId}` })
      } catch (error) {
        this.host.store.set(key, state)
        throw error
      }
    } catch (error) {
      this.host.hooks.say({ plugin: 'rotation', level: 'warn', text: `foreman rotation failed, will retry: ${String(error)}` })
    } finally {
      this.rotatingForeman = false
      this.replacingForemanFlag = false
    }
  }
  /**
   * Replaces a stuck foreman at the main Session's request (C-12b.2): stops the old foreman's turn, opens a successor that
   * inherits its model, reasoning effort and permissions (C-09c), and demotes the old one to a fake foreman keeping its
   * history (N-02a). No new ticket is dispatched while this runs. Success is not reported to the person; a failure throws,
   * and the main Session reports the missing foreman (C-15.9).
   */
  async replaceForeman(reason: string): Promise<{ successor: string }> {
    if (this.rotatingForeman) throw new Error('A foreman replacement is already running')
    this.rotatingForeman = true
    this.replacingForemanFlag = true
    const key = KV.rotation.foreman
    const state = this.host.store.get(key) ?? { current: this.host.rootForemanId, generation: 0, previous: [] }
    const current = state.current
    const generation = state.generation + 1
    const successorId = `${this.host.rootForemanId}-r${generation}`
    try {
      // Stop the old foreman first: it is stuck, and nothing it is still doing should continue (C-12b.2).
      const previous = this.host.context.agents.get(current as SessionId)
      previous?.cancel({ kind: 'user' }, { keepInbox: true })
      const path = this.foremanHandoff({ ...state, pending: { reason, requestedBy: 'main-session', at: new Date().toISOString() } }, generation)
      this.host.store.set(key, { current: successorId, generation, previous: [...state.previous, current],
        rotatedAt: new Date().toISOString() })
      try {
        await this.host.sessions.ensure(successorId, this.host.foremanWorkspace, this.foremanTitle(), 'foreman', current)
        await this.host.sessions.prompt(successorId, `rotation:foreman:${generation}`, JSON.stringify({ rotation: {
          successor: successorId, previous: current, reason, handoff_file: path,
          note: 'You are the successor of a foreman session that stopped responding. Read the handoff file first, then the ticket notes it names. '
            + 'Continue the tickets in flight; do not repeat completed decisions or ask the person again what was already answered. The earlier session keeps its full transcript.' } }), 'queue')
        const successor = this.host.context.agents.get(successorId as SessionId)
        if (!successor) throw new Error(`The successor foreman session ${successorId} was not created`)
        if (previous) this.carryInbox(current, successor)
        await this.retire(current, `superagent 工头（已换下 · 假工头 · 第 ${generation} 代 · 历史保留）`)
        if (previous) await this.host.sessions.redecorate(previous)
        this.host.hooks.broadcastRotationDone({ sessionId: current, successorId })
        this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `foreman replaced: ${current} -> ${successorId} (${reason})` })
        return { successor: successorId }
      } catch (error) {
        this.host.store.set(key, state)
        throw error
      }
    } finally {
      this.rotatingForeman = false
      this.replacingForemanFlag = false
    }
  }

  /**
   * Fulfils a pending worker rotation if one is waiting: creates the successor session, delivers the handoff,
   * carries any pending inbox, and switches the slot. Returns the session id the executor should now use.
   * Called by the executor before it launches or delivers, when the previous turn has ended.
   */
  async takeWorkerRotation(ticket: Ticket): Promise<string> {
    const key = KV.rotation.worker(ticket.id)
    const state = this.host.store.get(key)
    const current = state?.current ?? workerSessionId(ticket.id)
    if (!state?.pending || !liveTicket(ticket)) return current
    const generation = state.generation + 1
    const successorId = `${workerSessionId(ticket.id)}-r${generation}`
    const workspace = ticket.execution?.directory ?? ''
    const next = { current: successorId, generation, previous: [...state.previous, current], rotatedAt: new Date().toISOString() }
    // The slot switches before the successor exists, so the successor is decorated as this ticket's worker while the earlier
    // generation no longer is (C-05). A failed creation puts the earlier generation back.
    this.host.store.set(key, next)
    try {
      // The successor inherits the earlier generation's model, reasoning effort and permissions (C-09c).
      await this.host.sessions.ensure(successorId, workspace, ticket.title, 'worker', current, ticket.execution?.workspace)
      const handoff = this.workerHandoff(ticket, state, successorId)
      await this.host.sessions.prompt(successorId, `rotation:${ticket.id}:${generation}`, handoff, 'queue')
      this.carryInbox(current, successorAgent(this.host.context, successorId))
      // The earlier generation keeps its transcript and takes no further work (C-05).
      await this.retire(current, `工单 ${ticket.id}（已换代 · 历史保留 · 不再接活）`)
      const previous = this.host.context.agents.get(current as SessionId)
      if (previous) await this.host.sessions.redecorate(previous)
      this.host.hooks.broadcastRotationDone({ sessionId: current, successorId, ticketId: ticket.id })
      this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `worker for ticket ${ticket.id} rotated to ${successorId}` })
      return successorId
    } catch (error) {
      this.host.store.set(key, state)
      throw error
    }
  }

  /** The handoff message a worker successor reads first: the handoff file, the assignment, and how to continue. */
  private workerHandoff(ticket: Ticket, state: RotationState, successorId: string): string {
    const assignment = ticket.execution?.assignment ?? ''
    const brief = assignment.length > ASSIGNMENT_CHARS ? `${assignment.slice(0, ASSIGNMENT_CHARS)}…` : assignment
    return JSON.stringify({
      rotation: {
        ticket_id: ticket.id, successor: successorId, previous: state.current,
        reason: state.pending?.reason ?? 'context threshold reached',
        ...(state.pending?.handoffPath ? { handoff_file: state.pending.handoffPath } : {}),
        ...(brief ? { assignment: brief } : {}),
        note: 'You are the successor of a worker session that reached its context threshold. Read the handoff file if given, '
          + 'then inspect the worktree, git history and PR state to see what is already done. Continue the assignment from where it '
          + 'stopped; do not repeat completed work. The earlier session keeps its full transcript.',
      },
    })
  }

  /** Renames the session a rotation replaced, so the person sees it kept under its generation rather than mistaken for the live one. */
  private async retire(id: string, title: string): Promise<void> {
    try { await this.host.sessions.rename(id, title) }
    catch (error) { this.host.hooks.say({ plugin: 'rotation', level: 'warn', text: `retired session not renamed: ${String(error)}` }) }
  }

  /** Moves any messages still waiting in the old session's inbox into the successor, so none is lost. */
  private carryInbox(fromId: string, to: Agent): void {
    const from = this.host.context.agents.get(fromId as SessionId)
    if (!from) return
    const pending: UserMessage[] = [...from.inbox.nextTurn, ...from.inbox.nextStep]
    for (const message of pending) {
      from.inbox.remove(message.id)
      to.followup(message)
    }
  }

  /**
   * Makes the latest Session the person opened in the main workspace the main Session (C-13c: the latest one there is always
   * the true main Session; no claim, no designation entry, no fallback). The earlier main Session becomes a fake main Session
   * that keeps its history; the new one inherits the earlier one's model, reasoning effort and permissions once.
   * @throws Error when the session is not open, or is the foreman or a worker.
   */
  async designate(sessionId: string): Promise<void> {
    const key = KV.rotation.master
    const state = this.host.store.get(key)
    const current = state?.current ?? this.host.rootMasterId
    if (sessionId === current) return
    if (!this.host.context.agents.get(sessionId as SessionId)) throw new Error(`Session ${sessionId} is not open`)
    // The main Session is fixed in its workspace (N-01, C-13d): a session elsewhere cannot become it.
    const cwd = this.host.context.agents.get(sessionId as SessionId)?.session.header.cwd
    if (!cwd || !sameDirectory(cwd, this.host.masterWorkspace)) throw new Error(`Session ${sessionId} is not in the main workspace ${this.host.masterWorkspace}`)
    if (this.isForemanSession(sessionId) || this.isFakeForeman(sessionId)) {
      throw new Error(`Session ${sessionId} is the foreman, not a main Session`)
    }
    if (ticketOfSession(sessionId) !== undefined) throw new Error(`Session ${sessionId} is a worker session, not a main Session`)
    // C-13c: the plugin writes the earlier main Session's settings onto the new one once, even over its default selection.
    await this.host.sessions.inherit(sessionId, current, true)
    await this.retire(current, 'dsh-superagent orchestrator（已换下 · 假主会话 · 历史保留）')
    const previous = this.host.context.agents.get(current as SessionId)
    if (previous) await this.host.sessions.redecorate(previous)
    this.host.store.set(key, { current: sessionId, generation: (state?.generation ?? 0) + 1,
      previous: [...(state?.previous ?? []), current].filter(id => id !== sessionId), rotatedAt: new Date().toISOString() })
    this.host.hooks.broadcastRotationDone({ sessionId: current, successorId: sessionId })
    this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `main session adopted: ${sessionId}` })
  }
  /**
   * Adopts the latest Session in the foreman workspace as the true foreman (C-13c: the latest one there is always the true
   * foreman). The earlier foreman becomes a fake foreman keeping its history; the adopted one inherits its settings.
   */
  async adoptForeman(sessionId: string): Promise<void> {
    const key = KV.rotation.foreman
    const state = this.host.store.get(key)
    const current = state?.current ?? this.host.rootForemanId
    if (sessionId === current) return
    if (!this.host.context.agents.get(sessionId as SessionId)) throw new Error(`Session ${sessionId} is not open`)
    // The foreman is fixed in its workspace (N-02, C-13d): a session elsewhere cannot become it.
    const cwd = this.host.context.agents.get(sessionId as SessionId)?.session.header.cwd
    if (!cwd || !sameDirectory(cwd, this.host.foremanWorkspace)) throw new Error(`Session ${sessionId} is not in the foreman workspace ${this.host.foremanWorkspace}`)
    const previous = this.host.context.agents.get(current as SessionId)
    await this.host.sessions.ensure(sessionId, this.host.foremanWorkspace, this.foremanTitle(), 'foreman', current)
    await this.retire(current, 'superagent 工头（已换下 · 假工头 · 历史保留）')
    if (previous) await this.host.sessions.redecorate(previous)
    this.host.store.set(key, { current: sessionId, generation: (state?.generation ?? 0) + 1,
      previous: [...(state?.previous ?? []), current].filter(id => id !== sessionId), rotatedAt: new Date().toISOString() })
    this.host.hooks.broadcastRotationDone({ sessionId: current, successorId: sessionId })
    this.host.hooks.say({ plugin: 'rotation', level: 'info', text: `foreman adopted: ${sessionId}` })
  }
  /** Unsubscribes. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}

/** The agent of a freshly created successor, which `carryInbox` delivers pending messages into. */
function successorAgent(context: Context, id: string): Agent {
  const agent = context.agents.get(id as SessionId)
  if (!agent) throw new Error(`The successor session ${id} was not created`)
  return agent
}
