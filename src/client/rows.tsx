/** Shared ticket list row (C-37.1, C-37d.3): stage, title, undelivered count, note, time; actions are stop and open session only. */
import { useState } from 'react'
import type { TicketRow } from './api.ts'
import { ticketMark } from './marks.ts'
import { usePanel } from './provider.tsx'
import { readableMarkers } from './text.ts'
import { ConfirmButton, LabelValue, SessionButton, StageMark, When } from './widgets.tsx'

export function TicketLine({ ticket, question, onChanged }: {
  ticket: TicketRow; question?: boolean; onChanged?: () => Promise<void>
}) {
  const { t, call, navigate } = usePanel()
  const status = ticketMark(t, ticket)
  const after = async (request: Promise<unknown>) => { await request; await onChanged?.() }
  const note = ticket.note && { ...ticket.note, text: readableMarkers(t, ticket.note.text) }
  return <li className="dt-row dt-link dt-ticket" data-state={question ? status.dot : undefined}>
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: ticket.id })}>{ticket.title}</button></div>
      <div className="dt-row-meta dt-ticket-meta">
        {ticket.undelivered > 0 && <LabelValue label={t('ticketUndeliveredLabel')} value={ticket.undelivered} />}
        {note && <span className={note.error ? 'dt-ticket-note dt-ticket-note-error' : 'dt-ticket-note'} title={note.text}>{note.text}</span>}
        <When at={ticket.updatedAt} />
      </div>
      {/* C-38: every row offers stop (while the ticket is open) and open session; nothing else. */}
      <div className="dt-ticket-actions">{onChanged && <>
        {ticket.actions.stop && <ConfirmButton variant="outline" icon="stop" label={t('stop')} title={t('stopConfirmTitle')}
          message={t('stopConfirm', { title: ticket.title })}
          onConfirm={() => after(call('POST tickets/:id/stop', { id: ticket.id }))} />}
        {ticket.sessionId && <SessionButton variant="outline" sessionId={ticket.sessionId} />}
      </>}</div>
    </div>
  </li>
}

type Run<I> = { item: I; earlier: I[] }
/** Group consecutive automated items from the same sender so only the newest is shown by default. */
export function automatedRuns<I>(items: I[], sender: (item: I) => string | undefined): Run<I>[] {
  const runs: Run<I>[] = []
  for (const item of items) {
    const last = runs.at(-1), from = sender(item)
    if (last && from !== undefined && sender(last.item) === from) last.earlier.push(item)
    else runs.push({ item, earlier: [] })
  }
  return runs
}
export function Earlier({ items }: { items: { id: string; at: string; preview: string }[] }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return <div>
    <button type="button" className="dt-textlink" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t('collapse') : t('automatedEarlier', { count: items.length })}
    </button>
    {open && <ul className="dt-plain-list dt-hint">{items.map(item => <li key={item.id}><When
      at={item.at} /> · {readableMarkers(t, item.preview) || t('empty')}</li>)}</ul>}
  </div>
}