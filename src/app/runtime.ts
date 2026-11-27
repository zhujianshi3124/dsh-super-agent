/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, reasonText, ticketStage, ticketStop, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { CHIEF, chiefKind } from '../sources/chief.ts'
import { ChiefSource, ensureChiefPolicy } from './chief-source.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, executionRoot, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, ticketOfSession, triggerMessage } from '../executor/dsh.ts'
import { sameDirectory } from '../infra/environment.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV, type RotationAdoption } from '../kv.ts'
import { Store } from './store.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { TurnFallback } from './fallback.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { SuperAgentHooks } from './hooks.ts'
import { ExtensionLoader } from './extensions.ts'
import { Rotation } from './rotation.ts'
import { Proposals, claimedByProposal } from './proposals.ts'
import { StuckWatch } from './stuck.ts'
import { WrapUp } from './wrapup.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/** C-13b's hard threshold: a session at or past 40% of its window is replaced by a successor, so no new ticket is bound to it. */
const CONTEXT_HARD_RATIO = 0.4
/** C-12a's warn line: between 35% and 40% only a small task the foreman judged may be dispatched to a session. */
const CONTEXT_WARN_RATIO = 0.35
/**
 * The state directories whose lock a Runtime of this process holds. A second Runtime here on one of them is refused at once: waiting,
 * as a new process waits out a force-closed one's lock, would block the event loop that keeps the holder's lock fresh, until the lock
 * looked stale and was taken over and both Runtimes used one database.
 */
