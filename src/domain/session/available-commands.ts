/**
 * ACP `available_commands_update` handling.
 *
 * Agents typically push their slash commands right after session/new|load|resume
 * returns — i.e. before a host has learned the sessionId or wired a listener.
 * Raw notifications are still forwarded untouched via `onSessionUpdate`; this
 * cache additionally keeps the latest list per session so hosts can read it
 * at any time (`AcpClient.getAvailableCommands`, `AcpSessionHandle.availableCommands`,
 * sidecar `session/open` result + `session/commands`).
 *
 * Invoking a command is plain prompt text (`/name args`) per the ACP spec.
 */

export interface AcpAvailableCommandInput {
  /** Placeholder shown while the user types the argument. */
  hint: string
}

export interface AcpAvailableCommand {
  name: string
  description: string
  input?: AcpAvailableCommandInput | null
  _meta?: Record<string, unknown>
}

/** Normalize one raw command; keeps name / description / input.hint / _meta. */
function normalizeCommand(raw: unknown): AcpAvailableCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !r.name.trim()) return null
  const out: AcpAvailableCommand = {
    name: r.name.trim(),
    description: typeof r.description === 'string' ? r.description : '',
  }
  const input = r.input as Record<string, unknown> | null | undefined
  if (input && typeof input === 'object' && typeof input.hint === 'string') {
    out.input = { hint: input.hint }
  }
  if (r._meta && typeof r._meta === 'object') out._meta = r._meta as Record<string, unknown>
  return out
}

/**
 * Extract `{ sessionId, commands }` from a session/update params object
 * (`{ sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } }`).
 */
export function extractAvailableCommands(
  params: unknown,
): { sessionId: string; commands: AcpAvailableCommand[] } | null {
  if (!params || typeof params !== 'object') return null
  const p = params as { sessionId?: unknown; update?: Record<string, unknown> }
  if (typeof p.sessionId !== 'string' || !p.update) return null
  if (p.update.sessionUpdate !== 'available_commands_update') return null
  const list = Array.isArray(p.update.availableCommands) ? p.update.availableCommands : []
  const commands = list.map(normalizeCommand).filter((c): c is AcpAvailableCommand => c !== null)
  return { sessionId: p.sessionId, commands }
}

/** Build the prompt text for a command invocation (ACP: plain text `/name args`). */
export function formatCommandPrompt(name: string, args?: string): string {
  const n = name.replace(/^\//, '')
  const a = (args ?? '').trim()
  return a ? `/${n} ${a}` : `/${n}`
}

export class AvailableCommandsCache {
  private bySession = new Map<string, AcpAvailableCommand[]>()
  private waiters = new Map<string, Array<(c: AcpAvailableCommand[]) => void>>()

  /** Feed every session/update params object; returns true if it was a commands update. */
  observe(params: unknown): boolean {
    const hit = extractAvailableCommands(params)
    if (!hit) return false
    this.bySession.set(hit.sessionId, hit.commands)
    const ws = this.waiters.get(hit.sessionId)
    if (ws) {
      this.waiters.delete(hit.sessionId)
      for (const w of ws) w(hit.commands)
    }
    return true
  }

  get(sessionId: string): AcpAvailableCommand[] | undefined {
    return this.bySession.get(sessionId)
  }

  /** Resolve with the cached list, or wait up to `timeoutMs` for one (undefined on timeout). */
  wait(sessionId: string, timeoutMs = 150): Promise<AcpAvailableCommand[] | undefined> {
    const cur = this.bySession.get(sessionId)
    if (cur || timeoutMs <= 0) return Promise.resolve(cur)
    return new Promise((resolve) => {
      const done = (c: AcpAvailableCommand[] | undefined) => {
        clearTimeout(timer)
        const list = this.waiters.get(sessionId)
        if (list) {
          const i = list.indexOf(fn)
          if (i >= 0) list.splice(i, 1)
          if (list.length === 0) this.waiters.delete(sessionId)
        }
        resolve(c)
      }
      const fn = (c: AcpAvailableCommand[]) => done(c)
      const timer = setTimeout(() => done(undefined), timeoutMs)
      const list = this.waiters.get(sessionId) ?? []
      list.push(fn)
      this.waiters.set(sessionId, list)
    })
  }

  delete(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  clear(): void {
    this.bySession.clear()
  }
}
