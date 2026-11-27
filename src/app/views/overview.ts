/** Overview view: the person's pending adjudications, missing-role problems, executor load, instructions, and role blocks (C-37). */
import { ticketStage } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import { newestFirst, snapshot, type ViewHost } from './records.ts'
import { ticketRow, type ExecutorLoad } from './tickets.ts'
import { preview } from './text.ts'

/**
 * Builds the operator overview (C-37): the tickets awaiting the person's adjudication, the system problems (a missing main
 * Session or foreman, C-26b/C-37.2), executor load, the instructions, and the two role blocks. Nothing else: no flow counts,
 * no eval problems, no pause problem — those belong to the execution and deployment pages.
 * @param missingMaster - The main workspace when no main Session is open: one of the three roles is missing, so nothing runs.
 * @param foreman - The foreman slot's state; `open` false while no foreman Session exists, except during a replacement window.
 */
export function overview(host: ViewHost, load: ExecutorLoad, opts: { masterId?: string; missingMaster?: string;
  foreman?: { session: string; generation: number; pending: boolean; usage: number | null; rotatedAt: string | null; open: boolean } }) {
  const { store } = host
  const view = snapshot(host)
  const settings = store.settings()
  const problems = [
    // The three roles are all required: naming the missing one is what C-26b asks for (C-37.2).
    ...(opts.missingMaster ? [{ kind: 'no-master' as const, workspace: opts.missingMaster }] : []),
    ...(opts.foreman && !opts.foreman.open ? [{ kind: 'no-foreman' as const, workspace: 'D:/gongtou' }] : []),
  ]
  const open = store.tickets.open().sort(newestFirst)
  const masterState = store.get(KV.rotation.master)
  return {
    problems,
    // Which main Session is current, its generation, and how much of its context is used (C-37.5, C-13c).
    master: { id: opts.masterId ?? '', generation: masterState?.generation ?? 0, usage: masterState?.usage?.ratio ?? null },
    person: open.filter(ticket => ticketStage(ticket).stage === 'adjudication').map(ticket => ticketRow(view, ticket)),
    executor: { ...load, maxWorkers: settings.executor.maxWorkers },
    // Instructions stay read-only here: records of what was confirmed, with the four times (C-37.4, C-37e).
    proposals: store.proposals.list().slice(0, 10).map(proposal => ({ id: proposal.id, status: proposal.status,
      tasks: proposal.tasks.length, heard: preview(proposal.heard), ticketIds: proposal.ticketIds,
      createdAt: proposal.createdAt, approvedAt: proposal.approvedAt ?? null, handoffAt: proposal.handoffAt ?? null,
      dispatchedAt: proposal.dispatchedAt ?? null })),
    foreman: opts.foreman ?? { session: '', generation: 0, pending: false, usage: null, rotatedAt: null, open: true },
  }
}
export type OverviewView = ReturnType<typeof overview>
