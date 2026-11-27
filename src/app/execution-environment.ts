/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import type { Localized, VariableSpec } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
export const EXECUTOR_VARIABLES: readonly (VariableSpec & { ticket?: true })[] = [
  { key: 'DSH_SUPERAGENT_DIR', ticket: true, description: { zh: '这个工单的执行目录；改动只落在它里面，Session 的当前目录是它的上级',
    en: 'This ticket\'s directory, where every change belongs; the Session\'s own current directory is its parent' } },
  { key: 'DSH_SUPERAGENT_NAME', ticket: true, description: { zh: '工单的短名，也是执行目录的名字', en: 'The ticket\'s short name, also its directory\'s name' } },
  { key: 'DSH_SUPERAGENT_TICKET', ticket: true, description: { zh: '工单 id', en: 'The ticket id' } },
  { key: 'DSH_SUPERAGENT_BLOCKED_COMMANDS', description: { zh: '这个执行环境禁止调用的命令，以空格分隔；不要运行它们', en: 'Commands blocked in this execution environment, separated by spaces; never run them' } },
]
export interface Variable { key: string; value: string; description: Localized; owner: string }

/**
 * The root every ticket gets its own subdirectory under. It is `D:/buzhiding` unless the person set another one in the panel:
 * a worker Session should land in the person's own directory out of the box, not in an internal state folder. `<stateDir>/work`,
 * which earlier versions wrote by themselves, counts as unset for the same reason.
 */
export const DEFAULT_WORKER_ROOT = 'D:/buzhiding'
/** Slash and case insensitive, so `<stateDir>/work` compares equal whether it was written by hand or by `join`. */
const samePath = (left: string, right: string): boolean => left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  === right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** The configured execution root; empty, or the old internal default, falls back to `DEFAULT_WORKER_ROOT`. A workspace an extension of an earlier version stored is never consulted. */
/** Whether `path` sits under the OS temporary directory, as every test state directory does. */
const underTemp = (path: string): boolean => path.replace(/\\/g, '/').toLowerCase()
  .startsWith(tmpdir().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
export const executionRoot = (settings: Settings, stateDir: string): string => {
  const saved = settings.executor.directory
  if (saved && !samePath(saved, join(stateDir, 'work'))) return saved
  // A test run must never write into the person's real root: a state directory under the OS temp directory falls back to its
  // own `work` folder, and only a real installation gets the person's own directory.
  return underTemp(stateDir) ? join(stateDir, 'work') : DEFAULT_WORKER_ROOT
}

/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. Without a registry, only the executor's own variables are listed. */
export function declaredVariables(sources?: SourceRegistry, settings?: Settings): { owner: string; enabled: boolean; variables: readonly VariableSpec[] }[] {
  if (!sources) return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES }]
  const on = new Set(sources.environments(settings).map(item => item.kind.kind))
  return [{ owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    ...sources.declarations().map(({ kind, variables }) => ({ owner: kind, enabled: on.has(kind), variables }))]
}

export function environmentOf(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket?: { id: string; name: string; directory: string }; trigger?: Trigger }): Variable[] {
  const { deployment, sources, settings, ticket, trigger } = input
  const executor: Record<string, string> = { DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(' '), ...ticket ? { DSH_SUPERAGENT_DIR: ticket.directory, DSH_SUPERAGENT_NAME: ticket.name, DSH_SUPERAGENT_TICKET: ticket.id } : {} }
  const result: Variable[] = EXECUTOR_VARIABLES.filter(spec => !spec.ticket || ticket).map(spec => ({ key: spec.key, value: executor[spec.key] ?? '', description: spec.description, owner: 'executor' }))
  for (const { kind, environment, config } of sources.environments(settings)) {
    const values = environment.values({ deployment, config, ...trigger ? { trigger } : {} })
    for (const spec of environment.variables) result.push({ key: spec.key, value: values[spec.key] ?? '', description: spec.description, owner: kind.kind })
  }
  return result
}

/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
export function ticketEnvironment(input: { deployment: Deployment; sources: SourceRegistry; settings: Settings; ticket: Ticket; trigger?: Trigger }) {
  const { ticket, trigger, ...rest } = input
  const values = { id: ticket.id, name: ticket.execution?.name ?? '', directory: ticket.execution?.directory ?? '' }
  return environmentOf({ ...rest, ticket: values, ...trigger ? { trigger } : {} })
}
export function environmentLines(variables: Variable[]): string {
  return variables.map(variable => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join('\n')
}
