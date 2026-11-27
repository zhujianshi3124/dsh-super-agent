/** Ticket stage projection: a ticket is working or stopped (N-07); the stages below only describe how it works. */
import { latestAssignment, type Ticket } from './model.ts'

/**
 * How an open ticket is working: its worker runs (`working`), it waits for a worker slot or a named session (`queued`),
 * its worker stopped at a clean node awaiting the person's adjudication (`adjudication`, C-16a), or nothing runs for it
 * between turns (`idle`). A stopped ticket is `ended`; there is no third state and no awaiting-review stage (v2.27).
 */
export type TicketStage = { stage: 'working' } | { stage: 'queued' } | { stage: 'adjudication' } | { stage: 'idle' } | { stage: 'ended' }

/** Classifies a ticket's stage: stopped first, then adjudication, then the latest assignment's state. */
export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.attention) return { stage: 'adjudication' }
  const assignment = latestAssignment(ticket)
  if (!assignment || assignment.state === 'pending') return { stage: 'queued' }
  if (assignment.state === 'running') return { stage: 'working' }
  return { stage: 'idle' }
}
