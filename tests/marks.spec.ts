import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { attentionLabel, healthDot, reportDot, stopLabel, stopTone, ticketMark } from '../src/client/marks.ts'
import type { T } from '../src/client/text.ts'

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T

it('marks each open Ticket stage as an observation, and an ended Ticket by its stop reason (N-07, N-13)', () => {
  const open = (['working', 'queued', 'adjudication', 'idle'] as const).map(stage => ticketMark(t, { stage, ended: undefined,
    stop: undefined, attention: undefined }))
  expect(open.map(({ label, tone, dot, icon }) => [label, tone, dot, icon])).toEqual([
    ['干活中', 'info', 'ongoing', 'running'], ['排队', 'neutral', 'idle', 'queue'],
    ['等用户裁决', 'warning', 'warning', 'ask'], ['空闲（回合之间）', 'neutral', 'idle', 'clock']])
  // An ended ticket is labelled by why it stopped; only a delivery is success and only a failure is danger.
  const stops = ['delivered', 'user-stopped', 'stuck', 'emergency', 'session-stopped', 'failed'] as const
  const ended = stops.map(stop => ticketMark(t, { stage: 'ended', ended: { at: '', by: stop === 'user-stopped' ? 'human' : 'executor',
    outcome: stop === 'delivered' ? 'completed' : 'stopped', stop }, stop, attention: undefined }))
  expect(ended.map(mark => mark.label)).toEqual(['交付', '用户叫停', '卡住被停', '紧急停止', '会话停止工作', '失败'])
  expect(ended.map(({ tone, dot, icon }) => `${tone} ${dot} ${icon}`)).toEqual(['success idle stop', 'neutral idle stop',
    'neutral idle stop', 'neutral idle stop', 'neutral idle stop', 'danger error stop'])
  expect(ticketMark(t, { stage: 'ended', ended: undefined, stop: undefined, attention: undefined }).label).toBe('已停止')
})

it('labels an adjudication by its C-15 kind, falling back to the generic word', () => {
  for (const kind of [2, 3, 4, 5, 6, 7] as const) expect(attentionLabel(t, kind)).toBe(zh[`attentionKind.${kind}`])
  expect(attentionLabel(t, undefined)).toBe('等用户裁决')
  expect(attentionLabel(t, 1)).toBe('等用户裁决')
  expect(attentionLabel(t, 9)).toBe('等用户裁决')
  const marked = ticketMark(t, { stage: 'adjudication', ended: undefined, stop: undefined, attention: { id: 'q1', kind: 5,
    question: '要删除文件吗' } })
  expect(marked.label).toBe('危险操作')
})

it('maps report states, health states and stop reasons to their indicators', () => {
  expect(['failed', 'blocked', 'waiting', 'ready', 'progress', undefined].map(reportDot)).toEqual(['error', 'warning', 'warning', 'done',
    'ongoing', 'ongoing'])
  expect((['error', 'paused', 'starting', 'ready'] as const).map(healthDot)).toEqual(['error', 'warning', 'ongoing', 'done'])
  expect((['delivered', 'user-stopped', 'stuck', 'emergency', 'session-stopped', 'failed', null] as const).map(stopTone))
    .toEqual(['success', 'neutral', 'neutral', 'neutral', 'neutral', 'danger', 'neutral'])
  expect(stopLabel(t, null)).toBe('正在工作')
  expect(stopLabel(t, 'delivered')).toBe('交付')
})