const lockedHere = new Set<string>()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  /** The person's wrap-up and start of work (C-17b): holds launches until work starts. */
  readonly wrapUp: WrapUp
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  /** Stable extension point exposed to hot-swappable plugins. */
  readonly hooks: SuperAgentHooks
  /** Loads, reloads and unloads extension plugins while the process keeps running. */
  readonly extensions: ExtensionLoader
  /** Host-owned session rotation for the worker and main slots. */
  readonly rotation: Rotation
  /** What happens when a managed Session's turn ends in a provider error. */
  readonly fallback: TurnFallback
  /** The person's messages in the main Session as Triggers of the built-in chief Source. */
  readonly chief: ChiefSource
  /** Numbered instructions the person confirms before tickets may be created under them. */
  readonly proposals: Proposals
  /** The main Session's own workspace (`D:/chief` unless configured), separate from the state directory. */
  readonly masterWorkspace: string
  /** The foreman's own workspace, fixed at `D:/gongtou` (N-02), and the id its first generation uses. */
  readonly foremanWorkspace: string
  readonly foremanId = 'superagent-foreman'
  /** Stuck detection (C-12b): watches working sessions on a timer, no model tokens. */
  readonly stuck: StuckWatch
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    // Within this process only another Runtime can hold the lock, and it cannot release it while this one waits: refuse at once.
    const held = realpathSync.native(machine.stateDir)
    if (lockedHere.has(held)) throw Object.assign(new Error(`Lock file is already being held by this process: ${held}`), { code: 'ELOCKED', file: held })
    const compromised = (error: Error) => { lockedHere.delete(held); this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    // A force-closed instance leaves the lock behind until `stale` expires; the sync
    // api cannot retry itself, so wait it out. Without this, reopening DSH a few
    // seconds after killing it makes the whole plugin fail to start.
    const acquire = () => {
      const deadline = Date.now() + 30_000
      for (;;) {
        try {
          return lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
        } catch (error) {
          if ((error as { code?: string })?.code !== 'ELOCKED' || Date.now() > deadline) throw error
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750)
        }
      }
    }
    const unlock = acquire()
    lockedHere.add(held)
    const release = (): void => { lockedHere.delete(held); unlock() }
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      // The instruction gate: no ticket is created without an approved instruction (C-22).
      const proposals = this.proposals = new Proposals(store)
      // The main Session works in the person's own directory, not in the plugin's state directory: its files are theirs.
      const masterWorkspace = this.masterWorkspace = machine.masterWorkspace || 'D:/chief'
      try { mkdirSync(masterWorkspace, { recursive: true }) }
      catch (error) { ctx.logger.warn('dsh-superagent: main session workspace not created: %s', String(error)) }
      const foremanWorkspace = this.foremanWorkspace = 'D:/gongtou'
      try { mkdirSync(foremanWorkspace, { recursive: true }) }
      catch (error) { ctx.logger.warn('dsh-superagent: foreman workspace not created: %s', String(error)) }
      // Extensions only ever see this narrow host view; the host keeps ownership of sessions and effects.
      this.hooks = new SuperAgentHooks(ctx, {
        masterId: () => runtime.rotation.masterSession(),
        openTickets: () => store.tickets.open().map(ticket => ({ id: ticket.id, title: ticket.title })),
        sessionIdFor: ticketId => runtime.rotation.workerSession(ticketId),
        advise: (sessionId, text, label) => {
          void runtime.sessions.prompt(sessionId, `advise:${sessionId}:${key(text)}`, text, { inject: label }).catch(() => { /* advisory is best-effort */ })
        },
        ticketInfo: ticketId => {
          const ticket = store.tickets.get(ticketId)
          return ticket ? { title: ticket.title, assignment: ticket.execution?.assignment, directory: ticket.execution?.directory } : undefined
        },
      })
      // Each extension gets the state directory as a default, so context-guard pre-writes its handoffs under it, not in the home directory.
      this.extensions = new ExtensionLoader(ctx, join(machine.stateDir, 'extensions'), { stateDir: machine.stateDir })
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      // The chief Source is built in rather than hot-loaded: the person's own main Session is its only input. A legacy
      // extension may still own the kind until it is stopped, which must not keep this plugin from starting.
      try { this.disposers.push(this.sources.register(chiefKind)) }
      catch (error) { ctx.logger.warn('dsh-superagent: the chief Source is already registered, so a legacy extension still owns it: %s', String(error)) }
      try { if (ensureChiefPolicy(store, this.sources)) ctx.logger.info('dsh-superagent: the chief Source got its default Policy part; the main Session may originate work') }
      catch (error) { ctx.logger.warn('dsh-superagent: the chief Policy part could not be stored: %s', String(error)) }
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands,
        get masterId() { return runtime.rotation.masterSession() }, context: ctx,
        workerSession: ticketId => runtime.rotation.workerSession(ticketId),
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), machine,
        get masterId() { return runtime.rotation.masterSession() },
        isMasterSession: id => runtime.rotation.isMasterSession(id),
        isForemanSession: id => runtime.rotation.isForemanSession(id),
        currentWorker: ticketId => runtime.rotation.workerSession(ticketId),
        foremanSession: () => runtime.rotation.foremanSession(),
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket)
          : mainTools(this.toolHost, agent, runtime.rotation.isForemanSession(agent.id) ? 'foreman'
            : runtime.rotation.isMasterSession(agent.id) ? 'main' : 'plain'),
        adoptMain: agent => this.adoptMain(agent) })
      this.rotation = new Rotation({ store, sessions, context: ctx, hooks: this.hooks, rootMasterId: masterId,
        masterWorkspace: this.masterWorkspace, rootForemanId: this.foremanId, foremanWorkspace: this.foremanWorkspace,
        lifetime: this.lifetime, closing: () => this.closing() })
      this.fallback = new TurnFallback({ context: ctx, store, sessions, rotation: this.rotation, hooks: this.hooks,
        closing: () => this.closing() })
      // Stuck detection (C-12b): a working session with no model action and no context growth past the threshold is stuck.
      // A stuck worker is reported to the foreman, a stuck foreman to the main Session; the main Session is the person's own.
      this.stuck = new StuckWatch({ context: ctx,
        watched: () => {
          const workers = store.tickets.open().map(ticket => ({ sessionId: runtime.rotation.workerSession(ticket.id), role: 'worker' as const, ticketId: ticket.id }))
          return [...workers, { sessionId: runtime.rotation.foremanSession(), role: 'foreman' as const }]
        },
        thresholdMinutes: () => store.settings().executor.stuckMinutes,
        exempt: sessionId => {
          const ticketId = ticketOfSession(sessionId)
          const ticket = ticketId ? store.tickets.get(ticketId) : undefined
          return !!ticket?.attention
        },
        onStuck: entry => {
          if (entry.role === 'foreman') {
            sessions.relay(`stuck:foreman:${entry.sessionId}`, JSON.stringify({ kind: 'stuck_foreman', session_id: entry.sessionId, minutes: entry.minutes,
              note: 'The foreman session is stuck: no model action and no context growth past the threshold. Replace it with orchestrator_foreman_replace (C-12b.2). Success is not reported to the person; only a failed replacement is (C-15.9).' }))
            return
          }
          // A stuck worker goes to the foreman, which stops it (C-12b.1). A previous stuck ticket of the same task is named,
          // so the foreman can judge "the same thing twice in a row" (C-15.1).
          const ticket = entry.ticketId ? store.tickets.get(entry.ticketId) : undefined
          const previous = ticket?.proposal !== undefined && ticket.task !== undefined
            ? store.tickets.list().find(other => other.id !== ticket.id && other.proposal === ticket.proposal && other.task === ticket.task && ticketStop(other) === 'stuck')
            : undefined
          sessions.foremanRelay(`stuck:${entry.ticketId}:${entry.sessionId}`, JSON.stringify({ kind: 'stuck_worker', ticket_id: entry.ticketId,
            session_id: entry.sessionId, minutes: entry.minutes, ...previous ? { previous_stuck_ticket: previous.id } : {},
            note: 'This worker is stuck: no model action and no context growth past the threshold. Stop its ticket with orchestrator_ticket_stop_stuck (C-12b.1); to continue the task, dispatch a new ticket under the same instruction (N-13a). A single stuck ticket is not reported to the person; two in a row on the same thing are (C-15.1).' }))
        },
        closing: () => this.closing() })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      const wrapUp = this.wrapUp = new WrapUp({ store, sessions, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, rotation: this.rotation, closing: () => this.closing(), paused: () => this.paused(), wrappingUp: () => wrapUp.active(), environment, sourceLink: link,
        contextUsage: id => this.contextUsage(id),
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(runtime.rotation.masterSession(), id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate),
        // The instruction a person already confirmed carries their message; its card must not ask them again after an Eval
        // re-runs. A confirmation ("确认") never drafts a proposal: it approves the draft the session's earlier message
        // produced, so the person's message that falls between a draft and its approval is that confirmation, not new work.
        // A resent copy of the words an unconfirmed instruction was drafted from is claimed too (C-09a): see claimedByProposal.
        claimed: trigger => claimedByProposal(store.proposals.list(), trigger) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        // The three roles are all required: a ticket is created only under an instruction the person confirmed (C-22, C-26b).
        proposalsRequired: () => true,
        bindWorker: (ticketId, sessionId) => { store.set(KV.rotation.worker(ticketId), { current: sessionId, generation: 0, previous: [] }) },
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction.
          // An ended ticket takes nothing, so its message comes back as a candidate instead.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // A stop the person asked for reaches the foreman too, so it does not dispatch that work again and says so (C-17a).
          if (event.type === 'ticket.ended' && event.data.by === 'human') {
            sessions.foremanRelay(`foreman:stopped:${event.data.ticketId}:${event.at}`, JSON.stringify({ kind: 'ticket_stopped',
              ticket_id: event.data.ticketId, reason: event.data.reason ?? event.data.outcome, note: 'The person stopped this ticket; it stays stopped until they allow new work. Say which ticket stopped and that no other ticket was affected.' }))
          }
          // When every ticket of an instruction has stopped, the main Session hears it once: all delivered means the one
          // sentence "全部完成" (C-19.2); anything else, the foreman continues with new tickets (N-13a) and nobody reports.
          if (event.type === 'ticket.ended') {
            const endedTicket = store.tickets.get(event.data.ticketId)
            const proposal = endedTicket?.proposal ? store.proposals.get(endedTicket.proposal) : undefined
            if (proposal?.ticketIds.length && proposal.ticketIds.every(id => !!store.tickets.get(id)?.ended)) {
              const stops = proposal.ticketIds.map(id => { const ticket = store.tickets.get(id)!; return { ticket_id: id, stop: ticketStop(ticket) } })
              // A task is done once one of its tickets delivered: a task continued after a wrap-up, a stop or a failure has earlier
              // tickets that did not deliver (N-13a, C-17b), and "全部完成" means every task, not every ticket (C-19.2).
              const tasks = new Map<string, boolean>()
              for (const id of proposal.ticketIds) {
                const ticket = store.tickets.get(id)!, task = ticket.task === undefined ? `ticket:${id}` : `task:${ticket.task}`
                tasks.set(task, (tasks.get(task) ?? false) || ticketStop(ticket) === 'delivered')
              }
              const allDelivered = [...tasks.values()].every(Boolean)
              // A wrap-up does not end the instruction (C-15, C-17b item 5): the main Session hears nothing while it is on.
              if (allDelivered || !wrapUp.active()) sessions.relay(`instruction-complete:${proposal.id}`, JSON.stringify({ kind: 'instruction_complete', proposal_id: proposal.id,
                all_delivered: allDelivered, tickets: stops,
                note: allDelivered ? 'Every task of this instruction delivered. Report one sentence to the person: 全部完成 (C-19.2). No per-ticket detail.'
                  : 'Some tickets stopped without delivering. Do not report progress or per-ticket results; the foreman continues the tasks with new tickets under the same instruction (N-13a). Only a C-15 situation is reported.' }))
            }
          }
          if (event.type === 'ticket.ended') this.hooks.broadcastTicketEnded({ ticketId: event.data.ticketId, outcome: 'ended' })
        } })
      // Evaluation passes carry the chief intake queue; explicit user messages are routed by the foreman, never auto-accepted.
      const evaluateDue = () => { engine.evaluateDue() }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.chief = new ChiefSource({ context: ctx, source: this.context({ kind: CHIEF, health: ['chief'] }), sources,
        master: () => runtime.rotation.masterSession(), closing: () => this.closing() })
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, resources, proposals,
        foremanSession: () => runtime.rotation.foremanSession(),
        masterSession: () => runtime.rotation.masterSession(),
        masterWorkspace: runtime.masterWorkspace,
        foremanWorkspace: runtime.foremanWorkspace,
        isMasterSession: id => runtime.rotation.isMasterSession(id),
        isForemanSession: id => runtime.rotation.isForemanSession(id),
        workerRefusal: (id, smallTask) => runtime.workerRefusal(id, smallTask),
        workingTicketIds: () => store.tickets.open().filter(ticket => ticketStage(ticket).stage === 'working').map(ticket => ticket.id),
        workerRunning: id => runtime.executor.workerRunning(id),
        workerRotationPending: id => runtime.rotation.workerRotationPending(id),
        wrapUp,
        replaceForeman: reason => runtime.rotation.replaceForeman(reason),
        requestPass: () => { passes.request() },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Whether the main Session the person types in is open: one of the three required roles, and without it nothing runs (C-26b). */
  private masterOpen(): boolean { return !!this.ctx.agents.get(this.rotation.masterSession() as SessionId) }
  /** Whether the foreman Session is open; the short replacement window does not count as missing (C-37.2, C-12b.2). */
  private foremanOpen(): boolean { return !!this.ctx.agents.get(this.rotation.foremanSession() as SessionId) || this.rotation.replacingForeman }
  /**
   * Hold evaluation, dispatch, and outbound delivery while setup waits, the person paused processing, or a required role is
   * missing: the main Session is the person's own window and the plugin never opens one, and the foreman is always ensured;
   * the absence of either stops the work rather than letting tickets run with nobody to plan or report (C-26b).
   */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused || !this.masterOpen() || !this.foremanOpen() }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // The person's own messages are recorded from the first turn on, also while setup is still waiting: the Source writes
    // Triggers only, and the passes that assess them wait for setup like every other Trigger.
    this.disposers.push(this.chief.install())
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    this.rotation.install()
    this.fallback.install()
    this.stuck.install()
    this.extensions.start()
    // The latest session in each role workspace is the true role holder (C-13c), including ones opened while the plugin was stopped.
    await this.adoptLatest()
    // The main Session belongs to the person (C-13c): a Session they open in the main workspace is adopted (see `adoptMain`
    // and `adoptLatest`). Only a fresh installation with no Session at all in the main workspace gets one created for it —
    // the install-time main Session C-26a provides, which is not a C-13c replacement; every later one is the person's to open.
    const master = this.rotation.masterSession()
    if (!await this.sessions.exists(master)) {
      await this.sessions.ensure(master, this.masterWorkspace, 'dsh-superagent orchestrator', 'orchestrator')
      this.ctx.logger.info('dsh-superagent: install-time main Session created in %s (C-26a)', this.masterWorkspace)
    } else await this.sessions.ensure(master, this.masterWorkspace, 'dsh-superagent orchestrator', 'orchestrator')
    // Requirement 6: the directory tickets get their own directories under exists before the first ticket needs it.
    try { mkdirSync(executionRoot(this.store.settings(), this.machine.stateDir), { recursive: true }) }
    catch (error) { this.ctx.logger.warn('dsh-superagent: the execution root could not be created: %s', String(error)) }
    // The foreman is one of the three required roles, so it is always ensured (C-26b); a missing role stops the work rather than
    // falling back to a mode where the main Session dispatches for itself.
    await this.sessions.ensure(this.rotation.foremanSession(), this.foremanWorkspace, this.rotation.foremanTitle(), 'foreman')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /**
   * Why the session the person named cannot take a new ticket, or undefined when it can (C-12, C-12a): it must be open, a
   * worker rather than the main Session, a fake main Session (N-01a) or the foreman, and not a generation a ticket already
   * rotated away from (C-05). A busy named session is NOT a refusal: the ticket is created and waits for it (C-12). A free
   * one at or past 40% cannot take work at all; between 35% and 40% only a small task the foreman judged may go there.
   */
  private workerRefusal(sessionId: string, smallTask?: boolean): string | undefined {
    if (!this.ctx.agents.get(sessionId as SessionId)) return `Session ${sessionId} is not open`
    if (this.rotation.isMasterSession(sessionId) || this.rotation.isFakeMaster(sessionId) || this.rotation.isForemanSession(sessionId)
      || this.rotation.isFakeForeman(sessionId)) return `Session ${sessionId} is not a worker session`
    // A session sitting in a role workspace cannot take worker tickets either (C-13d).
    const cwd = this.ctx.agents.get(sessionId as SessionId)?.session.header.cwd
    if (cwd && (sameDirectory(cwd, this.masterWorkspace) || sameDirectory(cwd, this.foremanWorkspace))) {
      return `Session ${sessionId} sits in a role workspace, not a worker directory (C-13d)`
    }
    // A generation its ticket rotated away from keeps its history only, and no ticket is dispatched to it again (C-05).
    const retired = this.store.tickets.list().find(ticket => (this.store.get(KV.rotation.worker(ticket.id))?.previous ?? []).includes(sessionId))
    if (retired) return `Session ${sessionId} was replaced by a newer generation of ticket ${retired.id} and takes no further work (C-05)`
    const busy = this.store.tickets.open().find(ticket => this.rotation.workerSession(ticket.id) === sessionId)
    // Busy is a wait, not a refusal: the ticket queues for the named session until it finishes (C-12).
    if (busy) return undefined
    const usage = this.contextUsage(sessionId)
    const ratio = usage ? usage.tokens / usage.window : 0
    if (ratio >= CONTEXT_HARD_RATIO) {
      return `Session ${sessionId} is at ${Math.round(ratio * 100)}% of its context window, at or past the 40% absolute line: it takes no new work (C-12a). Dispatch this ticket without naming a session.`
    }
    if (ratio >= CONTEXT_WARN_RATIO && !smallTask) {
      return `Session ${sessionId} is at ${Math.round(ratio * 100)}% of its context window, between 35% and 40%: only a small task may go there — estimated usage at most 5% and finishing below 40%. Pass small_task with your judgement, or dispatch without naming a session (C-12a).`
    }
    return undefined
  }
  /** The last real context usage a Session reported, as tokens against its model's window; undefined until both are known. */
  private contextUsage(sessionId: string): { tokens: number; window: number } | undefined {
    const session = this.ctx.agents.get(sessionId as SessionId)?.session as unknown as
      { requestContext?: () => { contextWindow?: number }; snapshotEvents?: () => unknown[] } | undefined
    if (typeof session?.snapshotEvents !== 'function') return undefined
    const window = Number(session.requestContext?.()?.contextWindow)
    if (!Number.isFinite(window) || window <= 0) return undefined
    const events = session.snapshotEvents() as { data?: { usage?: { totalTokens?: unknown } } }[]
    for (let index = events.length - 1; index >= 0; index--) {
      const tokens = Number(events[index]?.data?.usage?.totalTokens)
      if (Number.isFinite(tokens)) return { tokens, window }
    }
    return undefined
  }
  /**
   * Takes the latest Session the person opened in the main workspace as the main Session (C-13c: the latest one there is
   * always the true main Session; no claim, no designation entry, no fallback). dsh-superagent creates no orchestrator Session.
   */
  private async adoptMain(agent: Agent): Promise<void> {
    const header = agent.session.header
    if (header.parentSession !== undefined || ticketOfSession(agent.id) !== undefined) return
    if (!header.cwd || !sameDirectory(header.cwd, this.masterWorkspace)) return
    if (this.rotation.isForemanSession(agent.id) || this.rotation.isFakeForeman(agent.id) || this.rotation.masterSession() === agent.id) return
    // A fake main Session stays fake: reopening it does not revive its main-Session effect (N-01a). Only a newly created
    // session becomes the true main Session, and the latest created one always is (C-13c).
    if (this.rotation.isFakeMaster(agent.id)) return
    try { await this.rotation.designate(agent.id) }
    catch (error) { this.ctx.logger.warn('dsh-superagent: main Session not adopted: %s', String(error)) }
  }
  /**
   * The latest Session in a role workspace is the true role holder (C-13c). On startup, sessions the person opened while the
   * plugin was stopped are adopted here; while it runs, `agent/created` adoption covers new ones.
   */
  private async adoptLatest(): Promise<void> {
    // `sessionController.list()` reads every persisted Session, cold ones included. `ctx.sessions.list()` only sees Sessions
    // this process already attached, which at startup is at most the recorded main Session — so a new main Session the person
    // opened while the plugin was stopped was never adopted. The summaries carry `updatedAt` (created, or last prompt).
    let summaries: readonly { sessionId: string; updatedAt: number; parentSessionId?: string; origin?: string; cwd?: string }[] = []
    try { summaries = (await this.ctx.sessionController.list({}, this.lifetime)).items }
    catch (error) { this.ctx.logger.warn('dsh-superagent: the Session list could not be read for adoption: %s', String(error)) }
    const latestIn = (workspace: string): string | undefined => summaries
      .filter(summary => summary.cwd && sameDirectory(summary.cwd, workspace)
        && summary.parentSessionId === undefined && summary.origin === undefined
        && ticketOfSession(summary.sessionId) === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId
    const adoption: RotationAdoption = { at: new Date().toISOString() }
    const master = latestIn(this.masterWorkspace)
    if (master && master !== this.rotation.masterSession() && !this.rotation.isFakeMaster(master)) {
      const entry: { id: string; opened: boolean; adopted: boolean } = adoption.master = { id: master, opened: false, adopted: false }
      try {
        // A persisted Session is cold after a restart and owns no live Agent, which `designate` refuses: open it first.
        const opened = await this.ctx.sessionController.resolveAgent(master as SessionId)
        if ('error' in opened) { adoption.error = String(opened.error); this.ctx.logger.warn('dsh-superagent: latest main Session could not be opened: %s', String(opened.error)) }
        else { entry.opened = true; await this.rotation.designate(master); entry.adopted = true }
      } catch (error) { adoption.error = String(error); this.ctx.logger.warn('dsh-superagent: latest main Session not adopted: %s', String(error)) }
    }
    const foreman = latestIn(this.foremanWorkspace)
    if (foreman && foreman !== this.rotation.foremanSession()) {
      const entry: { id: string; opened: boolean; adopted: boolean } = adoption.foreman = { id: foreman, opened: false, adopted: false }
      try {
        // Same for the foreman: resume the persisted Session before adopting it.
        const opened = await this.ctx.sessionController.resolveAgent(foreman as SessionId)
        if ('error' in opened) { adoption.error = String(opened.error); this.ctx.logger.warn('dsh-superagent: latest foreman Session could not be opened: %s', String(opened.error)) }
        else { entry.opened = true; await this.rotation.adoptForeman(foreman); entry.adopted = true }
      } catch (error) { adoption.error = String(error); this.ctx.logger.warn('dsh-superagent: latest foreman Session not adopted: %s', String(error)) }
    }
    // Recorded in the database, not only the log: a refused adoption used to be invisible outside the console.
    this.store.set(KV.rotation.adopt, adoption)
  }
  /** The foreman is always present: one of the three required roles (C-26b), started with the plugin. */
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, ready, sourceLinks, wrapUp: this.wrapUp,
      proposals: { list: () => runtime.proposals.list(), view: id => runtime.proposals.view(id) },
      foreman: () => ({ session: runtime.rotation.foremanSession(), generation: runtime.store.get(KV.rotation.foreman)?.generation ?? 0,
        pending: !!runtime.store.get(KV.rotation.foreman)?.pending, enabled: true,
        usage: runtime.store.get(KV.rotation.foreman)?.usage?.ratio ?? null,
        rotatedAt: runtime.store.get(KV.rotation.foreman)?.rotatedAt ?? null,
        open: runtime.foremanOpen() }),
      get masterId() { return runtime.rotation.masterSession() },
      masterWorkspace: runtime.masterWorkspace,
      // A main Session the person opened and that is still open; the plugin never creates one, so its absence stops the work (C-26b).
      masterOpen: () => runtime.masterOpen(),
      workerSession: ticketId => runtime.rotation.workerSession(ticketId),
      workerSessions: ticketId => runtime.rotation.allWorkerSessions(ticketId),
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog(),
      extensions: () => ({ ...this.extensions.status(), hooks: this.hooks.status() }) }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    await this.extensions.stop()
    try {
      this.assessor.stop()
      const ids = [this.rotation.masterSession(), ...this.store.tickets.list().flatMap(ticket => this.rotation.allWorkerSessions(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.stuck.dispose()
      this.rotation.dispose()
      this.fallback.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
