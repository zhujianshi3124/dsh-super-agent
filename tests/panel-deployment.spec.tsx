// @vitest-environment jsdom
// The Deployment settings group (read-only, C-37f.3) and the Plugin Manager config page, where the DSH configuration is edited.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PluginConfig } from '../src/client/deployment.tsx'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, find, click, type, text, field, at, translator } from './fixtures/panel.tsx'
import { server, problemOf, fakeForm } from './fixtures/panel-server.ts'

usePanel()
/** Render the Plugin Manager config view; `mount` remounts from scratch as DSH does on navigation, `update` passes a newer form snapshot. */
function pluginRender() {
  let container = document.createElement('div')
  let root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const element = (view: 'page' | 'summary') => {
    const form = server.form
    return <PluginConfig t={translator(zh)} view={view} form={form && { state: form.getSnapshot(), mutate: form.mutate }} />
  }
  const mount = async (view: 'page' | 'summary' = 'page') => {
    act(() => { root.unmount() }); container.remove()
    container = document.createElement('div'); document.body.append(container)
    root = createRoot(container)
    await act(async () => { root.render(element(view)) })
    await settle()
    return container
  }
  const update = async (view: 'page' | 'summary' = 'page') => {
    await act(async () => { root.render(element(view)) })
    await settle()
  }
  return { mount, update }
}

it('saves this machine\'s limits through DSH\'s configuration form on the Plugin Manager page, without a restart', async () => {
  const { form: editable, mutations } = fakeForm()
  server.form = editable
  const { mount } = pluginRender()
  await mount()
  expect(text()).toContain('/srv/dsh-superagent')
  expect(text()).toContain('acme/widgets')
  // A limit applies at once, so a draft of one says only that it is unsaved, even while Assignments run.
  await type(field<HTMLInputElement>(zh.deploymentContextTimeout), '20000')
  expect(document.querySelector('.dt-savebar')?.textContent).toBe(`${zh.draftKept}${zh.discard}${zh.save}`)
  await click(zh.save)
  expect(mutations).toEqual([{ revision: 1, ops: [{ op: 'set', path: ['admissionContextTimeoutMs'], value: 20000 }] }])
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.saved)
  expect(text()).not.toContain(zh.savedRestarting)
  expect(field<HTMLInputElement>(zh.deploymentContextTimeout).value).toBe('20000')
})

it('keeps a refused Deployment change as a draft, and shows the limits read-only without a writable form', async () => {
  const refusing = fakeForm(true, false)
  server.form = refusing.form
  const { mount } = pluginRender()
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentPromptMaxChars), '200000')
  await click(zh.save)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(zh.deploymentRefused)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('200000')
  server.form = fakeForm(false).form
  await mount()
  expect(text()).toContain(zh.deploymentReadOnly)
  server.form = undefined
  await mount()
  expect(text()).toContain('这个 DSH 版本不提供配置表单')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars)).toMatchObject({ disabled: true, value: '100000' })
  expect(all('button').some(button => button.textContent === '保存')).toBe(false)
})

it('merges a Deployment draft into the values another page saved meanwhile, and writes only what it changed', async () => {
  const { form: shared, mutations } = fakeForm()
  server.form = shared
  const { mount, update } = pluginRender()
  await mount()
  await type(field<HTMLInputElement>(zh.deploymentContextPages), '20')
  // Another page saves another field of the same entry meanwhile; DSH passes the newer snapshot to the same page.
  await act(async () => { await shared.mutate([{ op: 'set', path: ['promptMaxChars'], value: 50000 }], 1) })
  await update()
  expect(text()).toContain('设置已在别处修改，你的修改已合并到最新版本')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).value).toBe('50000')
  await click(zh.save)
  expect(mutations.at(-1)).toEqual({ revision: 2, ops: [{ op: 'set', path: ['admissionContextMaxPages'], value: 20 }] })
  expect(shared.getSnapshot().value).toMatchObject({ admissionContextMaxPages: 20, promptMaxChars: 50000 })
})

