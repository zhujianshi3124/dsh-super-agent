// @vitest-environment jsdom
// Panel shell: search (C-37g), glossary, route persistence, and host-down fallback.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, click, type, text, field } from './fixtures/panel.tsx'
import { server, found, actor } from './fixtures/panel-server.ts'

usePanel()
const submit = async (query: string) => {
  const search = field<HTMLInputElement>(zh.searchLabel)
  await type(search, query)
  await act(async () => { search.closest('form')!.requestSubmit() }); await settle()
}

it('states why a filtered search result has no ticket instead of opening an empty one', async () => {
  server.search = { tickets: [], proposals: [], threads: [], items: [found('e9', '2026-09-20T00:00:00Z', { source: 'github',
    actor: actor('github', 'someone'), preview: 'issue text', threads: ['github:7'], filtered: 'source_disabled' })] }
  await mount()
  await submit('issue')
  expect(text()).toContain('被来源过滤：来源已停用')
  expect(all('.dt-search-results button').some(button => button.textContent === 'issue text')).toBe(false)
})

it('opens the ticket a searched message reached, and counts tickets, instructions and own words', async () => {
  server.search = { tickets: [], proposals: [], threads: [], items: [found('e1', '2026-09-20T00:00:00Z',
    { disposition: { fanout: ['t1'] } })] }
  await mount()
  await submit('message')
  expect(text()).toContain('找到 0 张工单、0 份指令清单、1 条原话')
  await click(all('.dt-search-results button').find(button => button.textContent === 'message e1')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('explains what can be searched when nothing matches', async () => {
  await mount()
  await submit('nothing')
  expect(text()).toContain('没有找到。可以输入工单号')
})

it('returns to the exact page after a remount of the main panel', async () => {
  await mount()
  await click('修复回归')
  await remount()
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
})

it('shows domain terms in the interface language only and lists both languages in the (?) glossary', async () => {
  await mount(en)
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['Overview', 'Execution', 'Settings'])
  await click('Glossary')
  const dialog = document.querySelector('[role="dialog"]')!
  const row = [...dialog.querySelectorAll('tr')].find(item => item.querySelector('td')?.textContent === 'Ticket')!
  expect([...row.querySelectorAll('td')].map(cell => cell.textContent)).toEqual(['Ticket', '工单',
    'The smallest unit of dispatched work; only two states, working and stopped'])
  // Terms are grouped by the constitution's domain: roles, instructions, tickets, sessions.
  expect([...dialog.querySelectorAll('th.dt-glossary-group')].map(cell => cell.textContent)).toEqual(['Roles', 'Instructions', 'Tickets',
    'Sessions'])
  expect([...dialog.querySelectorAll('tr')].find(item => item.textContent?.startsWith('Main Session'))!.textContent)
    .toContain('never does the work itself')
  // The value lists name the stage observations, the six stop reasons and the instruction states in both languages.
  const values = dialog.querySelector('.dt-values')!
  expect(values.textContent).toContain('Working 干活中')
  expect(values.textContent).toContain('Delivered 交付')
  expect(values.textContent).toContain('Draft 草稿')
})

it('says dsh-superagent is not answering when its routes are gone, as while it restarts', async () => {
  server.down = true
  await mount()
  expect(text()).toContain(zh.hostNotRunning)
  expect(text()).not.toContain('404')
})

it('closes search results on Escape and on a click outside the search', async () => {
  await mount()
  const search = field<HTMLInputElement>(zh.searchLabel)
  await submit('nothing')
  expect(document.querySelector('.dt-search-results')).not.toBeNull()
  await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
  await submit('nothing')
  await act(async () => { document.querySelector('main')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
  expect(document.querySelector('.dt-search-results')).toBeNull()
})

it('shows the answer to the latest search only', async () => {
  server.search = { tickets: [], proposals: [], threads: [], items: [found('e1', '2026-09-20T00:00:00Z', { preview: 'old message' }),
    found('e2', '2026-09-21T00:00:00Z', { preview: 'new message' })] }
  let release = () => {}
  server.searching = async query => { if (query === 'old') await new Promise<void>(resolve => { release = resolve }) }
  await mount()
  for (const query of ['old', 'new']) await submit(query)
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
  await act(async () => { release() }); await settle()
  expect(all('.dt-search-results .dt-row-title').map(title => title.textContent)).toEqual(['new message'])
})