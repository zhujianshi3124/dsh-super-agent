/** A managed Session's turn that ended in an error: the person is told, and an approved instruction that reached no ticket is handed over once more. */
import type { Context } from '@deepseek-ai/cordis'
import type { SuperAgentHooks } from './hooks.ts'
import { instructionText } from './proposals.ts'
import type { Rotation } from './rotation.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** Retries per instruction after its first handover. A second failure is the person's to decide about, not the host's to repeat. */
const REDELIVERIES = 1
/** Longest provider message carried into the notice, so one error body cannot flood the main Session's turn. */
const DETAIL = 200

export interface FallbackHost {
  readonly context: Pick<Context, 'on'>
  readonly store: Pick<Store, 'proposals'>
  readonly sessions: Pick<Sessions, 'prompt' | 'relay'>
  readonly rotation: Pick<Rotation, 'isForemanSession' | 'foremanSession'>
  readonly hooks: Pick<SuperAgentHooks, 'say'>
  closing(): boolean
}

/**
 * DSH retries a model call itself and then ends the turn with the provider's error. Nothing else used to happen: an
 * instruction the person had already confirmed sat `approved` (handed over, no ticket) forever and the person was told
 * nothing. This closes that hole for the foreman slot, the only slot a confirmed instruction waits in: it tells the main
 * Session what happened through the durable effect queue, and hands the instruction to the foreman one more time.
 *
 * A worker's failed turn is the Executor's business (`DshExecutor` resumes transient failures and fails the assignment
 * otherwise), and the main Session's own failed turn is visible in the window the person is typing in.
 */
export class TurnFallback {
  private readonly disposers: (() => void)[] = []
  private readonly sent = new Map<string, number>()
  constructor(private readonly host: FallbackHost) {}

  install(): void {
    // `global`: agent events travel through a DSH scope carrier, so a plugin-scoped listener never hears another plugin's
    // Session fail — which is exactly the foreman Session this fallback exists for.
    this.disposers.push(this.host.context.on('agent/error', ({ agent, error }) => {
      // The provider's own words read better than an Error's prefix, and the notice is truncated anyway.
      this.turnFailed(agent.id, error instanceof Error ? error.message : String(error))
    }, { global: true }))
  }

  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose() }

  /** The notification the person reads in the main Session, one line, naming the instruction and what happens now. */
  private notice(proposalId: string, detail: string, redelivered: number): string {
    return redelivered > 0
      ? `工头这一轮被「${detail}」打断，指令 ${proposalId} 还没派发工单；已自动重投第 ${redelivered} 次，你不用重复确认。`
      : `工头连续被「${detail}」打断，指令 ${proposalId} 仍未派发工单。请看一眼线路（或换个模型）后在主会话重新下达。`
  }

  private turnFailed(sessionId: string, detail: string): void {
    const { closing, hooks, rotation, sessions, store } = this.host
    if (closing() || !rotation.isForemanSession(sessionId)) return
    const reason = detail.slice(0, DETAIL)
    const foreman = rotation.foremanSession()
    // Only an approved instruction that was handed over and never reached a ticket is stranded; a dispatched one has its ticket.
    const stranded = store.proposals.list().filter(proposal => proposal.status === 'approved'
      && proposal.handoffAt !== undefined && proposal.dispatchedAt === undefined)
    if (!stranded.length) {
      hooks.say({ plugin: 'fallback', level: 'warn', text: `the foreman's turn ended in an error: ${reason}` })
      return
    }
    for (const proposal of stranded) {
      const sent = this.sent.get(proposal.id) ?? 0
      const retry = sent < REDELIVERIES
      if (retry) {
        this.sent.set(proposal.id, sent + 1)
        void sessions.prompt(foreman, `handoff:${proposal.id}:retry:${sent + 1}`, instructionText(proposal), 'queue')
          .catch(error => hooks.say({ plugin: 'fallback', level: 'warn', text: `instruction ${proposal.id} not redelivered: ${String(error)}` }))
      }
      sessions.relay(`fallback:${proposal.id}:${sent + 1}`, this.notice(proposal.id, reason, retry ? sent + 1 : 0))
      hooks.say({ plugin: 'fallback', level: 'warn',
        text: `foreman turn failed (${reason}); instruction ${proposal.id} ${retry ? `redelivered (#${sent + 1})` : 'not delivered and reported'}` })
    }
  }
}
