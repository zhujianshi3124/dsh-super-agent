// sa-context-guard — watches REAL context consumption of every DSH session.
//
// C-13b: ratio = usage.totalTokens / contextWindow, read from live session events.
// No character counts, no estimates. If a session has not yet reported real usage,
// the guard stays silent about it rather than inventing a number.
//
// Two thresholds for worker Sessions and the foreman (percentages of the model window):
//   warn  (default 35%): pre-write a handoff file and remind the session to keep it
//                        current; no new work starts here except a small task (C-12a).
//   hard  (default 40%): request rotation. The host does NOT interrupt the running
//                        task; it waits for the current step to end, then continues
//                        in a successor session that inherits the settings (C-09c).
//
// The main Session is exempt (C-13c): its usage is still reported for the panel
// (C-37.5), but it is never warned and never rotated — only the person opens a new
// main Session, and the latest one in D:\chief is always the true one.
//
// Contract: export name / inject / apply(ctx, config). Config comes from the sibling
// .json. Everything registered through ctx.effect is torn down on edit/remove.
export const name = 'sa-context-guard'
export const inject = ['superagentHooks']

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const clampRatio = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback
}

// Ticket id from a worker session id, stripping any rotation generation suffix (-r<N>), so a successor's handoff names its
// ticket and not `X-r1` (N-11, C-05).
const ticketOf = (sessionId) => sessionId.startsWith('worker-') ? sessionId.slice(7).replace(/-r\d+$/, '') : undefined

export function apply(ctx, config = {}) {
  const hooks = ctx.superagentHooks
  const warnRatio = clampRatio(config.warnRatio, 0.35)
  const hardRatio = clampRatio(config.hardRatio, 0.40)
  const stateDir = config.stateDir ?? join(homedir(), '.dsh', 'state', 'superagent')
  const handoffDir = config.handoffDir ?? join(stateDir, 'handoffs')
  // Per-session real-usage state. `window` and `tokens` are only ever set from events.
  const sessions = new Map()

  const stateOf = (sessionId) => {
    let s = sessions.get(sessionId)
    if (!s) { s = { window: 0, tokens: 0, warned: false, asked: false, events: 0 }; sessions.set(sessionId, s) }
    return s
  }

  // Pull the declared context window out of a request/context event.
  const windowOf = (event) => {
    const w = event?.data?.contextWindow
    return Number.isFinite(w) && w > 0 ? w : 0
  }
  // Pull the real cumulative token count out of an assistant/message event.
  const tokensOf = (event) => {
    const u = event?.data?.usage
    const t = u?.totalTokens
    return Number.isFinite(t) && t >= 0 ? t : undefined
  }

  const writeHandoff = (sessionId, role, s, stage, warnAt, hardAt) => {
    try {
      mkdirSync(handoffDir, { recursive: true })
      const ticketId = ticketOf(sessionId)
      const pct = s.window ? Math.round((s.tokens / s.window) * 100) : 0
      const body = [
        `# Handoff pre-write (${stage})`,
        ``,
        `- session: ${sessionId}`,
        `- role: ${role}`,
        ...(ticketId ? [`- ticket: ${ticketId}`] : []),
        `- real usage: ${s.tokens} / ${s.window} tokens (${pct}%)`,
        `- warn ratio: ${warnAt}, hard ratio: ${hardAt}`,
        `- stage: ${stage}`,
        `- at: ${new Date().toISOString()}`,
        ``,
        `This file was pre-written by sa-context-guard when the session crossed the`,
        `${stage === 'warn' ? 'warn' : 'hard'} threshold. The host rotation mechanism extends it with the`,
        `task goal, done/undone items, decisions, artifact paths and pending decisions`,
        `before a successor session reads it. Full transcript stays in the DSH session log.`,
        ``,
      ].join('\n')
      writeFileSync(join(handoffDir, `${sessionId}.md`), body)
      return join(handoffDir, `${sessionId}.md`)
    } catch (error) {
      hooks.say({ plugin: name, level: 'warn', text: `could not pre-write handoff for ${sessionId}: ${String(error)}` })
      return undefined
    }
  }

  ctx.effect(() => hooks.on('sessionEvent', (payload) => {
    const { sessionId, role, event } = payload
    const s = stateOf(sessionId)
    s.events += 1

    // The host forwards the authoritative window (session.requestContext), which is present even for
    // sessions whose request/context event fired long ago. Fall back to the event's own window if any.
    const hostWindow = Number.isFinite(payload.contextWindow) && payload.contextWindow > 0 ? payload.contextWindow : 0
    const w = hostWindow || windowOf(event)
    if (w) s.window = w
    const t = tokensOf(event)
    if (t !== undefined) s.tokens = t

    // Only report once both real numbers are known. Never estimate.
    if (!s.window || !s.tokens) return
    const ratio = s.tokens / s.window
    hooks.reportUsage({ sessionId, role, used: s.tokens, limit: s.window, ratio, source: name })

    const ticketId = ticketOf(sessionId)
    // The main Session's usage is reported for the panel, but it is never warned and never rotated (C-13c, C-37.5).
    if (role === 'orchestrator') return
    const warnAt = warnRatio
    const hardAt = hardRatio

    // Warn threshold: pre-write the handoff file, remind the session, and surface the state once (C-13b).
    if (ratio >= warnAt && !s.warned) {
      s.warned = true
      const path = writeHandoff(sessionId, role, s, 'warn', warnAt, hardAt)
      if (typeof hooks.advise === 'function') {
        hooks.advise(sessionId,
          `Context usage is ${(ratio * 100).toFixed(1)}% of the model window (warn threshold ${(warnAt * 100).toFixed(0)}%, C-13b). `
          + `Start writing your handoff document now — who the previous generation was, what work is in hand, what you decided recently — `
          + `and keep it current. Take no new work here except a small task the foreman judges (C-12a). `
          + `A handoff file was pre-written${path ? ` at ${path}` : ''}. Your current task is not interrupted; at 40% the host rotates you `
          + `after the current step ends.`,
          'Context warn threshold')
      }
      hooks.say({ plugin: name, level: 'warn',
        text: `${sessionId} at ${(ratio * 100).toFixed(1)}% (>= ${(warnAt * 100).toFixed(0)}% warn); handoff pre-written${path ? `: ${path}` : ''}` })
    }

    // Hard threshold: request rotation once. The host waits for the task to end.
    if (ratio >= hardAt && !s.asked) {
      s.asked = true
      const path = writeHandoff(sessionId, role, s, 'hard', warnAt, hardAt)
      hooks.requestRotation({ sessionId, ticketId,
        reason: `real context usage ${s.tokens}/${s.window} tokens = ${(ratio * 100).toFixed(1)}% (>= ${(hardAt * 100).toFixed(0)}% hard)`,
        summary: `Rotate after the current task ends; handoff pre-written${path ? ` at ${path}` : ''}.`,
        ...(path ? { handoffPath: path } : {}),
        requestedBy: name })
      hooks.say({ plugin: name, level: 'warn',
        text: `${sessionId} crossed hard threshold ${(hardAt * 100).toFixed(0)}%; rotation requested (host waits for task end)` })
    }
  }))

  hooks.setStatus(name, 'ready', `real usage; worker/foreman ${(warnRatio * 100).toFixed(0)}%/${(hardRatio * 100).toFixed(0)}% of window; main Session exempt (C-13c)`)
  hooks.say({ plugin: name, level: 'info', text: 'context guard loaded (real totalTokens/contextWindow)' })
  ctx.effect(() => () => hooks.say({ plugin: name, level: 'info', text: 'context guard unloaded' }))
}
