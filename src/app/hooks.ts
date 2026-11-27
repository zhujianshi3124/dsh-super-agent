/** Stable extension point for hot-swappable super-agent plugins.

 * A plugin declares `inject: ['superagentHooks']` and receives this service on its context.
 * The host owns every destructive action; plugins observe, report and request. Keeping that
 * boundary means a plugin can be added, replaced or removed at runtime without leaving
 * dangling session ids, effects or inbox state behind.
 */
import { Service, type Context } from '@deepseek-ai/cordis'

export type SessionRole = 'orchestrator' | 'worker' | 'foreman' | 'subagent' | 'unknown'

/** Payloads carried by the extension event bus. Plugins subscribe with `hooks.on(...)`. */
export interface ExtensionEvents {
  /** An untouched DSH session event, forwarded by Sessions.install, with the session's declared context window. */
  sessionEvent: { sessionId: string; role: SessionRole; event: unknown; contextWindow?: number; at: string }
  /** A plugin's estimate of a session's context consumption. */
  usage: { sessionId: string; role: SessionRole; used: number; limit?: number; ratio?: number; source: string; at: string }
  /** A Ticket reached a terminal state. */
  ticketEnded: { ticketId: string; outcome: string; at: string }
  /** A plugin asks the host to rotate a session. The host waits for the current task to end, then continues in a new session. */
  rotation: { sessionId: string; ticketId?: string; reason: string; summary?: string; handoffPath?: string; requestedBy: string; at: string }
  /** The host rotated a session: `successorId` now fills the slot `sessionId` held. */
  rotationDone: { sessionId: string; successorId: string; ticketId?: string; at: string }
  /** A short human-readable line from a plugin, surfaced by GET /orchestrator/api/extensions. */
  notice: { plugin: string; level: 'info' | 'warn' | 'error'; text: string; at: string }
}
export type ExtensionEventName = keyof ExtensionEvents

/** Read-only host capabilities deliberately exposed to extensions. */
export interface HooksHost {
  masterId(): string
  openTickets(): readonly { id: string; title: string }[]
  sessionIdFor(ticketId: string): string
  /** Deliver a one-off advisory into a session without waking it; the host owns delivery and dedup. */
  advise(sessionId: string, text: string, label: string): void
  /** The ticket facts a plugin needs to pre-write a handoff, or undefined when the ticket is unknown. */
  ticketInfo(ticketId: string): { title: string; assignment?: string; directory?: string } | undefined
}

export interface PluginStatus { state: 'ready' | 'paused' | 'error'; detail: string; at: string }

const MAX_HISTORY = 100
const now = (): string => new Date().toISOString()

/** The single stable extension point: an event bus plus read-only host views, shared by every hot-swappable plugin. */
export class SuperAgentHooks extends Service {
  private readonly listeners = new Map<ExtensionEventName, Set<(value: unknown) => void>>()
  private readonly rotations: ExtensionEvents['rotation'][] = []
  private readonly notices: ExtensionEvents['notice'][] = []
  private readonly pluginStatus = new Map<string, PluginStatus>()

  constructor(ctx: Context, private readonly host: HooksHost) { super(ctx, 'superagentHooks') }

  /** Subscribe to an event. The returned disposer should be registered with `ctx.effect`. */
  on<K extends ExtensionEventName>(event: K, listener: (value: ExtensionEvents[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    const wrapped = listener as (value: unknown) => void
    set.add(wrapped)
    return () => { this.listeners.get(event)?.delete(wrapped) }
  }

  /** Publish an event. One failing listener never blocks the others or the host. */
  emit<K extends ExtensionEventName>(event: K, value: ExtensionEvents[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try { listener(value) }
      catch (error) { this.ctx.logger.warn('[superagentHooks] %s listener failed: %s', event, String(error)) }
    }
  }

  /** Host-side forwarders. */
  broadcastSessionEvent(value: Omit<ExtensionEvents['sessionEvent'], 'at'>): void {
    this.emit('sessionEvent', { ...value, at: now() })
  }
  broadcastTicketEnded(value: Omit<ExtensionEvents['ticketEnded'], 'at'>): void {
    this.emit('ticketEnded', { ...value, at: now() })
  }
  broadcastRotationDone(value: Omit<ExtensionEvents['rotationDone'], 'at'>): void {
    this.emit('rotationDone', { ...value, at: now() })
  }

  /** Plugin-side calls. */
  reportUsage(value: Omit<ExtensionEvents['usage'], 'at'>): void {
    this.emit('usage', { ...value, at: now() })
  }
  requestRotation(value: Omit<ExtensionEvents['rotation'], 'at'>): void {
    const request = { ...value, at: now() }
    this.rotations.push(request)
    if (this.rotations.length > MAX_HISTORY) this.rotations.shift()
    this.emit('rotation', request)
  }
  /** Ask the host to deliver an advisory into a session; the host owns delivery and dedup. */
  advise(sessionId: string, text: string, label: string): void {
    try { this.host.advise(sessionId, text, label) }
    catch (error) { this.ctx.logger.warn('[superagentHooks] advise failed: %s', String(error)) }
  }
  say(value: Omit<ExtensionEvents['notice'], 'at'>): void {
    const notice = { ...value, at: now() }
    this.notices.push(notice)
    if (this.notices.length > MAX_HISTORY) this.notices.shift()
    this.emit('notice', notice)
  }
  setStatus(name: string, state: PluginStatus['state'], detail: string): void {
    this.pluginStatus.set(name, { state, detail, at: now() })
  }
  /** Called by the extension loader when a plugin's fiber is disposed. Use the plugin's exported name as the status key. */
  clearStatus(name: string): void {
    this.pluginStatus.delete(name)
  }

  /** Read-only host views. */
  get masterId(): string { return this.host.masterId() }
  openTickets(): readonly { id: string; title: string }[] { return this.host.openTickets() }
  sessionIdFor(ticketId: string): string { return this.host.sessionIdFor(ticketId) }
  ticketInfo(ticketId: string): { title: string; assignment?: string; directory?: string } | undefined { return this.host.ticketInfo(ticketId) }

  /** Snapshot served by the management endpoint and used to verify hot-swapping. */
  status(): Record<string, unknown> {
    return {
      listeners: Object.fromEntries([...this.listeners].map(([name, set]) => [name, set.size])),
      plugins: Object.fromEntries(this.pluginStatus),
      rotationRequests: this.rotations.slice(-20),
      notices: this.notices.slice(-50),
    }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { superagentHooks: SuperAgentHooks } }
