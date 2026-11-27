/**
 * The chief Source end to end: a message the person writes in their own main Session becomes a Trigger, the foreman opens
 * the ticket under the instruction the person confirmed, its worker Session works, and the report comes back to the
 * main Session. Nothing here creates the main Session: the test opens it, as the person does.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_WORKER_ROOT, executionRoot } from '../src/app/execution-environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { ChiefConfigSchema, chiefTriggerId } from '../src/sources/chief.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

/** What the main Session's proposal tool answers. */
interface Drafted { proposal: { id: string; status: string; origin: { source: string; thread: string; messageId: string } } }
/** What one routing call of the foreman answers; a refused item carries the reason instead of a ticket. */
interface Routed { results: { refused?: string; ticket?: { ticket_id: string } }[] }

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

describe('the chief Source', () => {
  it('keeps the configuration the extension version stored, so an installation that ran it still takes messages', () => {
    expect(ChiefConfigSchema.safeParse({ chiefSessionId: 'chief-main', chiefWorkspace: 'D:/agents/chief-workspace',
      principal: 'alice', minChars: 4, listen: true }).success).toBe(true)
    expect(ChiefConfigSchema.parse({})).toEqual({ principal: '' })
  })


  it('runs a ticket under the configured execution root, or the person\'s own D:/buzhiding, never in an archived extension workspace', () => {
    const archived = { enabled: true, config: { chiefWorkspace: 'D:/agents/chief-workspace' } }
    expect(executionRoot(SettingsSchema.parse({ executor: { directory: 'C:/work' }, sources: { chief: archived } }), 'C:/state')).toBe('C:/work')
    // Unset means the person's own directory, not an internal state folder.
    expect(executionRoot(SettingsSchema.parse({ sources: { chief: archived } }), 'C:/state')).toBe(DEFAULT_WORKER_ROOT)
    // A state directory under the OS temp directory (every test run) keeps its tickets inside itself instead.
    expect(executionRoot(SettingsSchema.parse({ sources: { chief: archived } }), join(tmpdir(), 'sa-state'))).toBe(join(tmpdir(), 'sa-state', 'work'))
    // `<stateDir>/work` is what earlier versions wrote by themselves, so it still counts as unset.
    expect(executionRoot(SettingsSchema.parse({ executor: { directory: 'C:/state/work' } }), 'C:/state')).toBe(DEFAULT_WORKER_ROOT)
    expect(DEFAULT_WORKER_ROOT).toBe('D:/buzhiding')
  })

  it('copies the main Session the person has open, not the archived Chief session an extension left named', async () => {
    host = await startRuntime(store => store.saveSettings({ executor: { model: { provider: 'configured', model: 'configured' } } }))
    const { runtime, ctx } = host
    const master = runtime.masterId
    // The extension version's configuration still names a fixed Chief session, whose model was rate limited all evening.
    const settings = runtime.store.settings()
    runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, chief: { enabled: true, config: { chiefSessionId: 'chief-main' } } } })
    await (host.controller.create as unknown as (options: unknown) => Promise<void>)({ sessionId: 'chief-main', workspaceId: 'D:/archived' })
    ;(host.agents.get('chief-main') as unknown as { session: { requestHeader(): unknown } }).session.requestHeader = () => ({ config: { provider: 'archived', model: 'archived' } })
    // The person's message in the main Session is the Trigger the ticket is created from.
    const message = createUserMessage({ content: [{ type: 'text', text: '把首页改快' }], source: { kind: 'user' } })
    ctx.emit('session/event', (host.agents.get(master) as unknown as { session: unknown }).session as never,
      { type: 'user/message', data: message } as never)
    const accepted = await host.route({ kind: 'accept', trigger_id: chiefTriggerId(master, String(message.id)),
      title: '首页改快', worktree_name: 'faster-home', acknowledgement: '收到，我来弄。' })
    await runtime.idle()
    const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
    // N-10: the ticket works in the execution root itself, no forced per-ticket subdirectory; several tickets may share it.
    const execution = runtime.store.tickets.get(ticketId)!.execution!
    expect(execution.directory).toBe(join(host.directory, 'tickets'))
    const worker = `worker-${ticketId}`
    const appended = (host.agents.get(worker) as unknown as { session: { append: { mock: { calls: unknown[][] } } } }).session.append.mock.calls
    expect(appended.find(([type]) => type === 'model/selection')?.[1]).toMatchObject({ provider: 'configured', model: 'configured' })
  })

  it('turns the person\'s own message into the trigger the foreman decides, and relays the worker\'s report back', async () => {
    host = await startRuntime()
    const { runtime, controller, deliveries, ctx } = host
    const master = runtime.masterId
    // The plugin stored the chief Source's Policy part at startup, so the person who owns this Session may originate work.
    expect(runtime.store.settings().policy.sources.chief?.allowed.map(entry => entry.id)).toEqual(['chief-owner'])
    // The fake Session keeps no transcript of its own, and the main Session's tools read the person's latest words from it.
    const history: { type: string; data: UserMessage }[] = []
    const agent = host.agents.get(master) as unknown as { session: { snapshotEvents(): unknown[] } }
    const session = agent.session as never
    agent.session.snapshotEvents = () => history
    // A message the person typed is not a delivery: DSH announces it as a Session event, which is what the Source watches.
    const say = (text: string): UserMessage => {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      history.push({ type: 'user/message', data: message })
      ctx.emit('session/event', session, { type: 'user/message', data: message } as never)
      return message
    }

    const request = say('把登录页的错字都改掉')
    const triggerId = chiefTriggerId(master, String(request.id))
    expect(runtime.store.triggers.get(triggerId)).toMatchObject({ source: 'chief', human: true, addressed: 'direct',
      actor: { source: 'chief', id: 'chief-owner' }, text: '把登录页的错字都改掉', meta: { sessionId: master, messageId: String(request.id) } })
    // A message this plugin delivered carries its own source, so it never becomes a second Trigger of the same turn.
    const relayed = createUserMessage({ content: [{ type: 'text', text: '工单已建好' }], source: { kind: 'dsh-superagent', form: 'relay' } })
    ctx.emit('session/event', session, { type: 'user/message', data: relayed } as never)
    expect(runtime.store.triggers.get(chiefTriggerId(master, String(relayed.id)))).toBeUndefined()

    const draft = await host.runTool(master, 'orchestrator_proposal', { tasks: [
      { title: '改错字', request: '登录页的错字全改掉', accept: '页面上没有错字' }] }) as unknown as Drafted
    expect(draft.proposal).toMatchObject({ status: 'draft', origin: { source: 'chief', thread: master, messageId: String(request.id) } })
    say('确认')
    await host.runTool(master, 'orchestrator_proposal_approve', { proposal_id: draft.proposal.id })
    expect(await host.runTool(master, 'orchestrator_handoff', { proposal_id: draft.proposal.id }))
      .toMatchObject({ handed: true, proposal_id: draft.proposal.id })

    // The foreman reads the instruction with the Trigger it has to decide, and decides it under that instruction.
    const foreman = runtime.rotation.foremanSession()
    const handed = deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === foreman).at(-1)!
    expect(handed.text).toContain(`trigger_id: ${triggerId}`)
    const routed = await host.runTool(foreman, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: triggerId,
      proposal: draft.proposal.id, task: 1, title: '改登录页错字', worktree_name: 'login-typos', acknowledgement: '收到，我安排改错字。',
      acceptance: ['页面上没有错字', '其它文件未改动'] }] }) as unknown as Routed
    expect(routed.results[0]!.refused).toBeUndefined()
    const ticketId = routed.results[0]!.ticket!.ticket_id
    // The ticket exists under the instruction, and the Decision that created it names the instruction.
    const decision = runtime.store.decisions.get(runtime.store.triggers.disposition(triggerId)!.decisionId!)!
    expect(decision).toMatchObject({ kind: 'accept', ticketId, audit: { proposal: draft.proposal.id } })
    expect(runtime.store.tickets.get(ticketId)).toMatchObject({ origin: { triggerId } })
    // The confirmed criteria reach the worker's own assignment, so its report answers each one instead of restating the work.
    const execution = runtime.store.tickets.get(ticketId)!.execution!
    expect(execution.assignment).toContain('Completion criteria from the confirmed instruction')
    expect(execution.assignment).toContain('1. 页面上没有错字')
    expect(execution.assignment).toContain('2. 其它文件未改动')
    expect(runtime.store.proposals.get(draft.proposal.id)).toMatchObject({ status: 'dispatched', ticketIds: [ticketId] })

    // Its worker Session is created and works; its ready report reaches the main Session.
    await runtime.idle()
    const worker = `worker-${ticketId}`
    expect(controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: worker }))
    await host.runTool(worker, 'orchestrator_report', { state: 'ready', summary: '错字都改完了' })
    await vi.waitFor(() => expect(host!.relays(host!.runtime.rotation.foremanSession()).some(item => item.kind === 'worker_report' && item.state === 'ready')).toBe(true))
  })

  it('keeps the main Session drafting: its card says so, and its tools hold no routing the foreman does', async () => {
    host = await startRuntime()
    const { runtime, ctx } = host
    const master = runtime.masterId
    const agent = host.agents.get(master) as unknown as { session: { snapshotEvents(): unknown[] } }
    const session = agent.session as never
    const history: { type: string; data: UserMessage }[] = []
    agent.session.snapshotEvents = () => history
    const message = createUserMessage({ content: [{ type: 'text', text: '把登录页的错字都改掉' }], source: { kind: 'user' } })
    history.push({ type: 'user/message', data: message })
    ctx.emit('session/event', session, { type: 'user/message', data: message } as never)

    // The card the main Session reads names the instruction it drafts, never the routing the foreman does.
    await vi.waitFor(() => expect(host!.relays(master).some(item => item.kind === 'candidate')).toBe(true))
    const card = host.relays(master).find(item => item.kind === 'candidate')!
    expect(String(card.next_action)).toContain('orchestrator_proposal')
    expect(String(card.next_action)).not.toContain('Route it with orchestrator_route')

    // The split is in the tool table itself, not in a prompt: drafting and stopping are the main Session's, routing is the foreman's.
    const mainTools = [...(host.tools.get(master)?.keys() ?? [])]
    expect(mainTools).toContain('orchestrator_proposal')
    expect(mainTools).toContain('orchestrator_proposal_approve')
    expect(mainTools).toContain('orchestrator_ticket_stop')
    expect(mainTools).not.toContain('orchestrator_route')
    const foremanTools = [...(host.tools.get(runtime.rotation.foremanSession())?.keys() ?? [])]
    expect(foremanTools).toContain('orchestrator_route')
    expect(foremanTools).not.toContain('orchestrator_proposal_approve')
  })

  it('revises a draft instruction in place when the person refines it, instead of drafting a second number', async () => {
    host = await startRuntime()
    const { runtime, ctx } = host
    const master = runtime.masterId
    const agent = host.agents.get(master) as unknown as { session: { snapshotEvents(): unknown[] } }
    const session = agent.session as never
    const history: { type: string; data: UserMessage }[] = []
    agent.session.snapshotEvents = () => history
    const say = (text: string) => {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      history.push({ type: 'user/message', data: message })
      ctx.emit('session/event', session, { type: 'user/message', data: message } as never)
      return message
    }
    say('把登录页的错字都改掉')
    const first = await host.runTool(master, 'orchestrator_proposal', { tasks: [
      { title: '改错字', request: '登录页的错字全改掉', accept: '页面上没有错字' }] }) as unknown as Drafted
    // The person adds one thing while the instruction is still a draft: the same number is revised, never a second one.
    say('标点也一起统一了')
    const revised = await host.runTool(master, 'orchestrator_proposal', { proposal_id: first.proposal.id, tasks: [
      { title: '改错字和标点', request: '登录页的错字和标点全改掉', accept: '页面上没有错字和标点问题' }] }) as unknown as Drafted
    expect(revised.proposal.id).toBe(first.proposal.id)
    expect(runtime.store.proposals.list().map(proposal => proposal.id)).toEqual([first.proposal.id])
    const stored = runtime.store.proposals.get(first.proposal.id)!
    expect(stored.status).toBe('draft')
    expect(stored.tasks[0]!.request).toContain('标点')
    expect(stored.heard).toBe('标点也一起统一了')
  })
})
