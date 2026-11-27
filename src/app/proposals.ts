/** The instruction a person confirms before any ticket may be created under it: its numbering, its status, and its gate. */
import { UserError, type Proposal, type ProposalOrigin, type ProposalTask, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CHIEF, chiefTriggerId } from '../sources/chief.ts'
import type { Store } from './store.ts'

/** What a main Session hands over when it understood a request: the tasks it proposes and the person's own message for cross-checking. */
export interface ProposalDraft {
  tasks: ProposalTask[]
  heard: string
  origin?: ProposalOrigin
  /** A draft instruction to revise in place, such as `pr-3`, while the person has not confirmed it yet. */
  replaces?: string
}

/** Whether a task's wording is complete enough to show a person: a title and what to do; completion criteria are optional (C-13a). */
const complete = (task: ProposalTask): boolean => task.title.trim() !== '' && task.request.trim() !== ''
/** Completion criteria are at most 8 lines (N-08); more must be merged while drafting, before the person confirms. */
const criteriaLines = (accept: string | undefined): string[] => (accept ?? '').split('\n').map(line => line.trim()).filter(Boolean)

/**
 * Numbered instructions (`pr-1`, `pr-2`, …) with three states: `draft` until the person confirms, `approved` then, and
 * `dispatched` once a ticket was created under it. There is no switch: a ticket that names no approved instruction is refused
 * by the domain (`Tickets.create`), not by a prompt (C-22).
 */
export class Proposals {
  constructor(private readonly store: Pick<Store, 'proposals' | 'get' | 'set' | 'atomic' | 'settings'>) {}

  /** Records a draft instruction and returns it with its number; nothing is dispatched and no model request is made. */
  draft(input: ProposalDraft): Proposal {
    const tasks = input.tasks.map(task => ({ ...task, title: task.title.trim(), request: task.request.trim(),
      ...(task.accept?.trim() ? { accept: task.accept.trim() } : {}),
      ...(task.workspace?.trim() ? { workspace: task.workspace.trim() } : {}),
      ...(task.session?.trim() ? { session: task.session.trim() } : {}) }))
    if (!tasks.length || !tasks.every(complete)) throw new UserError('proposalInvalid')
    if (tasks.some(task => criteriaLines(task.accept).length > 8)) throw new UserError('proposalCriteriaTooMany')
    if (input.heard.trim() === '') throw new UserError('proposalEmpty')
    return this.store.atomic(() => {
      // A person refining a request before confirming it keeps one instruction number: the wording is replaced in place, so no
      // second number is handed out for a single conversation and no stale draft is left on screen.
      if (input.replaces) {
        const existing = this.store.proposals.get(input.replaces)
        if (!existing) throw new UserError('proposalNotDraft', { proposal: input.replaces })
        if (existing.status !== 'draft') throw new UserError('proposalNotDraft', { proposal: input.replaces })
        const revised: Proposal = { ...existing, tasks, heard: input.heard, ...(input.origin ? { origin: input.origin } : {}) }
        this.store.proposals.save(revised)
        return revised
      }
      // One user message makes one instruction: a second draft from the same message returns the first, in code rather than by
      // a prompt's self-restraint (C-09a), so no model can send the same instruction twice under two numbers.
      const heardId = input.origin?.messageId
      if (heardId) {
        const drafted = this.store.proposals.list().find(proposal => proposal.origin?.messageId === heardId)
        if (drafted) return drafted
      }
      const seq = (this.store.get(KV.proposals.seq) ?? 0) + 1
      this.store.set(KV.proposals.seq, seq)
      const proposal: Proposal = { id: `pr-${seq}`, status: 'draft', tasks, heard: input.heard, createdAt: new Date().toISOString(),
        ...(input.origin ? { origin: input.origin } : {}), ticketIds: [] }
      this.store.proposals.save(proposal)
      return proposal
    })
  }

  /** The person confirmed the instruction; confirming again (or after dispatch) keeps the first approval. Drafts only become `approved`. */
  approve(id: string): Proposal {
    return this.store.atomic(() => {
      const proposal = this.require(id)
      if (proposal.status !== 'draft') return proposal
      const approved: Proposal = { ...proposal, status: 'approved', approvedAt: new Date().toISOString() }
      this.store.proposals.save(approved)
      return approved
    })
  }

  /** The stored instruction, or a `missing` error naming it. */
  view(id: string): Proposal { return this.require(id) }

