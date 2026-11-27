/**
 * Stuck detection (C-12b): a working session whose model has had no action and whose context has not grown for the whole
 * threshold (default 60 minutes, adjustable) is stuck. The check runs on a timer, consumes no model tokens, and only notifies
 * the superior once per episode: a stuck worker goes to the foreman, a stuck foreman goes to the main Session. The main
 * Session itself is the person's to manage (C-12b.3) and is not watched.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A session the watch covers: a ticket's current worker, or the foreman. */
export interface WatchedSession { sessionId: string; role: 'worker' | 'foreman'; ticketId?: string }
export interface StuckHost {
  readonly context: Context
  /** The sessions to watch right now: current workers of open tickets and the foreman. */
  watched(): WatchedSession[]
  /** The threshold in minutes from the execution settings (C-12b.5, default 60). */
  thresholdMinutes(): number
  /** Whether the session waits at a clean node for adjudication: idle, not stuck (C-16a). */
  exempt(sessionId: string): boolean
  /** One stuck episode, reported once: the host relays it to the superior role. */
  onStuck(entry: WatchedSession & { minutes: number }): void
  closing(): boolean
}
/** How often the watch looks: every 5 minutes, no model request (C-12b.6). */
const CHECK_INTERVAL_MS = 5 * 60_000
/** A session first seen running gets this grace before it can be judged stuck. */
const GRACE_MS = 5 * 60_000
/** Event types that count as model action: the model said something, or a request went out. */
const MODEL_EVENTS = new Set(['assistant/message', 'request/header', 'assistant/tool-call'])

/**
 * Watches working sessions for the C-12b stuck condition: no model action and no context growth for the whole threshold.
 * Reports each episode once to the superior role; the main Session is never watched (C-12b.3).
 */
export class StuckWatch {
  /** When a model action last happened, by session. */
  private readonly lastAction = new Map<string, number>()
  /** When the context last grew, by session. */
  private readonly lastGrow = new Map<string, number>()
  private readonly lastTokens = new Map<string, number>()
  /** When the watch first saw the session running, for the grace period. */
  private readonly firstSeen = new Map<string, number>()
  /** Sessions already reported for the current stuck episode, so the superior is told once. */
  private readonly reported = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private readonly disposers: (() => void)[] = []
  constructor(private readonly host: StuckHost) {}
  /** Subscribes to session events and starts the timer. Call once at startup. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const now = Date.now()
      if (MODEL_EVENTS.has(event.type)) { this.lastAction.set(session.id, now); this.reported.delete(session.id) }
      const tokens = (event as { data?: { usage?: { totalTokens?: unknown } } }).data?.usage?.totalTokens
      if (typeof tokens === 'number' && Number.isFinite(tokens)) {
        const previous = this.lastTokens.get(session.id)
        if (previous === undefined || tokens > previous) { this.lastGrow.set(session.id, now); this.reported.delete(session.id) }
        this.lastTokens.set(session.id, tokens)
      }
    }))
    // `global`: `agent/status` is scope-carrier dispatched, so the plugin's own scope would not see Sessions it did not create.
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A new turn is a new episode; a session that goes idle is not working and is not judged (C-12b.4).
      if (status === 'running') { this.lastAction.set(agent.id, Date.now()); this.reported.delete(agent.id) }
      else { this.firstSeen.delete(agent.id); this.reported.delete(agent.id) }
    }, { global: true }))
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }
  /** One look: only sessions still spinning are judged, and only when both signs stayed flat past the threshold. */
  private check(): void {
    if (this.host.closing()) return
    const now = Date.now()
    const threshold = this.host.thresholdMinutes() * 60_000
    for (const entry of this.host.watched()) {
      const agent = this.host.context.agents.get(entry.sessionId as SessionId)
      if (!agent || agent.status !== 'running') continue
      if (this.host.exempt(entry.sessionId)) continue
      const first = this.firstSeen.get(entry.sessionId) ?? now
      this.firstSeen.set(entry.sessionId, first)
      if (now - first < GRACE_MS) continue
      const action = this.lastAction.get(entry.sessionId) ?? first
      const grow = this.lastGrow.get(entry.sessionId) ?? first
      if (now - action < threshold || now - grow < threshold) continue
      if (this.reported.has(entry.sessionId)) continue
      this.reported.add(entry.sessionId)
      this.host.onStuck({ ...entry, minutes: Math.round(Math.min(now - action, now - grow) / 60_000) })
    }
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}