/** Overview page (C-37): pending adjudications, system problems, executor load, instructions, main Session, foreman.
 * Event blocks take no space when all is quiet; collapsing a seen problem is purely client-side (C-38.6). */
import { useState, type ReactNode } from 'react'
import { usePoll, type OverviewView, type Problem } from './api.ts'
import { Button, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { TicketLine } from './rows.tsx'
import { when } from './text.ts'
import { Hint, LoadState, Section, SessionButton } from './widgets.tsx'

/** A session id shortened for a one-line stat; the full id stays in the title attribute. */
const shorten = (id: string): string => id.length > 26 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id
const usageText = (usage: number | null, unknown: string): string => usage === null ? unknown : `${Math.round(usage * 100)}%`

// C-38.6: collapsing a seen problem changes no host state and makes no decision; it is remembered in this browser only.
const COLLAPSE_KEY = 'dsh-superagent/collapsed-problems'
const problemKey = (problem: Problem): string => `${problem.kind}:${problem.workspace}`
function readCollapsed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}
function writeCollapsed(keys: string[]): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(keys)) } catch { /* Convenience only; the list stays in memory. */ }
}

function ProblemLine({ problem, collapsed, onCollapse, onShowAgain }: {
  problem: Problem; collapsed?: boolean; onCollapse: () => void; onShowAgain?: () => void
}) {
  const { t, navigate } = usePanel()
  const title = problem.kind === 'no-master' ? t('problemNoMaster', { workspace: problem.workspace })
    : t('problemNoForeman', { workspace: problem.workspace })
  const hint = problem.kind === 'no-master' ? t('problemNoMasterHint') : t('problemNoForemanHint')
  return <li className={`dt-row dt-link dt-att dt-att-error${collapsed ? ' dt-event-quiet' : ''}`}>
    <div className="dt-row-main">
      <div className="dt-att-what"><button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(settingsRoute('deployment'))}>{title}</button></div>
      <Hint>{hint}</Hint>
      <div className="dt-row-meta dt-row-buttons">
        {collapsed
          ? onShowAgain && <Button variant="ghost" size="sm" icon={<Icon name="chevron-down" size={14} />}
            onClick={onShowAgain}>{t('problemShowAgain')}</Button>
          : <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('problemCollapse')}
            title={t('problemCollapseHint')} onClick={onCollapse}>{t('collapse')}</Button>}
      </div>
    </div>
  </li>
}

export function OverviewPage() {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed)
  const [showCollapsed, setShowCollapsed] = useState(false)
  const collapse = (problem: Problem) => {
    const next = [...new Set([...collapsed, problemKey(problem)])]
    setCollapsed(next); writeCollapsed(next)
  }
  const showAgain = (problem: Problem) => {
    const next = collapsed.filter(key => key !== problemKey(problem))
    setCollapsed(next); writeCollapsed(next)
  }
  if (!data) return <LoadState error={error} loading />
  const visible = data.problems.filter(problem => !collapsed.includes(problemKey(problem)))
  const hidden = data.problems.filter(problem => collapsed.includes(problemKey(problem)))
  const load = data.executor
  const quiet = !data.person.length && !data.problems.length && !load.running && !load.queued && !data.proposals.length
  const stat = (label: string, value: ReactNode) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value}</span>
  </span>
  const more = <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate({ page: 'execution' })}>{t('tab.execution')}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    {quiet && <Hint>{t('overviewQuiet')}</Hint>}
    {/* 1. Pending: only tickets that need the person's adjudication, each labelled by its C-15 kind (C-37.1). */}
    {data.person.length > 0 && <Section title={t('pendingTickets')} count={data.person.length} hint={t('pendingTicketsHint')} collapsible>
      <ul className="dt-list dt-cards">{data.person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
    </Section>}
    {/* 2. System problems: a missing main Session or foreman; seen ones may be collapsed without changing any state. */}
    {(visible.length > 0 || hidden.length > 0) && <Section title={t('problems')} count={visible.length}>
      {visible.length > 0 && <ul className="dt-list dt-cards">{visible.map(problem => <ProblemLine key={problemKey(problem)}
        problem={problem} onCollapse={() => collapse(problem)} />)}</ul>}
      {hidden.length > 0 && <>
        <button type="button" className="dt-textlink" aria-expanded={showCollapsed} onClick={() => setShowCollapsed(!showCollapsed)}>
          {showCollapsed ? t('problemCollapsedHide', { count: hidden.length }) : t('problemCollapsedShow', { count: hidden.length })}
        </button>
        {showCollapsed && <ul className="dt-list dt-cards">{hidden.map(problem => <ProblemLine key={problemKey(problem)}
          problem={problem} collapsed onCollapse={() => collapse(problem)} onShowAgain={() => showAgain(problem)} />)}</ul>}
      </>}
    </Section>}
    {/* 3. Executor: how many tickets run at once and how many queue; nothing when idle. */}
    {(load.running > 0 || load.queued > 0) && <Section title={t('term.executor')} action={more}>
      <div className="dt-stats">
        {stat(t('executingLabel'), `${load.running} / ${load.maxWorkers}`)}
        {stat(t('queuedLabel'), load.queued)}
      </div>
    </Section>}
    {/* 4. Instructions: number, state, task count, the person's own words; each opens its full text (C-37.4). */}
    {data.proposals.length > 0 && <Section title={t('proposals')} count={data.proposals.length} collapsible>
      <ul className="dt-list dt-cards">{data.proposals.map(proposal => <li key={proposal.id} className="dt-row">
        <div className="dt-row-main">
          <div className="dt-row-title"><button type="button" className="dt-open"
            onClick={() => navigate({ page: 'proposal', id: proposal.id })}>{proposal.id} · {t(`proposalStatus.${proposal.status}`)}
            · {t('proposalTasksCount', { count: proposal.tasks })}</button></div>
          <p className="dt-row-quote">{proposal.heard}</p>
        </div>
      </li>)}</ul>
    </Section>}
    {/* 5. Main Session: which one, its generation, and how much context it has used (C-37.5). */}
    <Section title={t('mainSession')}>
      <div className="dt-stats">
        {stat(t('mainSessionCurrent'), <span className="dt-mono" title={data.master.id}>{data.master.id ? shorten(data.master.id)
          : t('empty')}</span>)}
        {stat(t('foremanGeneration'), t('mainSessionGenerationValue', { generation: data.master.generation + 1 }))}
        {stat(t('contextUsage'), usageText(data.master.usage, t('usageUnknown')))}
        {data.master.id && <SessionButton variant="outline" sessionId={data.master.id} />}
      </div>
    </Section>
    {/* 6. Foreman: generation, context usage, last rotation, and whether a rotation waits (C-37.6). */}
    <Section title={t('foreman')}>
      <div className="dt-stats">
        {stat(t('foremanSession'), <span className="dt-mono" title={data.foreman.session}>{data.foreman.session
          ? shorten(data.foreman.session) : t('empty')}</span>)}
        {stat(t('foremanGeneration'), t('foremanGenerationValue', { generation: data.foreman.generation + 1 }))}
        {stat(t('contextUsage'), usageText(data.foreman.usage, t('usageUnknown')))}
        {data.foreman.rotatedAt && stat(t('foremanRotatedAt'), when(data.foreman.rotatedAt, t('lang')))}
        {data.foreman.pending && <span className="dt-stat"><span className="dt-stat-label">{t('foremanPending')}</span>
          <span className="dt-stat-value" title={t('foremanPendingHint')}>{t('yes')}</span></span>}
        {data.foreman.session && <SessionButton variant="outline" sessionId={data.foreman.session} />}
      </div>
    </Section>
  </>
}