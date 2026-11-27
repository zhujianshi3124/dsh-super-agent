/** Hot-swappable extension loader.

 * Watches a directory of ESM plugins and mounts each one with `ctx.plugin()`. Adding a
 * `.mjs` file loads it, editing a file or its sibling `.json` config reloads it, and
 * deleting a file disposes its fiber. Nothing here requires a process restart: cordis
 * resolves `inject` dependencies at runtime and unregisters a fiber's effects on dispose.
 * A `<name>.disabled` marker beside `<name>.mjs` switches that extension off the same way.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { packagePath } from '../infra/paths.ts'
import type {} from './hooks.ts'

export interface LoadedExtension {
  file: string
  name: string
  version: string
  loadedAt: string
  error?: string
}
interface Entry extends LoadedExtension { fiber?: { dispose(): Promise<void> } }

/** Keep dynamic import out of the bundler's static graph so a rebuilt file is fetched again. */
const dynamicImport = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<Record<string, unknown>>

/** Whether a `<name>.disabled` marker in `directory` switches off the extension `<name>.mjs`; the marker's content does not matter. */
const switchedOff = (directory: string, name: string): boolean => existsSync(join(directory, `${name}.disabled`))

/** The extension files the loader mounts from `directory`: every `.mjs` without a `.disabled` marker beside it, in name order. */
export function enabledExtensions(directory: string): string[] {
  return readdirSync(directory).filter(file => file.endsWith('.mjs') && !switchedOff(directory, file.slice(0, -4))).sort()
}

/** What one seeding pass did, by file name (by extension name for `disabled`), for the log. */
export interface SeedReport {
  /** Copied because the directory did not have them. */
  seeded: string[]
  /** Replaced by the bundled version, which changed, because the operator had not changed the copy. */
  upgraded: string[]
  /** Kept although the bundled version changed, because the operator changed the copy. */
  kept: string[]
  /** Switched off by a `<name>.disabled` marker: neither copied nor upgraded. */
  disabled: string[]
}

