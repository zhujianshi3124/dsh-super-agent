/**
 * Where a worker Session lands (N-10): every ticket's worker is created in the one workspace of the execution root, and the
 * ticket works in that root itself — no forced per-ticket subdirectory, so the person's sidebar gains no workspace per ticket
 * and several tickets may share the one directory (C-13). The worker is told to change nothing outside the directory the
 * environment names as `DSH_SUPERAGENT_DIR`.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executionRoot } from '../src/app/execution-environment.ts'
import { WORKER_PRESET } from '../src/app/sessions.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

/** One `sessionController.create` call, as the fixture recorded it. */
interface CreateCall { sessionId: string; workspaceId: string; agentPreset?: string; cwd?: string }
const creates = (fixture: Host): CreateCall[] =>
  (fixture.controller.create.mock.calls as unknown as [CreateCall][]).map(([options]) => options)
const created = (fixture: Host, sessionId: string): CreateCall | undefined => creates(fixture).find(call => call.sessionId === sessionId)

describe('a worker Session\'s workspace', () => {
  it('is the execution root, and the ticket works in that root itself (N-10)', async () => {
    const fixture = host = await startRuntime()
    const root = executionRoot(fixture.runtime.store.settings(), fixture.directory)
    // A test run keeps its tickets inside its own temporary state directory, never in the person's `D:/buzhiding`.
    expect(root).toBe(join(fixture.directory, 'tickets'))
    const { ticket } = await fixture.acceptedTicket(feishu('1', '@bot 修一下回归'))
    // N-10: no forced per-ticket subdirectory; the ticket's directory is the execution root itself.
    expect(ticket.execution?.directory).toBe(root)
    const call = created(fixture, `worker-${ticket.id}`)!
    expect(call.workspaceId).toBe(root)
    expect(call.agentPreset).toBe(WORKER_PRESET)
    // DSH refuses a session created with a workspace and a cwd at once, so only the workspace is passed.
    expect(call).not.toHaveProperty('cwd')
  })

  it('is the same one workspace and directory for every ticket, so the sidebar gains none per ticket', async () => {
    const fixture = host = await startRuntime()
    const root = executionRoot(fixture.runtime.store.settings(), fixture.directory)
    const first = await fixture.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const second = await fixture.acceptedTicket(feishu('2', '@bot 再改一处错字'))
    // The registry is asked for one path only, and DSH's registry is idempotent in it: the installation keeps one workspace.
    // The foreman's own fixed workspace is registered as well; no ticket ever adds one of its own.
    const asked = fixture.workspaceRegistry.create.mock.calls.map(([cwd]) => cwd)
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked)).toEqual(new Set([root, fixture.runtime.foremanWorkspace]))
    // Both workers were created in it, and both tickets share the one directory (C-13); conflicts are the foreman's to prevent.
    const workspaces = [`worker-${first.ticket.id}`, `worker-${second.ticket.id}`].map(id => created(fixture, id)!.workspaceId)
    expect(workspaces).toEqual([root, root])
    expect(new Set([first.ticket.execution!.directory, second.ticket.execution!.directory])).toEqual(new Set([root]))
  })

  it('tells the worker to change nothing outside the directory the environment names', async () => {
    const fixture = host = await startRuntime()
    const { ticket } = await fixture.acceptedTicket(feishu('1', '@bot 修一下回归'))
    const directory = ticket.execution!.directory
    // The variables the prepare command and the worker read name the ticket's working directory.
    expect(fixture.runtime.ticketEnvironment(ticket).find(variable => variable.key === 'DSH_SUPERAGENT_DIR')?.value).toBe(directory)
    const prompt = fixture.sections.get(`worker-${ticket.id}`)!({}).replace(/\s+/g, ' ')
    expect(prompt).toContain('DSH_SUPERAGENT_DIR')
    // The prompt renders each value as JSON, so a Windows path keeps its doubled backslashes.
    expect(prompt).toContain(JSON.stringify(directory))
    expect(prompt).toContain('Work only inside your ticket\'s working directory, whose path the execution environment gives as DSH_SUPERAGENT_DIR')
    expect(prompt).toContain('several tickets can share it, and the foreman orders the work to avoid conflicts (N-10, C-13)')
    expect(prompt).toContain('Create, change and delete no file outside it')
  })
})
