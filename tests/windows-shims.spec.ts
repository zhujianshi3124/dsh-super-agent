/**
 * Windows only: the agent CLI setup takes there, and how the shells a worker may use find the agent's CLIs and run the shims.
 * DSH's command tool runs PowerShell; a worker may start cmd or Git Bash from it. No shim runs `gh` or `lark-cli` on Windows, so
 * each shell finds them by name in their own directories, right after the shims; a command that only fails has a form for each.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executable, type Deployment } from '../src/deployment.ts'
import { accountVariables, applyEnvironment, cliDirectories, workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

// Each case starts shells, which can take seconds when the suite runs in parallel.
vi.setConfig({ testTimeout: 60_000 })
const exec = promisify(execFile)
const windows = process.platform === 'win32'
/** The first file named `name` in a directory on PATH. */
const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name)).find(file => existsSync(file))
/** Git Bash, from git's own installation: a `bash` on PATH may be WSL's. */
function gitBash(): string | undefined {
  try { return resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe') } catch { return undefined }
}
// DSH's command tool sets PowerShell's output to UTF-8 so before each command.
const UTF8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** A shell a worker may run a command in, started as DSH or a worker starts it, and a command that prints where it finds `gh`, then `GH_CONFIG_DIR`. */
interface Shell { name: string; file: string | undefined; args: (command: string) => string[]; find: string }
const SHELLS: Shell[] = [
  // DSH's command tool runs PowerShell 7 so, or Windows PowerShell 5.1 where 7 is missing.
  { name: 'PowerShell 7', file: windows ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')].find(existsSync) ?? onPath('pwsh.exe') : undefined,
    args: command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', UTF8 + command], find: '(Get-Command gh).Source; $env:GH_CONFIG_DIR' },
  // RemoteSigned, which the shims need (docs/006, Setup checks), so that a stricter policy on the machine does not decide the case.
  { name: 'Windows PowerShell 5.1', file: windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
    args: command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', UTF8 + command], find: '(Get-Command gh).Source; $env:GH_CONFIG_DIR' },
  { name: 'cmd', file: windows ? process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe') : undefined,
    args: command => ['/d', '/s', '/c', command], find: 'where gh & echo %GH_CONFIG_DIR%' },
  { name: 'Git Bash', file: windows ? gitBash() : undefined, args: command => ['-c', command], find: 'cygpath -w "$(command -v gh)"; echo "$GH_CONFIG_DIR"' },
]

describe.skipIf(!windows)('on Windows', () => {
  let dir: string
  let restore: (() => void) | undefined
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-shims-')) })
  afterEach(() => { restore?.(); restore = undefined; rmSync(dir, { recursive: true, force: true }) })
  /** Writes the worker environment and applies it to this process as setup does, so that the shells a case starts inherit it. */
  async function setUp(deployment: Deployment): Promise<void> {
    await writeEnvironment(deployment, ['personal-gh'])
    restore = applyEnvironment(accountVariables(deployment), deployment.stateDir, [...cliDirectories(deployment), process.env.PATH ?? ''].join(delimiter))
  }
  /** Runs `command` in `shell` from the case's directory, resolving with its exit code, as the command tool reports it. */
  async function run(shell: Shell, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try { return { code: 0, ...await exec(shell.file!, shell.args(command), { cwd: dir, timeout: 30_000 }) } }
    catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string }
      if (typeof failed.code !== 'number') throw error
      return { code: failed.code, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
    }
  }

  it('setup takes as the agent CLI a `.com` or `.exe` program, by command name on PATH or by absolute path, with or without its extension', () => {
    const bin = join(dir, 'bin'), shims = workerBin(dir)
    mkdirSync(bin); mkdirSync(shims)
    for (const name of ['gh.exe', 'gh.cmd', 'gh.ps1', 'gh-wrapper']) writeFileSync(join(bin, name), '')
    writeFileSync(join(shims, 'gh.exe'), '')
    const path = [shims, bin].join(delimiter)
    // As Windows does, a name without either extension finds the program; the shim directory is skipped.
    expect(executable('gh', path, shims)).toBe(join(bin, 'gh.exe'))
    expect(executable(join(bin, 'gh'), '')).toBe(join(bin, 'gh.exe'))
    writeFileSync(join(bin, 'gh.com'), '')
    expect(executable('gh', path, shims)).toBe(join(bin, 'gh.com'))
    // A batch file or a script needs a shell to run, which would parse the arguments, such as a comment's text.
    expect(() => executable('gh.cmd', path)).toThrow('gh.cmd is a script, which dsh-superagent cannot run without a shell; on Windows, name a program such as gh.exe')
    expect(() => executable(join(bin, 'gh.ps1'), '')).toThrow(`${join(bin, 'gh.ps1')} is a script`)
    expect(() => executable('bin\\gh.exe', path)).toThrow('bin\\gh.exe must be a command name or an absolute path')
    expect(() => executable('bin/gh.exe', path)).toThrow('bin/gh.exe must be a command name or an absolute path')
    // An extensionless file, such as a `#!/bin/sh` wrapper, is no program Windows can start.
    expect(() => executable('gh-wrapper', path)).toThrow('gh-wrapper is not an executable file on PATH')
    expect(() => executable(join(bin, 'gh-wrapper'), '')).toThrow(`${join(bin, 'gh-wrapper')} is not an executable file`)
  })

  for (const shell of SHELLS) {
    describe.skipIf(!shell.file || !existsSync(shell.file))(shell.name, () => {
      it('runs the failing form of a blocked command, and of lark-cli without a Feishu bot, which exit with 1 and say why', async () => {
        // A login GitHub would not issue, so that the shell reads the message's quoting (environment.spec.ts shows the forms).
        const github = { ...testDeployment().github, login: "o'neil & co (100%)" }
        await setUp(testDeployment({ stateDir: dir, github, feishu: undefined }))
        const blocked = await run(shell, 'personal-gh x')
        expect(blocked.code).toBe(1)
        expect(blocked.stderr).toContain('personal-gh is blocked in this installation; use gh, which acts as o\'neil & co (100%).')
        const lark = await run(shell, 'lark-cli im +chat-list')
        expect(lark.code).toBe(1)
        expect(lark.stderr).toContain('lark-cli is unavailable: this installation has no Feishu bot.')
      })
      it('finds the agent\'s gh by name in its own directory, with the agent\'s gh configuration directory', async () => {
        // Only found, never run: an empty file will do.
        const cli = join(dir, 'GitHub CLI', 'gh.exe'), configDir = join(dir, 'agent config')
        mkdirSync(join(dir, 'GitHub CLI')); writeFileSync(cli, '')
        await setUp(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli, configDir }, feishu: undefined }))
        const { code, stdout } = await run(shell, shell.find)
        expect(code).toBe(0)
        const lines = stdout.trim().split(/\r?\n/)
        // Git Bash may name the program without its extension.
        const program = (file: string): string => file.replace(/\.exe$/i, '').toLowerCase()
        expect(program(lines[0]!)).toBe(program(cli))
        expect(lines.at(-1)).toBe(configDir)
      })
    })
  }
})
