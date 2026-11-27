/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { WrapUpView } from './wrapup.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, ProposalPageView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SearchView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

/** The execution page's three filters (C-37d): working, stopped, all. */
export const TICKET_FILTERS = ['working', 'ended', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

/**
 * The panel's operations (C-38 is exhaustive): stop a ticket, open a session (client-side), pause or resume dispatch, wrap up or start work (C-17b),
 * change the execution/prompts/deployment settings, search and read history, and collapse seen problems (client-side).
 * There is no retry, no requeue, no dismiss, no unsubscribe, no master designation (C-39).
 */
export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET settings': { response: SettingsView }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'GET proposals/:id': { response: ProposalPageView }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'POST executor/wrapup': { response: WrapUpView }
  'POST executor/startwork': { response: WrapUpView }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET settings/history': { response: HistoryView }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
