/** Execution page (C-37d): load, pause, wrap-up and start-work controls, three filters, ticket rows; and the Execution settings group (C-37f.1). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ExecutionHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead } from './widgets.tsx'

export function ExecutionStatus({ filter: current, state, reload }: {
  filter: TicketFilter; state: StateView; reload: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit } }), [current, limit])
  const { paused, load: { maxWorkers } } = state
  // Pausing only stops dispatching new tickets; no ticket's state changes (C-37d.1).
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('dispatchPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeDispatch' : 'pauseDispatch'
  // Wrap-up and start of work go to the foreman, which passes them on; the panel only shows how far workers settled (C-17b).
  const wrap = state.wrapUp
  const wrapUp = async () => { await call('POST executor/wrapup'); await reload() }
  const startWork = async () => { await call('POST executor/startwork'); await reload() }
  return <>
    <StatusHead hint={t('executionStatusIntro')} settings="execution" />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeDispatchConfirm' : 'pauseDispatchConfirm')}
        onConfirm={pause} />
      {wrap.active
        ? <ConfirmButton variant="outline" icon="play" label={t('startWork')} title={t('startWork')} message={t('startWorkConfirm')} onConfirm={startWork} />
        : <ConfirmButton variant="outline" icon="pause" label={t('wrapUp')} title={t('wrapUp')} message={t('wrapUpConfirm')} onConfirm={wrapUp} />}
    </div>
    <WrapUpStatus wrap={wrap} />
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); navigate({ page: 'execution', query: value === 'working' ? {} : { filter: value } },
          true) }}>{t(`ticketFilter.${value}`)}</Pill>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => <TicketLine key={ticket.id} ticket={ticket}
      question={ticket.stage === 'adjudication'} onChanged={reloadTickets} />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}

/** How far a wrap-up got (C-17b item 4): settled and still-working counts, how long it has waited, and "safe to shut down" once
 * every worker settled; then the latest wrap-ups and starts of work (C-17b item 7). */
function WrapUpStatus({ wrap }: { wrap: StateView['wrapUp'] }) {
  const { t } = usePanel()
  const time = (at: string) => new Date(at).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const waited = wrap.since ? Math.max(0, Math.round((Date.now() - Date.parse(wrap.since)) / 60_000)) : 0
  return <>
    {wrap.active && <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={wrap.ready ? 'ongoing' : 'warning'}>{t(wrap.ready ? 'wrapUpReady' : 'wrapUpSettling')}</span>
      <LabelValue label={t('wrapUpSettled')} value={wrap.settled} />
      <LabelValue label={t('wrapUpWorking')} value={wrap.working.length} />
      <LabelValue label={t('wrapUpWaited')} value={`${waited} min`} />
    </div>}
    {wrap.active && !wrap.ready && <ul className="dt-list">{wrap.working.map(ticket => <li key={ticket.id}>{ticket.title}</li>)}</ul>}
    {wrap.history.length > 0 && <Hint>{t('wrapUpHistory')}{wrap.history.slice(0, 4).map(event =>
      `${time(event.at)} ${t(event.kind === 'wrap-up' ? 'wrapUp' : 'startWork')}`).join(' · ')}</Hint>}
  </>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
/** The executor's declared variables; choosing a key inserts it into the prepare command (part of editing settings, C-38.4). */
function EnvironmentVariables({ groups, onPick }: { groups: SettingsView['environment']['variables']; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), stuckMinutes: String(executor.stuckMinutes ?? 60),
    blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), stuckMinutes: numberOf(value.stuckMinutes),
      blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('settingsGroup.execution')}<InfoTip text={t('executionStatusIntro')} /></h2>
          <Section title={t('workerModel')} hint={t('workerModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
          <Field label={t('stuckMinutes')} hint={t('stuckMinutesHint')}>
            <Input type="number" min={LIMITS.stuckMinutes.min} max={LIMITS.stuckMinutes.max} required value={value.stuckMinutes}
              onChange={event => edit({ stuckMinutes: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false}
              pattern="(?:/|[A-Za-z]:[/\\]).*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ExecutionHistory />
  </div>
}