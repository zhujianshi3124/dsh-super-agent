// @vitest-environment jsdom
// The Settings groups, drafts, save bars and the execution save history (C-37f, C-38.4).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Fields } from '../src/client/settings-kit.tsx'
import { expect, it, onTestFinished } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const executionSettings = async () => {
  await mount()
  await click(zh['tab.execution'])
  await click(find(zh['tab.settings'], '.dt-status-head button'))
}

it('keeps a person\'s own value where another save changed the same setting, and says so', async () => {
  await executionSettings()
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  server.settings = { ...server.settings, executor: { ...server.settings.executor, maxWorkers: 4 } }
  server.revisions.executor = 1
  await click(zh.save)
  expect(document.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe(zh.saveConflict)
  expect(field<HTMLInputElement>(zh.maxWorkers).value).toBe('6')
  await click(zh.save)
  expect(server.settings.executor.maxWorkers).toBe(6)
})

it('saves the Executor with its execution environment, inserting a picked variable at the caret', async () => {
  await executionSettings()
  await type(field<HTMLInputElement>(zh.maxWorkers), '5')
  // An empty root uses the default directory, which the field names instead of looking set.
  expect(field<HTMLInputElement>(zh.executionDirectory).closest('.dt-field')!.querySelector('small')?.textContent)
    .toBe('留空时用 D:/buzhiding')
  await type(field<HTMLInputElement>(zh.executionDirectory), '/srv/work')
  // A variable picked from the list goes where the caret is in the prepare command.
  const prepare = field<HTMLTextAreaElement>(zh.prepareCommand)
  await type(prepare, 'git worktree add ')
  prepare.setSelectionRange(17, 17)
  await click('可用的环境变量 3')
  expect(all('.dt-table tbody tr').map(row => row.textContent)).toEqual(['DSH_SUPERAGENT_DIR工单的执行目录',
    'DSH_SUPERAGENT_NAME工单短名', 'DSH_SUPERAGENT_GITHUB_REPOSITORY仓库'])
  await click('DSH_SUPERAGENT_DIR')
  expect(field<HTMLTextAreaElement>(zh.prepareCommand).value).toBe('git worktree add "$DSH_SUPERAGENT_DIR"')
  await type(field<HTMLInputElement>(zh.blockedCommands), 'gh-personal  gh.other')
  const [workerProvider, workerModel, effort] = all('.dt-model input')
  await type(workerProvider as HTMLInputElement, 'worker-provider'); await type(workerModel as HTMLInputElement,
    'worker-model'); await type(effort as HTMLInputElement, 'high')
  expect([...document.querySelectorAll('#dt-worker-model-efforts option')].map(option => option.getAttribute('value'))).toEqual(['high'])
  await click(zh.save)
  expect(server.settings.executor).toMatchObject({ maxWorkers: 5, directory: '/srv/work',
    prepare: 'git worktree add "$DSH_SUPERAGENT_DIR"', blockedCommands: ['gh-personal', 'gh.other'],
    model: { provider: 'worker-provider', model: 'worker-model', reasoningEffort: 'high' } })
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/executor'])
})

it('loads the execution history on demand with localized changes, and restores an earlier revision as a new save', async () => {
  const executor = { model: null, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [], stuckMinutes: 60 }
  server.history = { current: 3, items: [
    { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', block: 'executor',
      executor: { ...executor, maxWorkers: 5 }, paused: true, notified: [{ id: 't1', title: '修复回归' }],
      changes: [{ code: 'maxWorkers', from: 3, to: 5 }, { code: 'paused' }] },
    { revision: 2, savedAt: '2026-09-21T00:00:00Z', source: 'sync', block: 'executor', executor, paused: false,
      notified: [], changes: null }] }
  await executionSettings()
  expect(server.requests.some(request => request.path === 'settings/history')).toBe(false)
  await click(zh.configHistory)
  for (const expected of ['第 3 次保存 · 管理页', '当前', '并发上限：3 → 5', '暂停派新工单', '通知了 1 张进行中的工单：修复回归',
    '第 2 次保存 · 同步', '上一个版本没有记录，无法比较。']) expect(text()).toContain(expected)
  // Only a revision other than the current one offers a restore; it saves that revision's executor block back.
  expect(all('button').filter(button => button.textContent === zh.historyRestore)).toHaveLength(1)
  await click(zh.historyRestore)
  expect(text()).toContain('把执行设置回退到第 2 次保存的值？')
  await click(zh.confirm)
  expect(server.settings.executor.maxWorkers).toBe(2)
  expect(server.requests.some(request => request.path === 'settings/executor' && request.method === 'PUT')).toBe(true)
})

it('shows save and discard only while a settings block has edits, at the end of that block', async () => {
  await executionSettings()
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  expect(all('.dt-savebar')).toHaveLength(1)
  await type(field<HTMLInputElement>(zh.maxWorkers), '3')
  expect(all('.dt-savebar')).toHaveLength(0)
  await type(field<HTMLInputElement>(zh.maxWorkers), '6')
  await click(zh.discard)
  expect(all('.dt-savebar')).toHaveLength(0)
  // A save submitted from a field keeps the focus there; one from the bar hands it to the block when the bar closes.
  const workers = field<HTMLInputElement>(zh.maxWorkers)
  await type(workers, '5')
  workers.focus()
  await act(async () => { workers.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.executor.maxWorkers).toBe(5)
  expect(document.activeElement).toBe(workers)
  await type(workers, '4')
  const save = find(zh.save)
  save.focus()
  await click(save)
  expect(all('.dt-savebar')).toHaveLength(0)
  expect(document.activeElement).toBe(workers.form)
})

it('gives the focus back to the field that had it once a block\'s save ends', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  const render = (disabled: boolean) => act(async () => { root.render(<Fields disabled={disabled}><input aria-label="value" /></Fields>) })
  await render(false)
  const input = container.querySelector('input')!
  input.focus()
  await render(true)
  // jsdom does not blur a control when it becomes disabled; move focus away manually.
  const elsewhere = document.createElement('button'); document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
  expect(document.activeElement).toBe(document.body)
  await render(false)
  expect(document.activeElement).toBe(input)
})

it('lists the three settings groups, opens each from its place, and returns to the last group opened', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  expect(all('.dt-settings-link').map(link => link.textContent)).toEqual(['执行', '提示词', '部署'])
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
  await click(find(zh['settingsGroup.prompts'], '.dt-settings-link'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.prompts'])
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.deployment'])
  // The Execution status opens its own group; a remount returns to the last group opened.
  await click(tab(zh['tab.execution']))
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.execution'])
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  await remount()
  await click(tab(zh['tab.settings']))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
})