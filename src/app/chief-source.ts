/** The chief Source's watcher: a message the person writes in the main Session they opened becomes a Trigger. */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { threadKey, type ReceiveResult, type Trigger } from '../core/index.ts'
import { policyVersion, SettingsSchema } from '../policy.ts'
import { CHIEF, chiefPrincipal, chiefTriggerId, type ChiefConfig } from '../sources/chief.ts'
import type { SourceContext } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from './store.ts'

/** How many message ids the watcher remembers; the Engine already refuses a Trigger it stored, this only saves the work. */
const SEEN = 2000

/** What the watcher reads: the Session events, the chief kind's own context, and the main slot's current Session. */
export interface ChiefSourceHost {
  readonly context: Context
  /** The chief kind's context: receiving a Trigger, describing its Thread, and reporting its health. */
  readonly source: SourceContext
  readonly sources: Pick<SourceRegistry, 'instance' | 'policyPart'>
  /** The Session the person opened in the main workspace, which the rotation keeps current. */
  master(): string
  closing(): boolean
}

/**
 * Turns what the person writes in their own main Session into Triggers of the chief Source. It records, describes the
 * Thread, and reports health; it never creates, resumes or renames a Session, since the main Session is the person's to
 * open (M22), and it reads nothing from the network.
 */
export class ChiefSource {
  /** Message ids already turned into a Trigger, oldest dropped past SEEN. */
  private readonly seen = new Set<string>()
  constructor(private readonly host: ChiefSourceHost) {}

  /** Subscribes to the main Session's messages and reports the Source ready; returns the subscription's disposer. */
  install(): () => void {
    const { context, source } = this.host
    const dispose = context.on('session/event', (session, event) => {
      if (event.type !== 'user/message' || this.host.closing() || session.id !== this.host.master()) return
      const trigger = this.trigger(session.id, event.data)
      if (!trigger) return
      try {
        const received = source.receive(trigger)
        if (typeof received === 'string') this.describe(trigger, received)
        else void Promise.resolve(received).then(result => this.describe(trigger, result)).catch(error => this.fail(error))
      } catch (error) { this.fail(error) }
    })
    source.report(CHIEF, { state: 'ready', at: new Date().toISOString(),
      detail: 'A message in the main Session becomes a Trigger; this Source opens no Session' })
    return dispose
  }

  /**
   * The Trigger of one message: only the person's own text, only while the Source is on, and only once per message. A
   * message this plugin delivered carries its own source, so it can never be taken for the person's.
   */
  private trigger(sessionId: string, message: UserMessage): Trigger | undefined {
    const instance = this.host.sources.instance<ChiefConfig>(CHIEF)
    if (!instance?.enabled || message.source?.kind !== 'user') return undefined
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    const messageId = String(message.id ?? '')
    if (!text || !messageId) return undefined
    const id = chiefTriggerId(sessionId, messageId)
    if (this.seen.has(id)) return undefined
    this.seen.add(id)
    if (this.seen.size > SEEN) this.seen.delete(this.seen.values().next().value!)
    return { id, source: CHIEF, threads: [{ source: CHIEF, id: messageId }],
      actor: { source: CHIEF, id: chiefPrincipal(instance.config, this.host.sources.policyPart(CHIEF)) },
      human: true, addressed: 'direct', at: new Date().toISOString(), text,
      channel: { source: CHIEF, thread: CHIEF + ':' + messageId, address: { sessionId, messageId } },
      meta: { sessionId, messageId } }
  }

  /** Names the Thread of the person's message, so the panel shows the conversation it came from instead of a bare id. */
  private describe(trigger: Trigger, result: ReceiveResult): void {
    if (result !== 'stored') return
    try {
      this.host.source.threads.describe(threadKey(trigger.threads[0]!), { label: '主会话',
        facts: { conversation: { label: { zh: '会话', en: 'Session' }, value: String(trigger.meta.sessionId ?? '') } } })
    } catch (error) { this.fail(error) }
  }

  private fail(error: unknown): void {
    this.host.context.logger.warn('dsh-superagent: the chief Source recorded nothing: %s', String(error))
  }
}

/**
 * Stores the chief Source's Policy part when the installation has none. The part names the person whose messages may
 * originate work, and without it the gate refuses every Trigger from this Source as not_a_member; the defaults are the
 * kind's own. A Mandate of this Source cannot predate the part, so no open ticket is affected and nothing is notified.
 * @returns whether a part was written.
 */
export function ensureChiefPolicy(store: Pick<Store, 'settings' | 'saveSettings'>, sources: Pick<SourceRegistry, 'policyPart'>): boolean {
  const settings = store.settings()
  if (settings.policy.sources[CHIEF]) return false
  const part = sources.policyPart(CHIEF)
  if (!part) return false
  const next = { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, [CHIEF]: part } } }
  const before = policyVersion(settings), after = policyVersion(next)
  store.saveSettings(SettingsSchema.parse(next), { source: 'sync', block: 'policy', policyVersion: after,
    policyChanged: before !== after, notified: [] })
  return true
}
