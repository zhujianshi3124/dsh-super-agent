/** Stable content-derived identifiers; equal inputs always produce the same id. */
import { createHash } from 'node:crypto'
export function key(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}
/**
 * The id of the ticket one task of a confirmed instruction becomes: the same instruction and task number always name the same
 * first ticket, so a task dispatched twice while its ticket is live is refused (C-09). A stopped ticket's task may be continued
 * by a new ticket (N-13a), which `continuationTicketId` names.
 */
export const taskTicketId = (proposalId: string, task: number): string => key('ticket', proposalId, String(task))
/** The id of the ticket that continues a stopped ticket's task: a new ticket number, never the old one reopened (N-13a). */
export const continuationTicketId = (proposalId: string, task: number, round: number): string => key('ticket', proposalId, String(task), `c${round}`)
