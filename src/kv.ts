/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

/** A rotation request a plugin filed through `hooks.requestRotation`, kept until the host fulfils it. */
export interface RotationRequest { reason: string; summary?: string; handoffPath?: string; requestedBy: string; at: string }
/** Which Session currently fills a logical slot, its generation, the Sessions it succeeded, and any pending rotation. */
export interface RotationState { current: string; generation: number; previous: string[]; pending?: RotationRequest
  /** The last context ratio a plugin reported for this slot, which the panel shows as how full the session is. */
  usage?: { ratio: number; at: string }
  /** When this slot last changed hands, which the panel shows as the latest rotation. */
  rotatedAt?: string }
/** One startup adoption attempt per role slot: the Session it picked, whether it could be opened, and whether it was adopted. */
export interface RotationAdoption { at: string
  master?: { id: string; opened: boolean; adopted: boolean }
  foreman?: { id: string; opened: boolean; adopted: boolean }
  error?: string }

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /**
   * Rotation: the current Session of each logical slot (a ticket's worker, or the main Session) and its generation,
   * the earlier Sessions it succeeded, and a pending rotation request the host fulfils when the current task ends.
   */
  rotation: { worker: family<RotationState, [ticket: string]>('rotation-worker:'), master: record<RotationState>('rotation-master'),
    foreman: record<RotationState>('rotation-foreman'),
    /** What the last startup adoption attempt did, kept so a silent refusal can be read back from the database instead of from a log line nobody sees. */
    adopt: record<RotationAdoption>('rotation-adopt') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Wrap-up (C-17b): whether the person wrapped up and since when, kept across a shutdown, and the recent wrap-ups and starts of work. */
  wrapUp: { state: record<{ since: string }>('wrapup-state'), history: record<{ kind: 'wrap-up' | 'start-work'; at: string }[]>('wrapup-history') },
  /** Proposals: the last numbered instruction issued, so ids (`pr-1`, `pr-2`) never repeat. */
  proposals: { seq: record<number>('proposal-seq') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
}
