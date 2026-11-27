/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` (C-38 is exhaustive) and records
 * any undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, promptParts } from '../../src/app/prompts.ts'
import type { PromptsView, ProposalPageView, StateView, TicketPageView } from '../../src/app/http.ts'
import type { HistoryView } from '../../src/app/settings-history.ts'
import type { SetupView } from '../../src/client/api.ts'
import type { OverviewView } from '../../src/app/views/overview.ts'
import type { SearchView } from '../../src/app/views/threads.ts'
import type { TicketRow } from '../../src/client/api.ts'
import type { TicketStage } from '../../src/core/stage.ts'
import { ExecutorConfigSchema, SettingsSchema } from '../../src/policy.ts'
import { SetupError, type SetupCode } from '../../src/setup.ts'
import type { Health } from '../../src/sources/host.ts'

export const MEMBER = 'ou_alice'
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
type Actor = SearchView['items'][number]['actor']
/** Resolve an actor display label using the fixture policy's allowed list, falling back to the raw id. */
export function actor(source: string, id: string, _human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const name = entry ? entry.name || entry.id : id
  return { source, id, name: { zh: name, en: name } }
}
type TicketFields = Omit<TicketRow, 'stage'>
const TICKET = {
  id: 't1', title: '修复回归', state: 'open', actions: { stop: true }, strength: 'explicit', ended: undefined, stop: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
type SearchItem = SearchView['items'][number]
/** A search hit: the person's own message with where it went, as `GET search` returns it. */
export function found(id: string, at: string, { threadTitle, filtered, disposition, ...fields }: Partial<Omit<SearchItem, 'disposition'>>
  & { disposition?: Partial<SearchItem['disposition']> } = {}): SearchItem {
  return { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, preview: `message ${id}`, url: undefined,
    threads: ['feishu:oc_1:om_root'], actions: { requeue: false },
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition },
    threadTitle, ...filtered === undefined ? {} : { filtered, threadTitle: undefined }, ...fields }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000 }

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  settings: Settings; revisions: Record<string, number>
  prompts: PromptsView
  /** Every ticket row; the list route filters it by state (C-37d). */
  tickets: TicketRow[]
  ticketDetails: Record<string, TicketPageView>
  /** Tickets awaiting the person's adjudication, which the overview leads with (C-37.1). */
  person: TicketRow[]
  search: SearchView
  history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  misuse: string[]
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  down: boolean
  /** Count of responses not yet consumed by the client. */
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  /** When true, the overview reports no main Session, naming the workspace to open one in (C-26b). */
  masterMissing?: boolean
  /** When true, the overview reports no foreman Session (C-37.2). */
  foremanMissing?: boolean
  /** The main Session block of the overview: which one, its generation, its context usage (C-37.5). */
  master: OverviewView['master']
  /** Numbered instructions the person confirmed, and the foreman carrying them out. */
  proposals: StateView['proposals']
  /** Full instruction records the detail route returns, keyed by id. */
  proposalPages: Record<string, ProposalPageView>
  foreman: StateView['foreman']
  /** Executor load the state and overview report. */
  load: { running: number; queued: number }
  /** The person's wrap-up as the state reports it (C-17b). */
  wrapUp: StateView['wrapUp']
}
export let server: PanelServer

const stateView = (): StateView => ({
  setup: server.setup, load: { ...server.load, maxWorkers: server.settings.executor.maxWorkers },
  masterId: 'master', paused: server.settings.paused, wrapUp: server.wrapUp,
  // The panel reads health on the Deployment page only.
  health: server.health,
  proposals: server.proposals, foreman: server.foreman,
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  blocks: { executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  environment: { root: 'D:/buzhiding', variables: [
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
  history: { current: server.revisions.settings ?? 0 },
})
const overviewView = (): OverviewView => ({
  problems: [
    ...server.masterMissing ? [{ kind: 'no-master' as const, workspace: '/w/chief' }] : [],
    ...server.foremanMissing ? [{ kind: 'no-foreman' as const, workspace: 'D:/gongtou' }] : [],
  ],
  master: server.master,
  person: server.person,
  executor: { ...server.load, maxWorkers: server.settings.executor.maxWorkers },
  proposals: server.proposals,
  foreman: server.foreman,
})
const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(), paused: false, criteria: ['按钮文案没有错字'],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z', startedAt: '2026-09-22T00:01:00Z',
    ref: 'worker-t1', report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  sessions: [{ id: 'worker-t1', current: true }],
  decisions: [],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'text', text: '记得跑一遍测试', at: '2026-09-22T00:04:00Z', delivered: true }],
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', masked: false, description: { zh: '执行目录', en: 'Directory' },
    owner: 'executor' },
  { key: 'DSH_SUPERAGENT_GITHUB_TOKEN', value: '', masked: true }],
})
function initial(): PanelServer {
  const settings = SettingsSchema.parse({ executor: { blockedCommands: ['gh-personal'] } })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { stop: false }, sessionId: '',
    stop: 'user-stopped', summary: 'stopped',
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', outcome: 'stopped', stop: 'user-stopped', reason: 'Human asked to stop' } },
  { stage: 'ended' })
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [],
    load: { running: 2, queued: 0 },
    wrapUp: { active: false, since: null, settled: 0, working: [], ready: false, history: [] },
    master: { id: 'superagent-master', generation: 0, usage: 0.2 },
    proposals: [{ id: 'pr-1', status: 'approved', tasks: 2, heard: '把登录页错字改一下，再优化下首页加载', ticketIds: ['t1'],
      createdAt: '2026-11-18T00:00:00Z', approvedAt: '2026-11-18T00:01:00Z', handoffAt: '2026-11-18T00:02:00Z',
      dispatchedAt: '2026-11-18T00:03:00Z' }],
    proposalPages: { 'pr-1': { id: 'pr-1', status: 'dispatched', createdAt: '2026-11-18T00:00:00Z', approvedAt: '2026-11-18T00:01:00Z',
      handoffAt: '2026-11-18T00:02:00Z', dispatchedAt: '2026-11-18T00:03:00Z', ticketIds: ['t1'],
      heard: '把登录页错字改一下，再优化下首页加载',
      tasks: [{ title: '改登录页错字', request: '把登录按钮上的错字改掉', accept: '按钮文案没有错字', workspace: 'D:/buzhiding' },
        { title: '首页加载优化', request: '首页首屏不要等全部数据', accept: '首屏先出骨架，数据到了再填' }],
      tickets: [{ id: 't1', title: '修复回归', stop: null }] } },
    foreman: { session: 'superagent-foreman', generation: 0, pending: false, usage: 0.38,
      rotatedAt: '2026-11-18T00:00:00Z', open: true },
    setup: { machine: MACHINE, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    settings, revisions: { executor: 0, settings: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: [],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
    tickets: [ticketSummary(), ended], ticketDetails: { t1: ticketDetail(),
      t0: { ...ended, paused: false, criteria: [], assignments: [], sessions: [], decisions: [], inputs: [], environment: [] } },
    person: [ticketSummary({ attention: { id: 'q1', kind: 2, question: '需要确认按钮颜色' },
      note: { text: '需要确认按钮颜色', error: false }, summary: '需要确认按钮颜色' }, { stage: 'adjudication' })],
    search: { tickets: [], proposals: [], items: [], threads: [] },
    history: { current: 0, items: [] },
  }
}

/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit), total: items.length,
  next_offset: offset + limit < items.length ? offset + limit : null })
const ticketOf = (id: string) => server.tickets.find(ticket => ticket.id === id)

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    return { ...server.search, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET settings': { answer: settingsView },
  'GET tickets': { query: ['state', 'offset', 'limit'], answer: ({ query }) => {
    const state = query.state ?? 'working'
    const rows = server.tickets.filter(ticket => state === 'all' || (state === 'working' ? ticket.state === 'open' : ticket.state === 'ended'))
    return page(rows, Number(query.offset ?? 0), Number(query.limit ?? 20))
  } },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'GET proposals/:id': { answer: ({ params }) => server.proposalPages[params.id] ?? refuse(404, 'Instruction not found') },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    const ended = { at: new Date().toISOString(), by: 'human' as const, outcome: 'stopped' as const, stop: 'user-stopped' as const }
    Object.assign(ticket, { state: 'ended', stage: 'ended', actions: { stop: false }, ended, stop: 'user-stopped' })
    const detail = server.ticketDetails[params.id]
    if (detail) Object.assign(detail, { state: 'ended', stage: 'ended', actions: { stop: false }, ended, stop: 'user-stopped' })
    server.person = server.person.filter(item => item.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/wrapup': { answer: () => {
    server.wrapUp = { ...server.wrapUp, active: true, since: new Date().toISOString(), ready: server.wrapUp.working.length === 0,
      history: [{ kind: 'wrap-up' as const, at: new Date().toISOString() }, ...server.wrapUp.history] }
    return server.wrapUp
  } },
  'POST executor/startwork': { answer: () => {
    server.wrapUp = { ...server.wrapUp, active: false, since: null, ready: false,
      history: [{ kind: 'start-work' as const, at: new Date().toISOString() }, ...server.wrapUp.history] }
    return server.wrapUp
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    if (block !== 'executor') return refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions.executor ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    server.revisions.executor = (server.revisions.executor ?? 0) + 1
    server.revisions.settings = (server.revisions.settings ?? 0) + 1
    return { restarting: false, revision: server.revisions.executor }
  } },
  'GET settings/history': { answer: () => server.history },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': { answer: () => ({ default: { provider: 'host', model: 'default' }, routableProviders: [], failures: [],
    groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) },
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // As the host does: an override names a built-in part, keeps its placeholders, and goes once its text is the built-in text again.
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    const saved = server.prompts.current.config.overrides ?? {}
    const kept: Record<string, { text: string; base?: string }> = {}
    for (const [part, override] of Object.entries(overrides)) {
      const built = builtInPart(part)
      if (!built) {
        if (Object.hasOwn(saved, part)) continue
        return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      }
      const missing = (built.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
      if (override.text === built.text) continue
      kept[part] = { text: override.text, base: override.base ?? saved[part]?.base ?? builtInBase(built.text) }
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(kept).length ? { ...config, overrides: kept } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    // The generated environment part from its template, without variables; the main Session's instruction rules are part of it.
    const environment = environmentSection(body, [])
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, true), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(Object.keys(body.skills).map(name => [name, composeSkill(body, name)])),
      orchestrator: composePrompt(body, 'orchestrator', environment, true), worker: composePrompt(body, 'worker', environment), scope: '' }
  } },
}

function match(method: string, segments: string[]) {
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * Response wrapper that increments `server.pending` when constructed and decrements it when `.text()` is consumed.
 * Requests held back by `server.searching` are not constructed until `searching` resolves, so they do not count as pending early.
 */
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** Fake DSH host configuration form that records mutations and optionally applies them to its snapshot. */
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable,
    mode: 'host' }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  return { form, mutations, publish }
}