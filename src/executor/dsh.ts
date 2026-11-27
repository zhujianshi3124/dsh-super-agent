/** DSH executor: manages one persistent worker session and workspace directory per ticket. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { key, latestAssignment, latestReport, liveTicket, runningAssignment, threadKey, awaitingAdjudication, ticketStop } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Execution, Executor, Mandate, PolicyEffect, Ticket, TicketInput, Trigger }
  from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import { Later, type Effects } from '../app/effects.ts'
import { executionRoot, type Variable } from '../app/execution-environment.ts'
import type { Sessions } from '../app/sessions.ts'
import type { Rotation } from '../app/rotation.ts'
import { WorktreeNameSchema } from '../app/assessment.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import { cancelled, collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.ts'

const now = (): string => new Date().toISOString()
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket's first generation. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
/** Returns the ticket ID for a worker session ID, including rotated generations (`worker-<ticketId>-r<N>`). */
export const ticketOfSession = (sessionId: string): string | undefined =>
  sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length).replace(/-r\d+$/, '') : undefined
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 10 * 60_000
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 10_000
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5000
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
class PrepareFailed extends Error {}
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  return PASSING.test(text)
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`
/** Host dependencies used by `DshExecutor`. */
export interface ExecutorHost {
  /** DSH Cordis context: agents and their events, and the subprocess service used to run prepare commands. */
  readonly context: Context
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted' | 'endWrapped'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session and the foreman. */
  readonly sessions: Pick<Sessions, 'ensure' | 'prompt' | 'promptedId' | 'foremanRelay' | 'holds'>
  /** Host-owned rotation: resolves a ticket's current worker session and fulfils pending rotations. */
  readonly rotation: Pick<Rotation, 'workerSession' | 'takeWorkerRotation' | 'allWorkerSessions' | 'workerRotationPending'>
  /** The last real context usage a session reported, as tokens against its model's window (C-12a); undefined until known. */
  contextUsage(sessionId: string): { tokens: number; window: number } | undefined
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Whether the person wrapped up (C-17b), which holds launches but not deliveries: the wrap-up sentence must reach its worker. */
  wrappingUp(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
}
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger | undefined =>
  host.store.triggers.get(ticket.origin.triggerId)

/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop at a clean node and report blocked with the concrete question, or failed; do not expand scope.' : ''
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, settings: Settings,
  stateDir: string): Execution {
  const name = ticketWorktreeName(outcome.name ?? '', ticket.id)
  const rawNote = String(outcome.note ?? '')
  // The directory the person named wins (N-10): the accept carries it explicitly from the instruction task; the legacy
  // `[workspace:...]` routing note is still honoured for records written by earlier versions.
  const workspaceMatch = rawNote.match(/\[workspace:([^\]]+)\]/i)
  const requested = (outcome.workspace ?? workspaceMatch?.[1] ?? '').trim()
  const safeRequested = /^(\/|[A-Za-z]:[\\/])/.test(requested) ? requested : ''
  const cleanNote = rawNote.replace(/\[workspace:[^\]]+\]/gi, '').trim()
  const note = cleanNote ? `\nRouting note (not the source request): ${cleanNote}` : ''
  const ruleIds = ticket.mandate.basis.rules
  const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
    .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('')
  const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : ''
  // The confirmed instruction's completion criteria, carried into the worker's own text: a report says what it did, this says what was asked.
  const acceptance = (outcome.acceptance ?? ticket.criteria ?? []).map(item => item.trim()).filter(Boolean)
  const criteria = acceptance.length
    ? `\nCompletion criteria from the confirmed instruction, evidence for each required in the report, in this order:${acceptance.map((item, index) => `\n${index + 1}. ${item}`).join('')}`
    : ''
  // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
  const assignment = (ticket.mandate.strength === 'inferred' && ruleIds
    ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
    : note.trim()) + criteria
  // An explicitly named workspace wins, and the worker works in it as it is; otherwise the ticket works in the default root
  // itself (N-10: `D:/buzhiding`, no forced per-ticket subdirectory). Several tickets may share it; file conflicts are the
  // foreman's to prevent and resolve (C-13, C-13d).
  return { name, directory: safeRequested || executionRoot(settings, stateDir), assignment,
    ...(safeRequested ? { workspace: safeRequested } : {}) }
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: { source_url?: string; source_url_read?: string }, note?: string, repliesTo?: Trigger) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...link, ...(note ? { routing_note: note } : {}),
    ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: { store: Pick<Store, 'triggers'> }, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
  .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? [])
const RESUMED = 'A message reached this ticket after an earlier stop. A stopped ticket is never reopened (C-11): if the message asks for '
  + 'more within the original task, it belongs to a new ticket under the same instruction (N-13a) — hand it back with orchestrator_trigger_handback '
  + 'so the foreman dispatches that new ticket; do not continue work on this ended ticket.'
/** Formats a settings-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Settings change: check that the remaining work stays within the assignment.'
  return ['Settings change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report blocked with the concrete question.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted: finish only '
      + 'what is in progress within the assignment, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
      + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n')
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
  // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
  if (input.kind === 'trigger') return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
    ...input.context ? { context: true } : {} })
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
  /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
  private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>()
  /**
   * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
   * @param max - Returns the configured maximum number of concurrent worker slots.
   */
  constructor(private readonly running: () => string[], private readonly max: () => number) {}
  /** Number of slots currently in use across running workers and starting reservations. */
  used(): number { return new Set([...this.running(), ...this.starting.keys()]).size }
  /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
  launches(): number {
    const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : [])
    return this.max() - new Set([...this.running(), ...wakes]).size
  }
  /**
   * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
   * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
   * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
   * @throws Later when no slot is free.
   */
  reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
    if (this.starting.has(ticketId)) return
    if (this.used() >= this.max() + (by === 'person' ? 1 : 0)) throw new Later('No worker slot is free')
    this.starting.set(ticketId, by)
  }
  /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
  free(ticketId: string): void { this.starting.delete(ticketId) }
}

/**
 * Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
 * `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class DshExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming = new Set<string>()
  /**
   * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
  private readonly stopping = new Map<string, Promise<void>>()
  /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
  private readonly left = new Map<string, { jobs: Set<string>; collect: AbortController }>()
  /** When a person's message typed into a worker's Session last started a turn, by ticket. */
  private readonly personal = new Map<string, string>()
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: ExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() || host.wrappingUp() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    // A stop of the worker's background work ends with a cancel, which would drop what is delivered meanwhile.
    await this.stopped(ticketId)
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    // A pending rotation is fulfilled here, after the previous turn ended and before new input lands.
    await this.host.rotation.takeWorkerRotation(first)
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        const sessionId = this.host.rotation.workerSession(ticketId)
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          // Recreate the worker session if it was externally deleted. `ensure` lands it in the shared worker workspace, not
          // in the ticket's directory, which the worker reads as `DSH_SUPERAGENT_DIR`.
          if (!this.host.context.agents.get(sessionId as SessionId)) {
            await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? '', ticket.title, 'worker', undefined,
              ticket.execution?.workspace)
          }
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
      // A stop of the worker's background work that started meanwhile ends with a cancel, which would drop the Input.
      if (this.stopping.has(ticket.id)) throw new Later('The worker\'s background work is stopping')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(this.host.rotation.workerSession(ticket.id), input.id, text, 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
   * report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = this.host.rotation.workerSession(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      if (!ownTurn) this.host.context.agents.get(sessionId as SessionId)?.cancel({ kind: 'user' }, { keepInbox: false })
      // Its shell jobs and subagents stop with it, also those of a worker that ends its own turn.
      this.stopWork(ticket.id, reason)
      this.left.get(ticket.id)?.collect.abort(); this.left.delete(ticket.id); this.personal.delete(ticket.id)
    })
  }
  /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
  private stopWork(ticketId: string, reason: string, keepInbox = false): void {
    this.track(ticketId, stopBackground(this.host.context, this.host.rotation.workerSession(ticketId), reason, keepInbox))
  }
  /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
  private track(ticketId: string, stop: Promise<void>): void {
    const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {})
      .finally(() => { if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId) })
    this.stopping.set(ticketId, entry)
    void this.background(stop)
  }
  /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
  private async stopped(ticketId: string): Promise<void> {
    const stopping = this.stopping.get(ticketId)
    if (stopping) await until(stopping, this.host.lifetime)
  }
  /**
   * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
   * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
   */
  async shutdown(): Promise<void> {
    const agents = this.host.store.tickets.list().flatMap(ticket => this.host.rotation.allWorkerSessions(ticket.id)
      .map(id => this.host.context.agents.get(id as SessionId)))
      .filter((agent): agent is Agent => agent !== undefined)
    const stop = async () => {
      await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)))
      for (const { collect } of this.left.values()) collect.abort()
      const running = agents.filter(agent => agent.status !== 'idle')
      for (const agent of running) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled(running.map(agent => agent.whenIdle()))
    }
    await until(stop(), undefined, SHUTDOWN_STOP_MS)
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  workerRunning(ticketId: string): boolean { const ticket = this.host.store.tickets.get(ticketId); return !!ticket && this.running(ticket) }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket)) return false
    return this.host.context.agents.get(this.host.rotation.workerSession(ticket.id) as SessionId)?.status === 'running' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket ends with that stop reason (N-13), and continuing takes a new ticket (N-13a). */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    // A transient failure out of tries is the session stopping work (N-13b); anything else is a failure of the work itself.
    this.failed(ticketId, String(error), transient(error) ? 'session-stopped' : 'failed')
  }
  /** Records a `failed` report on the ticket, which ends it, and relays the failure to the foreman in one transaction. */
  private failed(ticketId: string, summary: string, stopReason: 'session-stopped' | 'failed' = 'failed'): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary, stopReason })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  /** Relays a report to the foreman, which collects a stopped worker's question and passes the result on (C-16a); a worker never reports above it. */
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.foremanRelay(id, text) }
  /**
   * The named-session wait (C-12, C-12a): while the named session finishes another ticket, this launch waits with no total
   * time limit. Once it is free, its actual usage decides: below 35% it takes the ticket; at or past 40% a fresh session
   * takes it under the same ticket number; between the two the foreman judges the small-task exception, asked once.
   */
  private async namedWait(ticket: Ticket): Promise<void> {
    if (!ticket.waitingFor) return
    const sessionId = this.host.rotation.workerSession(ticket.id)
    const busy = this.host.store.tickets.open().find(other => other.id !== ticket.id
      && this.host.rotation.workerSession(other.id) === sessionId)
    if (busy) throw new Later(`The named session ${sessionId} still holds ticket ${busy.id}; waiting for it to finish (C-12)`)
    // The named session was stopped as stuck, or stopped working, while this ticket waited: a fresh session takes it under
    // the same ticket number (C-12: the queued ticket is unaffected and re-dispatched; C-12b, N-13b).
    const unusable = this.host.store.tickets.list().find(other => other.id !== ticket.id
      && this.host.rotation.workerSession(other.id) === sessionId
      && (ticketStop(other) === 'stuck' || ticketStop(other) === 'session-stopped'))
    if (unusable) {
      this.host.store.set(KV.rotation.worker(ticket.id), { current: workerSessionId(ticket.id), generation: 0, previous: [] })
      this.recordDispatch(ticket, `The named session ${sessionId} was stopped (${ticketStop(unusable)} on ticket ${unusable.id}): a new session takes this ticket (C-12, C-12b)`)
      return
    }
    const usage = this.host.contextUsage(sessionId)
    const ratio = usage ? usage.tokens / usage.window : 0
    if (ratio >= 0.4) {
      // The absolute line: a fresh worker session takes this ticket, its number unchanged (C-12a.3, C-12).
      this.host.store.set(KV.rotation.worker(ticket.id), { current: workerSessionId(ticket.id), generation: 0, previous: [] })
      this.recordDispatch(ticket, `The named session ${sessionId} is at ${Math.round(ratio * 100)}% (at or past 40%): a new session takes this ticket (C-12a)`)
      return
    }
    if (ratio >= 0.35) {
      // The small-task exception the foreman judged: estimated usage at most 5%, finishing below 40% (C-12a.2).
      if (ticket.smallTask && ratio + 0.05 < 0.4) { this.clearWaiting(ticket); return }
      this.host.sessions.foremanRelay(`named-wait:${ticket.id}`, JSON.stringify({ kind: 'named_wait_decision', ticket_id: ticket.id,
        session: sessionId, usage_percent: Math.round(ratio * 100),
        note: 'The named session is free but between 35% and 40%. Decide with orchestrator_ticket_dispatch: small_task (your estimate at most 5%, finishing below 40%), new_session, or refuse with a reason. The ticket waits meanwhile (C-12, C-12a).' }))
      throw new Later('The named session is between 35% and 40%; the foreman decides (C-12a)')
    }
    this.clearWaiting(ticket)
  }
  /** The named session takes the ticket: the wait is over. */
  private clearWaiting(ticket: Ticket): void {
    const stored = this.host.store.tickets.get(ticket.id)
    if (!stored?.waitingFor) return
    const { waitingFor: _waiting, ...rest } = stored
    this.host.store.tickets.save(rest)
  }
  /** A dispatch decision made in code under C-12/C-12a is recorded in the ticket like any other dispatch decision (C-30). */
  private recordDispatch(ticket: Ticket, text: string): void {
    const stored = this.host.store.tickets.get(ticket.id)
    if (!stored) return
    const { waitingFor: _waiting, ...rest } = stored
    this.host.store.tickets.save({ ...rest, decisions: [...rest.decisions ?? [], { at: now(), text }] })
  }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('dsh-superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
    if (this.host.wrappingUp()) throw new Later('The person wrapped up; launches wait until work starts (C-17b)')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // A ticket whose person named a worker session waits for that session (C-12): while it finishes another ticket, then by
    // its actual usage (C-12a). The wait has no total time limit; a stuck session is stopped by the foreman (C-12b).
    await this.namedWait(ticket)
    if (!current()) return
    // Prepare the workspace directory once; an existing directory counts as already prepared, including worktrees created before `prepare` commands existed.
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    // Fulfil a pending rotation before launching, so a new assignment starts in a fresh session when asked.
    await this.host.rotation.takeWorkerRotation(ticket)
    if (!current()) return
    const sessionId = this.host.rotation.workerSession(ticket.id)
    // The Session lands in the shared worker workspace; `workspace` stays the ticket's own directory, which the worker
    // prompt names as `DSH_SUPERAGENT_DIR` and which nothing else changes.
    const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker', undefined, ticket.execution?.workspace)
    if (!current()) return
    // The background work of the Assignment this one replaces stops first, so its end does not clear this one's message.
    await this.stopped(ticket.id)
    if (!current()) return
    // A message put back for this Assignment may still wait in the Session, kept by a restart's cancel or persisted across a
    // crash, where this launch's message would take it into a step beside the copy delivered next: that copy is the only one.
    for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && await this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(workspace ? { directory: workspace } : {}),
        ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}) })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id, sessionId) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id, sessionId)
  }
  /** Returns the stored ticket for `agent` when it currently holds one as its worker session, or undefined otherwise. */
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    if (ticketId === undefined) return undefined
    // A generation the ticket rotated away from holds nothing: its events are history, not work (C-05).
    if (this.host.rotation.workerSession(ticketId) !== agent.id) return undefined
    return this.host.store.tickets.get(ticketId)
  }
  /** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup.
   * Every `agent/*` subscription is `global`: DSH dispatches those events through the agent's own scope carrier, so a listener
   * in the plugin's scope would not hear the sessions it creates through the workspace registry. */
  install(): void {
    const ctx = this.host.context
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      // A turn that starts ends the look at its worker's background work; the turn's own idle looks afresh.
      if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
      // The turn a stop of the worker's subagents woke and cancelled is no turn of the worker's.
      if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
    }, { global: true }))
    // A person's message typed into a worker's Session goes to the foreman, which judges whether it clarifies the ticket or
    // asks for something new (C-24); the worker does not decide that itself.
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const ticketId = ticketOfSession(agent.id)
      if (ticketId === undefined || message.source.kind !== 'user') return
      this.personal.set(ticketId, now())
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket)) return
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      if (text) this.host.sessions.foremanRelay(`direct-input:${ticketId}:${key(text, now())}`,
        JSON.stringify({ kind: 'user_direct_input', ticket_id: ticketId, text,
          note: 'The person typed directly into the worker session. Judge against the ticket goal and completion criteria: a clarification goes to the worker with orchestrator_ticket_resume or an attached input; a new requirement needs a new instruction and ticket (C-24). The worker does not decide this itself.' }))
    }, { global: true }))
    // The Inputs a message of dsh-superagent's carries, which its worker reads once the Session took the message into its
    // history: a step that claimed it may be cancelled or fail before, which drops it.
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const ticketId = ticketOfSession(session.id)
      if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
      const message = event.data
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === message.id).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
    }, { global: true }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const ticket = this.ticketOf(agent)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      // Out of transient tries: the session stopped working (N-13b). A non-transient error: the work failed.
      const stopReason = transient(error) ? 'session-stopped' : 'failed'
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error), stopReason) }))
    }, { global: true }))
  }
  /** Unsubscribes from host agent events and clears any pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        // A restart within this process left DSH's Sessions, jobs and subagents running: they stop first. The inbox keeps an
        // Input that was handed over but not yet taken.
        this.host.context.agents.get(this.host.rotation.workerSession(ticket.id) as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
        this.stopWork(ticket.id, 'dsh-superagent restarted', true)
        this.host.engine.assignmentInterrupted(ticket.id, running.id)
      }
      else if (latest?.state === 'pending' && !awaitingAdjudication(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      void this.background((async () => {
        await this.host.rotation.takeWorkerRotation(ticket)
        const sessionId = this.host.rotation.workerSession(ticketId)
        const waking = !this.running(ticket)
        try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
          if (!(failure instanceof Later)) throw failure
          this.after(SLOT_WAIT_MS, go); return
        }
        const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
        await sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
      })().catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /**
   * Continues a ticket whose worker stopped at its context threshold in its successor, at once and with no message from anyone
   * (C-13b): a wake slot is reserved, and the pending rotation creates the successor and delivers its handoff, which starts
   * its turn. It waits while processing is paused or no slot is free. A rotation that keeps failing ends the ticket — the
   * session stopped working on a passing failure (N-13b), else failed — and the foreman continues the task with a new ticket (N-13a).
   */
  private continueRotated(ticketId: string, assignmentId: string): void {
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
      // An Input or a launch may have fulfilled the rotation meanwhile: then its successor already works.
      if (!this.host.rotation.workerRotationPending(ticketId)) return
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      void this.background((async () => {
        try { this.slots.reserve(ticketId, 'wake') } catch (failure) {
          if (!(failure instanceof Later)) throw failure
          this.after(SLOT_WAIT_MS, go); return
        }
        try { await this.host.rotation.takeWorkerRotation(ticket) }
        finally { this.slots.free(ticketId) }
        this.transient.delete(`rotate:${assignmentId}`)
      })().catch((failure: unknown) => {
        if (this.host.closing()) return
        if (this.retries(`rotate:${assignmentId}`, failure)) { this.after(TRANSIENT_BACKOFF_MS, go); return }
        this.failed(ticketId, `The worker reached its context threshold and could not continue in a new session: ${String(failure)}`,
          transient(failure) ? 'session-stopped' : 'failed')
      }))
    }
    go()
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /**
   * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
   * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
   * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
   */
  private handOff(ticketId: string, agent: Agent): void {
    this.track(ticketId, stopSubagents(this.host.context, agent, true))
    const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() }
    this.left.set(ticketId, left)
    for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
      left.jobs.add(job.id)
      void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async ended => {
        if (!ended) return
        const note = `Your background job ${ended.name} ended: ${ended.status}.`
        await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' })
      }))
    }
  }
  private async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
    await agent.whenIdle()
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id) || agent.status !== 'idle') return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that went idle runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result or a question for a person handed off; the question keeps it at its clean node
    // awaiting adjudication (C-16a); an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return (report?.state === 'ready' || !!stored.attention) && !since
    }
    const before = live()
    if (!before || this.host.closing()) return
    // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
    const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id)
    // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
    if (handedOff(before) && !(report && person && person > report.at)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      this.handOff(ticket.id, agent)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile. There is no time limit on
    // that work (C-23): it runs until it is quiet, the worker runs again, the Assignment ends, or the host stops.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController()
    this.settling.set(ticket.id, look)
    let quiet: boolean
    const left = this.left.get(ticket.id)?.jobs
    try { quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal]), left) }
    finally { if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || !quiet || !current || this.resuming.has(idle.id)) return
    this.host.engine.turnEnded(ticket.id, idle.id)
    // The worker may have reported while its turn ended; a question it asked keeps it at its clean node (C-16a).
    if (handedOff(current)) return
    // At the person's wrap-up a worker whose turn ended quietly settled at a clean node: its ticket ends wrapped, at its context
    // threshold too, with no successor opened (C-17b item 3, C-13b), and the foreman hears of it.
    if (this.host.wrappingUp()) {
      this.host.store.atomic(() => {
        const ended = this.host.engine.endWrapped(ticket.id, 'system', 'Settled at the person\'s wrap-up (C-17b)')
        this.relay(resultRelay(ended, 'wrapped', '收工：回合已结束，停在干净节点，工单按收工停止（C-17b）。'))
      })
      return
    }
    // A worker that stopped at its context threshold goes on in its successor at once, with no message from anyone and nothing
    // told to the foreman (C-13b): the rotation is fulfilled now, not at the ticket's next delivery.
    if (this.host.rotation.workerRotationPending(ticket.id)) { this.continueRotated(ticket.id, idle.id); return }
    const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : ''
    const said = text
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report: it stopped halfway (C-13e). Decide with '
          + 'orchestrator_ticket_continue — continue, or spinning when it keeps stopping with no progress; orchestrator_ticket_request_status only asks for a status report.'))
      }
    })
  }
}
