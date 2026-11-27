/** Ticket detail (C-37d.4): state, adjudication question, stop reason, report word for word, inputs, dispatch history with
 * generations, session generations, working directory, masked environment, identifiers. Actions: stop and open session only. */
import { useState, type ReactNode } from 'react'
import { ApiError, usePoll, type TicketPageView } from './api.ts'
import { DisclosureRow, Dot, Icon, Tag, type IconName } from './controls.tsx'
import { attentionLabel, reportDot, ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { Earlier, automatedRuns } from './rows.tsx'
import { actorName, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { ConfirmButton, Hint, KeyValues, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton,
  StageMark, When } from './widgets.tsx'

type Input = TicketPageView['inputs'][number]
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  const { t } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    <div className="dt-row-main">
      {trigger ? <div className="dt-row-title">{actorName(t, trigger.actor)}{t('labelSeparator')}{readableMarkers(t, trigger.preview)
        || t('empty')}</div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}<When
        at={input.at} /></div>
      {(input.kind === 'text' || input.kind === 'note') && input.text && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      <Earlier items={earlier} />
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : undefined
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
  </DisclosureRow>
}
/** Dispatch history: every assignment with the session generation it ran in and its report word for word (C-29). */
function Assignments({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const generation = (ref: string | undefined) => {
    if (!ref) return undefined
    const index = ticket.sessions.findIndex(session => session.id === ref)
    return index < 0 ? undefined : ticket.sessions.length - index
  }
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      <div className="dt-row-meta">
        {/* A running assignment whose worker reported a non-progress state has ended its turn; show that report as its tag. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {generation(item.ref) !== undefined && <span>{t('assignmentGeneration', { generation: generation(item.ref)! })}</span>}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
      </div>
      {item.report?.summary && <div className="dt-row-quote"><MarkdownLite text={item.report.summary} /></div>}
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
  </li>)}</ul>
}
/** Every worker session the ticket has used, newest first, each with its generation; a rotation keeps the ticket number (C-29). */
function Sessions({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const total = ticket.sessions.length
  return <ul className="dt-list">{ticket.sessions.map((session, index) => <li key={session.id} className="dt-row">
    <div className="dt-row-main">
      <div className="dt-row-title dt-mono">{session.id}</div>
      <div className="dt-row-meta">
        <span>{t('ticketSessionGeneration', { generation: String(total - index) })}</span>
        {session.current && <Tag tone="info">{t('ticketSessionCurrent')}</Tag>}
      </div>
    </div>
    <div className="dt-row-actions"><SessionButton variant="outline" sessionId={session.id} /></div>
  </li>)}</ul>
}
/** What the foreman decided about this ticket, oldest first, so a successor foreman and the person read the same record (C-30). */
function Decisions({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  if (!ticket.decisions.length) return <Hint>{t('ticketDecisionsEmpty')}</Hint>
  return <ul className="dt-list">{ticket.decisions.map((decision, index) => <li key={index} className="dt-row">
    <div className="dt-row-main">
      <div className="dt-row-quote"><MarkdownLite text={decision.text} /></div>
      <div className="dt-row-meta"><When at={decision.at} /></div>
    </div>
  </li>)}</ul>
}

export function TicketPage({ id }: { id: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error instanceof ApiError && error.missing ? <Hint>{t('ticketNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  const status = ticketMark(t, data)
  const undelivered = data.inputs.filter(input => !input.delivered)
  const delivered = data.inputs.filter(input => input.delivered)
  const stop = data.stop
  return <>
    <PageHead title={data.title}>
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-row-meta dt-status-line">
      <StageMark state={status.dot} icon={status.icon} label={status.label} />
      <LabelValue label={t('stateLabel')} value={t(data.state === 'open' ? 'ticket.state.open' : 'ticket.state.ended')} />
      <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
      {data.waitingFor && <LabelValue label={t('waitingForLabel')} value={<span className="dt-mono">{data.waitingFor}</span>} />}
    </div>
    <div className="dt-row-meta">
      {data.proposal && <button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'proposal', id: data.proposal! })}>{t('proposalLabel')} {data.proposal}</button>}
      {data.task !== undefined && <span>{t('taskLabel')} {data.task + 1}</span>}
      {data.continues && <button type="button" className="dt-textlink"
        onClick={() => navigate({ page: 'execution', id: data.continues! })}>{t('continuesLabel')} {data.continues}</button>}
    </div>
    {data.ended && <Hint>{t('stopLine', { time: when(data.ended.at, t('lang')), stop: stop ? t(`stop.${stop}`) : t('stage.ended') })}
      {' · '}{t('stopByLabel')}{t('labelSeparator')}{t(`stopBy.${data.ended.by}`)}
      {data.ended.reason && <>{' · '}{t('stopReasonLabel')}{t('labelSeparator')}{reasonLabel(t, data.ended.reason)}</>}</Hint>}
    {data.attention && <div className="dt-banner"><span className="dt-banner-label">{attentionLabel(t, data.attention.kind)}{t('labelSeparator')}</span>
      <MarkdownLite text={data.attention.question} /></div>}
    {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
    </p>}
    {/* The report stays visible word for word in every state, not only when work halted (C-37.1, N-09). */}
    <Section title={t('reportTitle')}>
      {data.summary ? <div className="dt-report"><MarkdownLite text={data.summary} /></div> : <Hint>{t('reportEmpty')}</Hint>}
    </Section>
    {data.criteria.length > 0 && <Section title={t('criteriaTitle')} count={data.criteria.length}>
      <ul className="dt-plain-list">{data.criteria.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </Section>}
    {undelivered.length > 0 && <Section title={t('undeliveredInputs')} count={undelivered.length}>
      <Hint>{data.deliveryError ? t('inputAutoDeliveryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
      <InputList inputs={undelivered} />
    </Section>}
    {delivered.length > 0 && <Section title={t('deliveredInputs', { count: delivered.length })}>
      <InputList inputs={delivered} />
    </Section>}
    <Section title={t('term.assignment')} count={data.assignments.length}>
      <Assignments ticket={data} />
    </Section>
    <Section title={t('ticketSessions', { count: data.sessions.length })}>
      <Sessions ticket={data} />
    </Section>
    <Section title={t('ticketDecisions', { count: data.decisions.length })}>
      <Decisions ticket={data} />
    </Section>
    <div className="dt-details">
      {data.environment.length > 0 && <Details icon="settings" title={t('environmentTitle')}>
        <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key}
          title={'description' in variable ? localized(t, variable.description) : undefined}>
          <td className="dt-mono">{variable.key}</td>
          {/* A secret shows its name only, never its value (C-37d.4). */}
          <td>{variable.masked ? <Tag tone="quiet">{t('environmentMasked')}</Tag>
            : <span className="dt-mono">{variable.value || <span className="dt-hint">{t('empty')}</span>}</span>}</td>
        </tr>)}</tbody></table>
      </Details>}
      <Details icon="hash" title={t('identifiers')}>
        <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('ticketDirectory'), <span
          className="dt-mono">{data.directory ?? t('empty')}</span>]]} />
      </Details>
    </div>
    {data.actions.stop && <div className="dt-danger-zone">
      <span className="dt-hint">{t('stopHint')}</span>
      <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id }))} />
    </div>}
  </>
}