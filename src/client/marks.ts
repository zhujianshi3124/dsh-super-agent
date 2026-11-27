/** Pure mappers from ticket stages, stop reasons, report states, and health to UI status indicators (observations, not progress). */
import type { HealthEntry, TicketStage, TicketSummary } from './api.ts'
import type { DshSuperagentKey } from './locales.ts'
import { valueLabel, type T } from './text.ts'
import type { DotState, IconName, TagTone } from './controls.tsx'

export interface Mark { label: string; tone: TagTone; dot: DotState; icon: IconName }

/** The C-15 situation a pending ticket waits for (attention.kind 2-7), or the generic adjudication label (C-37.1). */
export function attentionLabel(t: T, kind: number | undefined): string {
  const key = `attentionKind.${kind}` as DshSuperagentKey
  const text = kind !== undefined && kind >= 2 && kind <= 7 ? t(key) : undefined
  return text && text !== key ? text : t('stage.adjudication')
}

/** Stage observation words: working, queued, adjudication, idle, ended; an ended ticket is labelled by its stop reason (N-13). */
export function ticketMark(t: T, ticket: { stage: TicketStage['stage'] } & Pick<TicketSummary, 'ended' | 'stop' | 'attention'>): Mark {
  switch (ticket.stage) {
    case 'working': return { label: t('stage.working'), tone: 'info', dot: 'ongoing', icon: 'running' }
    case 'queued': return { label: t('stage.queued'), tone: 'neutral', dot: 'idle', icon: 'queue' }
    case 'adjudication': return { label: attentionLabel(t, ticket.attention?.kind), tone: 'warning', dot: 'warning', icon: 'ask' }
    case 'idle': return { label: t('stage.idle'), tone: 'neutral', dot: 'idle', icon: 'clock' }
    case 'ended': {
      const stop = ticket.stop
      return { label: stop ? t(`stop.${stop}`) : t('stage.ended'), tone: stop === 'delivered' ? 'success' : stop === 'failed' ? 'danger' : 'neutral',
        dot: stop === 'failed' ? 'error' : 'idle', icon: 'stop' }
    }
  }
}

export const reportDot = (report: string | undefined): DotState => report === 'failed' ? 'error'
  : report === 'blocked' || report === 'waiting' ? 'warning' : report === 'ready' ? 'done' : 'ongoing'

export const healthDot = (state: HealthEntry['state']): DotState => state === 'error' ? 'error'
  : state === 'paused' ? 'warning' : state === 'starting' ? 'ongoing' : 'done'

/** Tag tone for a stop reason, shared by the instruction page's ticket list (null while the ticket is still open). */
export const stopTone = (stop: TicketSummary['stop'] | null): TagTone => stop === 'delivered' ? 'success' : stop === 'failed' ? 'danger' : 'neutral'
export const stopLabel = (t: T, stop: TicketSummary['stop'] | null): string => stop ? t(`stop.${stop}`) : t('ticket.state.open')