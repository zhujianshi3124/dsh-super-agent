/** Settings view: the execution block the panel edits (C-37f), and the execution environment details. */
import { KV } from '../../kv.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
/**
 * Builds the settings view: the execution block (`{ value, revision }`) and execution environment details
 * (`stateDir` provides the default ticket working directory root). Prompts and deployment have their own pages.
 */
export function settingsView(store: Store, stateDir: string) {
  const settings = store.settings()
  return {
    blocks: { executor: { value: settings.executor, revision: store.blockRevision('executor') } },
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(undefined, settings) },
    history: { current: store.get(KV.settings.revision) ?? 0 },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
