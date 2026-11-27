/**
 * Deployment settings group (C-37f.3): startup problems and re-check, the state directory, and machine limits — read-only in
 * the panel, no save; the limits themselves are edited in the DSH configuration (the Plugin Manager config page keeps the form).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { Dot, InfoTip, Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { healthDot } from './marks.ts'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { healthText, setupText, valueLabel, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, Section, SetupMessage, When } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** The panel's deployment group: problems, health, state directory, machine limits; the only action is the re-check (C-38.4). */
export function DeploymentPage({ setup }: { setup: SetupView; form?: DeploymentForm }) {
  const { t } = usePanel()
  const { state } = usePanelData()
  const health = Object.entries(state?.health ?? {})
  return <div className="dt-form">
    <Hint>{t('deploymentIntro')}</Hint>
    <Section title={t('startupProblems')} action={<CheckSetupButton />} collapsible>
      {setup.problem && <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p>}
      {setup.feishuProblem && <p className="dt-error" role="status"><SetupMessage problem={setup.feishuProblem} lead /></p>}
      {!setup.problem && !setup.feishuProblem && <Hint>{t('none')}</Hint>}
      {health.length > 0 && <>
        <div className="dt-subhead"><span className="dt-field-head">{t('deploymentHealth')}</span></div>
        <ul className="dt-list">{health.map(([name, entry]) => <li key={name} className="dt-row">
          <Dot state={healthDot(entry.state)} />
          <div className="dt-row-main">
            <div className="dt-row-title">{valueLabel(t, 'health', name)}</div>
            <div className="dt-row-meta"><span>{healthText(t, entry)}</span>{entry.at && <When at={entry.at} />}</div>
          </div>
        </li>)}</ul>
      </>}
    </Section>
    <Section title={t('deploymentStateDir')} hint={t('deploymentStateDirHint')}>
      <span className="dt-mono">{setup.machine.stateDir}</span>
    </Section>
    <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
      <KeyValues rows={[[t('deploymentPromptMaxChars'), <span className="dt-mono">{setup.machine.promptMaxChars}</span>],
        [t('deploymentContextPages'), <span className="dt-mono">{setup.machine.admissionContextMaxPages}</span>],
        [t('deploymentContextTimeout'), <span className="dt-mono">{setup.machine.admissionContextTimeoutMs}</span>]]} />
    </Section>
  </div>
}

/** Machine-limit form for the DSH Plugin Manager config page, where the DSH configuration itself is edited. */
function MachineForm({ setup, form }: { setup: SetupView; form: DeploymentForm }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  const accounts = setup.accounts
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
      </Section>
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin Manager config page; includes derived repository and accounts because they live in the DSH configuration. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <MachineForm setup={state.setup} form={form} />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}