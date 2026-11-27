/** Hot-swappable extension loader.

 * Watches a directory of ESM plugins and mounts each one with `ctx.plugin()`. Adding a
 * `.mjs` file loads it, editing a file or its sibling `.json` config reloads it, and
 * deleting a file disposes its fiber. Nothing here requires a process restart: cordis
 * resolves `inject` dependencies at runtime and unregisters a fiber's effects on dispose.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
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

/** Watches an extension directory and mounts, reloads or disposes each plugin fiber without restarting the host. */
export class ExtensionLoader {
  private readonly entries = new Map<string, Entry>()
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setInterval>
  private debounce?: ReturnType<typeof setTimeout>
  private scanning = false
  private pending = false
  private stopped = false

  constructor(private readonly ctx: Context, readonly directory: string) {}

  start(): void {
    mkdirSync(this.directory, { recursive: true })
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
      try { files = readdirSync(this.directory).filter(name => name.endsWith('.mjs')).sort() }
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
      let config: Record<string, unknown> = {}
      if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
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
