/** Cross-entity search: tickets, instructions, and the person's own messages by number, link, or text (C-37g, C-29). */
import { threadKey, type Ticket, type Trigger } from '../../core/index.ts'
import type { TextCache } from '../cache.ts'
import { newestFirst, snapshot, threadSummary, threadTitle, ticketSummary, triggerView, type ViewHost } from './records.ts'
import { preview } from './text.ts'

/**
 * Searches triggers, threads, and tickets by text, ID, source-extracted references (e.g., `#N`, URLs), or cached Feishu AppLinks.
 * @param links - Feishu message AppLinks cached since startup, keyed by chat and message ID.
 */
export function search(host: ViewHost, query: string, links: Pick<TextCache, 'entries'>) {
  const { store, sources } = host
  const value = query.trim()
  if (!value) return { tickets: [], proposals: [], items: [], threads: [] }
  const view = snapshot(host)
  const named = sources.find(value)
  const terms = new Set([value, ...named.terms])
  for (const [name, url] of links.entries()) if (url === value) terms.add(name.split(':').at(-1)!)
  const found = new Map<string, Trigger>()
  for (const term of terms) for (const trigger of store.read.search(term)) found.set(trigger.id, trigger)
  const threads = named.threads.flatMap(key => { const thread = store.threads.get(key); return thread ? [threadSummary(view, thread)]
    : [] })
  const lower = value.toLowerCase()
  // Match tickets by their number, by threads they own (e.g., bound PRs) or subscribe to, and by title.
  const reaches = (ticket: Ticket) => [...(ticket.follows ?? []).map(follow => follow.thread),
    ...view.threadsOf(ticket.id).map(thread => thread.key)]
  const matches = (ticket: Ticket) => ticket.id.toLowerCase().includes(lower)
    || reaches(ticket).some(key => named.threads.includes(key)) || ticket.title.toLowerCase().includes(lower)
  const tickets = store.tickets.list().filter(matches).sort(newestFirst).slice(0, 10).map(ticket => ticketSummary(ticket, view.workerSession))
  // Instructions match by number, the person's own words, and task text (C-29: the whole path stays findable).
  const proposals = store.proposals.list().filter(proposal => proposal.id.toLowerCase().includes(lower)
    || proposal.heard.toLowerCase().includes(lower)
    || proposal.tasks.some(task => task.title.toLowerCase().includes(lower) || task.request.toLowerCase().includes(lower)))
    .slice(0, 10).map(proposal => ({ id: proposal.id, status: proposal.status, tasks: proposal.tasks.length,
      heard: preview(proposal.heard), ticketIds: proposal.ticketIds }))
  // Omit automated triggers from threads already included in `threads`.
  const shownThreads = new Set(threads.map(thread => thread.key))
  const item = (trigger: Trigger) => {
    const home = store.threads.get(threadKey(trigger.threads[0]!))
    const { text: _text, ...row } = triggerView(view, trigger)
    // Triggers filtered by their Source have no Thread record; surface the filter reason instead.
    const filtered = home ? {} : { filtered: store.triggers.disposition(trigger.id)?.filtered ?? '' }
    return { ...row, threadTitle: home ? threadTitle(store, home) : undefined, ...filtered }
  }
  const items = [...found.values()].filter(trigger => trigger.human || !shownThreads.has(threadKey(trigger.threads[0]!)))
  return { tickets, proposals, items: items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(item), threads }
}
export type SearchView = ReturnType<typeof search>
