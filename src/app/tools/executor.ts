/** Worker Session tools: read the ticket's context, hand back out-of-scope input to the foreman (C-24), and report (N-09). */
import { z } from 'zod'
import { liveTicket, type EngineForExecutor, type Ticket } from '../../core/index.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { readTool, tool, type Tool } from './tool.ts'

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'handback'>
  readonly store: Pick<Store, 'tickets' | 'atomic' | 'triggers'>
  readonly sessions: Pick<Sessions, 'foremanRelay'>
  readonly resources: ResourceHost
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand a message that asks for work beyond this ticket back to the foreman (C-24): the foreman judges whether it is a clarification of this ticket or a new requirement that needs a new instruction. Never answer it yourself and never treat a new requirement as a clarification; once per message.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => {
        const queued = host.engine.handback(ticketId, args.trigger_id, args.reason)
        // The foreman receives the handed-back message itself, so it can judge clarification versus new requirement (C-24).
        const trigger = host.store.triggers.get(args.trigger_id)
        host.sessions.foremanRelay(`handback:${ticketId}:${args.trigger_id}`, JSON.stringify({ kind: 'worker_handback', ticket_id: ticketId,
          trigger_id: args.trigger_id, text: trigger?.text ?? '', reason: args.reason,
          note: 'The worker handed this message back. Judge it against the ticket\'s goal and completion criteria: a clarification goes back to the worker as input; a new requirement needs a new instruction from the main Session (C-24, C-08). Do not ask the person which it is unless C-15 applies.' }))
        return { trigger_id: args.trigger_id, queued }
      },
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report to the foreman that dispatched this ticket, and to nobody else (C-16a, N-09): ready when the work is done (the ticket ends with stop reason delivered), blocked with a question when a C-15 situation needs the person\'s adjudication (the ticket keeps going; stop at a clean node and wait), failed when the work cannot be done or misses the completion criteria. Progress reports stay internal and reach nobody. Write the report so the foreman can act on it without reading your transcript.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'wrapped']).describe('wrapped only after the host\'s 用户收工 sentence, once your step is done and your handoff written (C-17b): the ticket ends with stop reason wrapped.'),
        summary: z.string().min(1).describe('The report itself: what was done and the evidence, or what blocks the work. Stored word for word in the ticket (C-29).'),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('With state=blocked: the one concrete question for the person, with options and a recommendation when you can give them (C-16). Omit to keep the pending one, null to clear it.'),
        human_action_kind: z.number().int().min(2).max(7).nullish().describe('With human_action: which C-15 situation it is — 2 only the person can do (login, authorization, credential, button), 3 goal or criteria change, 4 direction infeasible, 5 dangerous operation, 6 no model has quota, 7 machine limitation. The panel labels the pending ticket with it (C-37.1).'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the person\'s message that raised the question, when there is one.'),
        stop_reason: z.enum(['session-stopped', 'failed']).nullish().describe('With state=blocked or failed: session-stopped when this session can no longer work at all (network, rate limit, quota — N-13b); failed otherwise. Omit for failed.'),
      }).strict(),
      execute: async args => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended; it is never reopened (C-11). Continued work is a new ticket under the same instruction (N-13a).')
        // Record the report and queue the relay atomically, so a rejected report leaves no partial state and a recorded one always reaches the foreman.
        return host.store.atomic(() => {
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.human_action_kind ? { questionKind: args.human_action_kind } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.stop_reason ? { stopReason: args.stop_reason } : {}) }
          const updated = host.engine.report(ticketId, report)
          const relay = reportRelay(updated, report)
          // A worker reports to the foreman that dispatched its ticket and to nobody else: the foreman collects every stopped
          // worker's question, asks once and passes the result on through the main Session (C-16a, C-19).
          if (relay) host.sessions.foremanRelay(relay.id, relay.text)
          const notification = relay ? 'foreman' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
  ]
}
