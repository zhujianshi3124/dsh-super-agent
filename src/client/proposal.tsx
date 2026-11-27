/** Instruction detail (C-37e): number, state, the four times, the person's own words for cross-checking, every task's full
 * text, and the tickets it dispatched. Read-only: confirming an instruction happens in the conversation, never here (C-06). */
import { ApiError, usePoll, type ProposalPageView } from './api.ts'
import { Tag } from './controls.tsx'
import { stopLabel, stopTone } from './marks.ts'
import { usePanel } from './provider.tsx'
import { when } from './text.ts'
import { Hint, LabelValue, LoadState, PageHead, Section } from './widgets.tsx'

const tone = (status: ProposalPageView['status']) => status === 'draft' ? 'warning' as const
  : status === 'dispatched' ? 'info' as const : 'success' as const

export function ProposalPage({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET proposals/:id', { id }), [id])
  if (!data) return <>
    <PageHead title={t('term.proposal')} />
    {error instanceof ApiError && error.missing ? <Hint>{t('proposalNotFound')}</Hint> : <LoadState error={error} loading />}
  </>
  const time = (value: string | undefined) => value ? when(value, t('lang')) : t('empty')
  return <>
    <PageHead title={`${t('term.proposal')} ${data.id}`}><Tag tone={tone(data.status)}>{t(`proposalStatus.${data.status}`)}</Tag></PageHead>
    {error && <LoadState error={error} loading={false} />}
    {/* The four times: drafted, confirmed, handed to the foreman, dispatched (C-37e.1). */}
    <div className="dt-row-meta dt-status-line">
      <LabelValue label={t('proposalCreatedLabel')} value={time(data.createdAt)} />
      <LabelValue label={t('proposalApprovedLabel')} value={time(data.approvedAt)} />
      <LabelValue label={t('proposalHandoffLabel')} value={time(data.handoffAt)} />
      <LabelValue label={t('proposalDispatchedLabel')} value={time(data.dispatchedAt)} />
    </div>
    <Section title={t('proposalHeardLabel')}>
      <p className="dt-row-quote">{data.heard}</p>
    </Section>
    <Section title={t('proposalTasksLabel')} count={data.tasks.length}>
      <ul className="dt-list dt-cards">{data.tasks.map((task, index) => <li key={index} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title">{index + 1}. {task.title}</div>
          <div className="dt-row-quote">{task.request}</div>
          {/* Completion criteria only where they could be written clearly (C-13a). */}
          {task.accept && <div className="dt-row-meta"><LabelValue label={t('proposalCriteriaLabel')} value={task.accept} /></div>}
          <div className="dt-row-meta"><LabelValue label={t('proposalWorkspaceLabel')} value={task.workspace ?? t('proposalDefaultWorkspace')} /></div>
          {task.session && <div className="dt-row-meta"><LabelValue label={t('proposalSessionLabel')}
            value={<span className="dt-mono">{task.session}</span>} /></div>}
        </div>
      </li>)}</ul>
    </Section>
    <Section title={t('proposalTicketsLabel')} count={data.tickets.length}>
      {data.tickets.length ? <ul className="dt-list">{data.tickets.map(ticket => <li key={ticket.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title"><button type="button" className="dt-open"
            onClick={() => navigate({ page: 'execution', id: ticket.id })}>{ticket.title || ticket.id}</button></div>
          <div className="dt-row-meta">
            <span className="dt-mono">{ticket.id}</span>
            <Tag tone={stopTone(ticket.stop)}>{stopLabel(t, ticket.stop)}</Tag>
          </div>
        </div>
      </li>)}</ul> : <Hint>{t('proposalNoTickets')}</Hint>}
    </Section>
  </>
}