it('folds the startup problems block away with its health list, and opens it again', async () => {
  server.health = { worker: { state: 'error', detail: 'executor stopped', at: '2026-09-22T00:00:00Z' } }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain(zh.deploymentHealth)
  expect(text()).toContain('executor stopped')
  await click(zh.startupProblems)
  // The check action stays in the header; only the body folds away.
  expect(text()).not.toContain(zh.deploymentHealth)
  expect(text()).not.toContain('executor stopped')
  expect(all('button').some(button => button.textContent === zh.setupCheck)).toBe(true)
  await click(zh.startupProblems)
  expect(text()).toContain(zh.deploymentHealth)
  expect(text()).toContain('executor stopped')
})

it('shows the panel Deployment group read-only with problems, health, state directory and limits, and accounts only in the Plugin Manager', async () => {
  server.health = { worker: { state: 'error', detail: 'executor stopped', at: '2026-09-22T00:00:00Z' } }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  expect(text()).toContain(zh.deploymentIntro)
  expect(text()).toContain('/srv/dsh-superagent')
  expect(text()).toContain('100000')
  expect(text()).toContain(zh.deploymentHealth)
  expect(text()).toContain('executor stopped')
  // The group only observes and re-checks; the limits themselves are edited in the DSH configuration.
  expect(all('input:not([type="search"])')).toHaveLength(0)
  expect(all('button').some(button => button.textContent === zh.setupCheck)).toBe(true)
  expect(text()).not.toContain('@agent-bot')
  const { mount: render } = pluginRender()
  const container = await render('summary')
  expect(container.textContent).toBe('')
  server.form = fakeForm().form
  await render('page')
  for (const fact of ['acme/widgets', '@agent-bot', 'Widgets Bot']) expect(text()).toContain(fact)
  server.setup = { ...server.setup, problem: problemOf('repositoryUnset'), accounts: null }
  await render('page')
  expect(text()).toContain('部署检查未通过：GitHub 来源没有设置监听的仓库。')
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(false)
  server.down = true
  await render('page')
  expect(text()).toContain(zh.hostNotRunning)
})

it('tells a dsh-superagent that is starting from a browser that cannot write on the Plugin Manager page', async () => {
  const { form: shared, publish } = fakeForm()
  server.form = shared
  const { mount, update } = pluginRender()
  await mount()
  const limit = () => field<HTMLInputElement>(zh.deploymentPromptMaxChars)
  expect(limit().disabled).toBe(false)
  // While dsh-superagent restarts, DSH stops serving its entry; the values come back editable once it is served again.
  await act(async () => { publish({ status: 'unavailable' }) })
  await update()
  expect(text()).toContain(zh.deploymentUnavailable)
  expect(limit().disabled).toBe(true)
  await act(async () => { publish({ status: 'ready' }) })
  await update()
  expect(limit().disabled).toBe(false)
  await act(async () => { publish({ mode: 'memory', status: 'unavailable', writable: false }) })
  await update()
  expect(text()).toContain(zh.deploymentReadOnly)
})

it('reads the state every second after a setup check, until dsh-superagent stopped answering and answers again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.load = { running: 0, queued: 0 }
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const second = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle() }
  server.down = true
  await second()
  expect(text()).toContain(zh['setup.agentCliUnset'])
  server.down = false
  server.setup = { ...server.setup, problem: null }
  await second()
  expect(text()).not.toContain(zh['setup.agentCliUnset'])
  // Once it answers, the state is read every five seconds again.
  const reads = server.requests.filter(request => request.path === 'state').length
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) }); await settle()
  expect(server.requests.filter(request => request.path === 'state')).toHaveLength(reads)
})

it('ends a restart that never stopped answering after half a minute, and reads the state every five seconds again', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  server.load = { running: 0, queued: 0 }
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  at({ page: 'settings', query: { group: 'deployment' } })
  await mount()
  await click(zh.setupCheck)
  const reads = () => server.requests.filter(request => request.path === 'state').length
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
  const before = reads()
  await advance(10_000)
  expect(reads() - before).toBeGreaterThanOrEqual(8)
  // The restart ends at 30 s; the state is read at once, then every five seconds.
  await advance(21_000)
  const ended = reads()
  await advance(3_000)
  expect(reads()).toBe(ended)
  await advance(2_000)
  expect(reads()).toBe(ended + 1)
})