/** Execution settings history: saved revisions with their diffs and the values a rollback restores (C-37f: every group keeps history). */
import { KV } from '../kv.ts'
import type { Store, SettingsVersion } from './store.ts'

/** Change codes localized by the web panel as `change.<code>`. */
export type SettingsChangeCode = 'executorModel' | 'maxWorkers' | 'paused' | 'resumed' | 'executionDirectory' | 'prepareCommand'
  | 'blockedCommands' | 'stuckMinutes'
/** A single settings diff entry rendered by the panel using `change.<code>`. */
export interface SettingsChange {
  code: SettingsChangeCode; from?: string | number | boolean; to?: string | number | boolean
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** The execution block and the pause flag are what the panel edits (C-37f, C-38.4); their changes are what history shows. */
function settingsChanges(before: SettingsVersion['settings'], after: SettingsVersion['settings']): SettingsChange[] {
  const changes: SettingsChange[] = []
  if (!same(before.executor.model, after.executor.model)) changes.push({ code: 'executorModel' })
  if (before.executor.maxWorkers !== after.executor.maxWorkers) changes.push({ code: 'maxWorkers', from: before.executor.maxWorkers, to: after.executor.maxWorkers })
  if (before.paused !== after.paused) changes.push({ code: after.paused ? 'paused' : 'resumed' })
  if (before.executor.directory !== after.executor.directory) changes.push({ code: 'executionDirectory', from: before.executor.directory, to: after.executor.directory })
  if (before.executor.prepare !== after.executor.prepare) changes.push({ code: 'prepareCommand' })
  if (!same(before.executor.blockedCommands, after.executor.blockedCommands)) changes.push({ code: 'blockedCommands', from: before.executor.blockedCommands.join(' '), to: after.executor.blockedCommands.join(' ') })
  if ((before.executor.stuckMinutes ?? 60) !== (after.executor.stuckMinutes ?? 60)) changes.push({ code: 'stuckMinutes', from: before.executor.stuckMinutes ?? 60, to: after.executor.stuckMinutes ?? 60 })
  return changes
}
/**
 * Recent settings revisions newest-first, each with its diff, the tickets it notified, and the execution block it saved —
 * the value a rollback puts back through `PUT settings/executor` (C-37f).
 */
export function executionHistory(store: Store) {
  const versions = store.settingsHistory(30)
  return { current: store.get(KV.settings.revision) ?? 0,
    items: versions.map((version, index) => {
      const previous = versions[index + 1]
      return { revision: version.revision, savedAt: version.savedAt, source: version.source, block: version.block,
        executor: version.settings.executor, paused: version.settings.paused,
        notified: version.notified.map(id => ({ id, title: store.tickets.get(id)?.title ?? id })),
        changes: previous && previous.revision === version.revision - 1 ? settingsChanges(previous.settings, version.settings) : null }
    }) }
}
export type HistoryView = ReturnType<typeof executionHistory>