/** Records, by file name, the SHA-256 of the bundled version each copy in the directory was last made from. */
const RECORD = '.bundled.json'
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
function readRecord(path: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
  catch { return {} } // No record yet, or an unreadable one: every copy then counts as made from the version bundled now.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Copies the extensions bundled with the package (such as `context-guard`) into the watched directory so they activate on a
 * fresh installation, and keeps those copies current. The host's context-threshold rotation is driven entirely by
 * `context-guard`; without this seeding the bundled extension would sit in the package while the watched directory stayed
 * empty, and the feature would never run.
 *
 * Each `.mjs` and its `.json` is handled on its own. A missing file is copied. `.bundled.json` records the bundled version each
 * copy was made from: a copy still equal to it is replaced when the bundled version changes, so an upgrade reaches it, while a
 * copy the operator changed is never overwritten and is reported for as long as the bundled version differs from the one it
 * was made from. A copy older than the record counts as made from the version bundled now, so it is never overwritten on that
 * start. A `<name>.disabled` marker leaves that extension alone. `source` is the bundled directory, the package's by default.
 */
export function seedBundledExtensions(directory: string, source = packagePath('extensions')): SeedReport {
  const report: SeedReport = { seeded: [], upgraded: [], kept: [], disabled: [] }
  let names: string[]
  try { names = readdirSync(source).filter(name => name.endsWith('.mjs')).sort() }
  catch { return report } // No bundled extensions directory (a package built without it): nothing to seed.
  mkdirSync(directory, { recursive: true })
  const recordPath = join(directory, RECORD)
  const before = readRecord(recordPath)
  const record = { ...before }
  for (const name of names) {
    const extension = name.slice(0, -4)
    if (switchedOff(directory, extension)) { report.disabled.push(extension); continue }
    for (const file of [name, `${extension}.json`]) {
      const bundled = join(source, file)
      if (!existsSync(bundled)) continue
      const target = join(directory, file)
      const fresh = digest(bundled)
      if (!existsSync(target)) { copyFileSync(bundled, target); record[file] = fresh; report.seeded.push(file); continue }
      const current = digest(target)
      const base = before[file] ?? fresh
      if (current === fresh) record[file] = fresh
      else if (current === base) { copyFileSync(bundled, target); record[file] = fresh; report.upgraded.push(file) }
      else { record[file] = base; if (base !== fresh) report.kept.push(file) }
    }
  }
  if (JSON.stringify(record) !== JSON.stringify(before)) writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  return report
}

/**
 * The configuration an extension is mounted with: its sibling `.json` over the host defaults, such as the plugin's state directory,
 * so a bundled extension writes where this installation keeps its state. A key the `.json` sets wins.
 */
export function extensionConfig(configPath: string, defaults: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const own = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> : {}
  return { ...defaults, ...own }
}

/** Watches an extension directory and mounts, reloads or disposes each plugin fiber without restarting the host. */
export class ExtensionLoader {
  private readonly entries = new Map<string, Entry>()
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setInterval>
  private debounce?: ReturnType<typeof setTimeout>
  private scanning = false
  private pending = false
  private stopped = false

  constructor(private readonly ctx: Context, readonly directory: string, readonly defaults: Readonly<Record<string, unknown>> = {}) {}

  start(): void {
    mkdirSync(this.directory, { recursive: true })
    // Seeding is best-effort like loading: a file it cannot copy or read is logged, and the plugin starts with what is there.
    try {
      const { seeded, upgraded, kept, disabled } = seedBundledExtensions(this.directory)
      if (seeded.length) this.ctx.logger.info('[extensions] seeded bundled extensions: %s', seeded.join(', '))
      if (upgraded.length) this.ctx.logger.info('[extensions] upgraded bundled extensions to the version this package ships: %s', upgraded.join(', '))
      for (const file of kept) this.ctx.logger.warn('[extensions] kept %s, which you changed, although this package ships a different version; delete it to get that version at the next start', file)
      if (disabled.length) this.ctx.logger.info('[extensions] switched off by a .disabled marker: %s', disabled.join(', '))
    } catch (error) { this.ctx.logger.warn('[extensions] cannot seed the bundled extensions: %s', String(error)) }
    void this.scan()
    try { this.watcher = watch(this.directory, () => this.requestScan()) }
    catch (error) { this.ctx.logger.warn('[extensions] file watching unavailable, polling only: %s', String(error)) }
    this.timer = setInterval(() => this.requestScan(), 2000)
    this.timer.unref?.()
    this.ctx.logger.info('[extensions] watching %s', this.directory)
  }

  private requestScan(): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.scan() }, 150)
    this.debounce.unref?.()
  }

  private signature(path: string): string {
    const stat = statSync(path)
    return `${stat.mtimeMs}:${stat.size}`
  }

  private async scan(): Promise<void> {
    if (this.scanning) { this.pending = true; return }
    this.scanning = true
    try {
      let files: string[]
      try { files = enabledExtensions(this.directory) }
      catch (error) { this.ctx.logger.warn('[extensions] cannot read directory: %s', String(error)); return }
      const present = new Set(files)
      for (const file of [...this.entries.keys()]) if (!present.has(file)) await this.unload(file)
      for (const file of files) {
        const path = join(this.directory, file)
        const configPath = `${path.slice(0, -4)}.json`
        let version: string
        try { version = this.signature(path) + (existsSync(configPath) ? `|${this.signature(configPath)}` : '') }
        catch { continue }
        const entry = this.entries.get(file)
        if (entry && entry.version === version && !entry.error) continue
        if (entry) await this.unload(file)
        await this.load(file, path, configPath, version)
      }
    } finally {
      this.scanning = false
      if (this.pending) { this.pending = false; void this.scan() }
    }
  }

  private async load(file: string, path: string, configPath: string, version: string): Promise<void> {
    const loadedAt = new Date().toISOString()
    try {
      const loaded = await dynamicImport(`${pathToFileURL(path).href}?v=${encodeURIComponent(version)}`)
      const exported = loaded.default && typeof (loaded.default as { apply?: unknown }).apply === 'function'
        ? loaded.default : loaded
      const plugin = exported as { name?: string; apply?: unknown; inject?: unknown }
      if (typeof plugin.apply !== 'function') throw new Error('plugin must export an apply function')
      const config = extensionConfig(configPath, this.defaults)
      const pending = this.ctx.plugin(plugin as Parameters<Context['plugin']>[0], config)
      const fiber = await pending
      this.entries.set(file, { file, name: plugin.name ?? file, version, loadedAt, fiber })
      this.ctx.logger.info('[extensions] loaded %s (%s)', file, plugin.name ?? file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.entries.set(file, { file, name: file, version, loadedAt, error: message })
      this.ctx.logger.warn('[extensions] failed to load %s: %s', file, message)
    }
  }

  private async unload(file: string): Promise<void> {
    const entry = this.entries.get(file)
    if (!entry) return
    this.entries.delete(file)
    const hooks = this.ctx.superagentHooks
    if (hooks) hooks.clearStatus(entry.name)
    if (entry.fiber) {
      try { await entry.fiber.dispose() }
      catch (error) { this.ctx.logger.warn('[extensions] failed to unload %s: %s', file, String(error)) }
    }
    this.ctx.logger.info('[extensions] unloaded %s', file)
  }

  status(): { directory: string; watching: boolean; plugins: LoadedExtension[] } {
    return { directory: this.directory, watching: !!this.watcher,
      plugins: [...this.entries.values()].map(({ fiber, ...rest }) => rest) }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.debounce) clearTimeout(this.debounce)
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    for (const file of [...this.entries.keys()]) await this.unload(file)
  }
}
