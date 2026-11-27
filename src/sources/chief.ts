/** The chief Source: the messages the person writes in the main Session they opened, with no network and no bot. */
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { SourceKind } from './kind.ts'

export const CHIEF = 'chief'
/** The sender this Source's Policy lists when an installation stored none: the person who owns the main Session. */
export const CHIEF_PRINCIPAL = 'chief-owner'
/**
 * The stored configuration of the chief Source. An installation that ran the extension version of this Source holds its
 * keys (`chiefSessionId`, `chiefWorkspace`, `listen`, …); the kind no longer reads them, but keeps them so the Source stays
 * enabled and the person's stored settings are not rewritten.
 */
export const ChiefConfigSchema = z.object({
  /** The person's identity in this Source; empty reads the first sender the Policy lists. */
  principal: z.string().default(''),
}).catchall(z.unknown())
export type ChiefConfig = z.infer<typeof ChiefConfigSchema>
/** The Trigger id of message `messageId` in the main Session `sessionId`: the same on every read of that message. */
export const chiefTriggerId = (sessionId: string, messageId: string): string => key('chief-msg', sessionId, messageId)
/** The person the main Session belongs to, as the Policy's list of senders names them; empty when neither names one. */
export const chiefPrincipal = (config: ChiefConfig, part: { allowed: { id: string }[] } | undefined): string =>
  config.principal.trim() || part?.allowed[0]?.id || ''
/**
 * The chief Source. Its Triggers come from `ChiefSource`, which watches the main Session the person opened: it records what
 * they write and creates no Session of its own. The Policy's `allowed` list names the person, since a message this Source
 * attributes to anyone else is refused as `not_a_member`.
 */
export const chiefKind: SourceKind<ChiefConfig> = {
  kind: CHIEF,
  title: { zh: '主会话（我自己）', en: 'The main Session' },
  description: {
    zh: '我自己开的主会话：我在这个窗口里交代的事，从这里变成工单。没有网络、没有机器人，也不会替我建会话。',
    en: 'The main Session I opened: what I ask for in this window starts tickets from here. No network, no bot, and it never opens a Session for me.',
  },
  schema: ChiefConfigSchema,
  fields: [{ key: 'principal', type: 'text', label: { zh: '发起人 id', en: 'Sender id' },
    hint: { zh: '留空就用政策里列出的第一个发送者。写一个政策里没有的 id，这个来源的消息都会被拒收。', en: 'Empty uses the first sender the Policy lists. An id the Policy does not list makes this Source refuse its own messages.' } }],
  health: ['chief'],
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().optional() }).strict())
      .default([{ id: CHIEF_PRINCIPAL, name: '主会话' }]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的人', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者 id', en: 'Sender id' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '用户在他自己开的主会话里直接交代任务。', en: 'The person gives a task directly in the main Session they opened.' },
  },
}
