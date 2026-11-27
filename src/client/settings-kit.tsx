/** Shared settings context, block draft hook, form controls, and the execution save history with rollback (C-37f). */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText, valueLabel, when, type T } from './text.ts'
import { ConfirmButton, Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
  </div>
}
type RoleModel = Settings['executor']['model']
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  const fallback = catalog?.default
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input list={`${id}-${name}s`} spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>
  return <div className="dt-model">
    <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
      ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    <div className="dt-grid3">
      {input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
        t('modelEffort'), t('modelEffortDefault'))}
    </div>
    <datalist id={`${id}-providers`}>{catalog?.groups.map(group => <option key={group.id}
      value={group.id}>{group.name}</option>)}</datalist>
    <datalist id={`${id}-models`}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    <datalist id={`${id}-efforts`}>
      {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => <option key={effort.id}
        value={effort.id}>{effort.name}</option>)}
    </datalist>
  </div>
}

type HistoryItem = HistoryView['items'][number]
type HistoryChange = NonNullable<HistoryItem['changes']>[number]
/** One diff entry of the execution history, localized by its change code. */
function changeText(t: T, change: HistoryChange): string {
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue')
    : typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value)
  return t(`change.${change.code}`, { from: shown(change.from), to: shown(change.to) })
}
/**
 * Execution save history (C-37f): every revision with its diff, and a rollback that puts that revision's executor block
 * back through `PUT settings/executor` against the block's current revision; the restore itself is recorded as a new save.
 */
export function ExecutionHistory() {
  const { t, call, notify } = usePanel()
  const { settings, reload } = useSettings()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revision = settings.blocks.executor.revision
  useEffect(() => { if (open) call('GET settings/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revision])
  const restore = async (item: HistoryItem) => {
    const result = await call('PUT settings/:block', { block: 'executor', body: { value: item.executor, revision } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    await reload()
    setData(await call('GET settings/history'))
  }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {data.items.length ? <ul className="dt-timeline">{data.items.map(item => <li key={item.revision} className="dt-event">
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}{item.revision === data.current && <span className="dt-changed-tag">{t('historyCurrent')}</span>}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change)}</li>)}</ul>
            : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
          {item.revision !== data.current && <div className="dt-row-buttons">
            <ConfirmButton variant="outline" icon="history" label={t('historyRestore')} title={t('historyRestore')}
              message={t('historyRestoreConfirm', { revision: item.revision })} onConfirm={() => restore(item)} />
          </div>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}