  /** Records that the approved instruction went to the foreman; repeating it keeps the first time. */
  markHandedOff(id: string): Proposal {
    return this.store.atomic(() => {
      const proposal = this.require(id)
      if (proposal.handoffAt) return proposal
      const handed: Proposal = { ...proposal, handoffAt: new Date().toISOString() }
      this.store.proposals.save(handed)
      return handed
    })
  }

  /** Newest first. */
  list(): Proposal[] { return this.store.proposals.list() }

  /**
   * The instruction a ticket may be created under. One that is unknown, still a draft, or absent is refused: no ticket exists
   * without an instruction the person confirmed (C-22).
   * @throws UserError `notApproved`
   */
  approved(id: string | undefined): Proposal | undefined {
    const proposal = id === undefined ? undefined : this.store.proposals.get(id)
    if (proposal?.status !== 'approved' && proposal?.status !== 'dispatched') throw new UserError('notApproved', { proposal: id ?? 'none' })
    return proposal
  }

  private require(id: string): Proposal {
    const proposal = this.store.proposals.get(id)
    if (!proposal) throw new UserError('unknownProposal', { proposal: id })
    return proposal
  }
}

/** The person's words as typed, line endings and surrounding blanks aside, so a resent copy compares equal. */
const words = (text: string): string => text.replace(/\r\n?/g, '\n').trim()
/**
 * Whether a message of the main Session's thread is already an instruction, so its card must not reach the main Session
 * again (C-09a: one message, one instruction): it is the message an instruction was drafted from; or it falls between an
 * instruction's draft and its approval, which makes it that approval; or it repeats word for word the words an instruction
 * of the same Session was drafted from, sent before that instruction was approved — a request the person cut off and sent
 * again. The same words after the approval are a new request.
 */
export function claimedByProposal(proposals: readonly Proposal[], trigger: Pick<Trigger, 'at' | 'text' | 'meta'>): boolean {
  const messageId = String(trigger.meta?.messageId ?? '')
  const session = String(trigger.meta?.sessionId ?? '')
  const at = trigger.at
  return proposals.some(proposal => {
    if (messageId && proposal.origin?.messageId === messageId) return true
    if (!session || proposal.origin?.thread !== session) return false
    if (proposal.approvedAt !== undefined && proposal.createdAt <= at && at <= proposal.approvedAt) return true
    return words(proposal.heard) !== '' && words(proposal.heard) === words(trigger.text)
      && (proposal.approvedAt === undefined || at <= proposal.approvedAt)
  })
}

/**
 * Whether the message the instruction was drafted from is still the person's latest, so no confirmation has arrived since:
 * a model may not approve an instruction on the strength of the request that produced it.
 */
export const awaitingConfirmation = (proposal: Pick<Proposal, 'origin'>, latestMessageId: string | undefined): boolean =>
  latestMessageId === undefined || proposal.origin?.messageId === undefined || proposal.origin.messageId === latestMessageId

/**
 * The text a foreman reads for an approved instruction: the tasks the person confirmed, and the person's own message marked
 * as cross-checking only. It is built from the stored instruction, never from what a model retypes, so neither wording can drift.
 */
export function instructionText(proposal: Proposal): string {
  const lines = proposal.tasks.map((task, index) => `${index + 1}. ${task.title}\n   要做：${task.request}`
    + `\n   完成标准：${task.accept?.trim() || '（没写，只看结果）'}`
    + `\n   目录：${task.workspace ?? '（没说，用默认）'}`
    + (task.session ? `\n   点名会话：${task.session}（C-12：它在忙就等它干完，再按实际占用判）` : ''))
  // The ticket is created by deciding the Trigger of the person's own message, which only this plugin's chief Source knows.
  const origin = proposal.origin
  const trigger = origin?.source === CHIEF && origin.messageId
    ? [`\ntrigger_id: ${chiefTriggerId(origin.thread, origin.messageId)}（accept 时照抄这一条，它就是用户说这件事的那句话）`]
    : []
  return [`【指令清单 ${proposal.id}】这是用户已确认的最终形态，请据此定方案并派发工单。`, ...lines,
    `\n（用户原话，只用于核对有没有理解偏，不当作任务正文：${proposal.heard}）`,
    '\n你派出的每一张工单都要挂这个指令清单编号；同一指令清单下的子工单不用再问用户。', ...trigger].join('\n')
}
