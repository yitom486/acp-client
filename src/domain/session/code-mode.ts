/**
 * Session-level "code mode" (PTC) request.
 *
 * ACP has no standard field for how tools are presented to the model. An agent
 * that supports it advertises the offered presentations in `initialize`:
 *
 *   agentCapabilities._meta.toolsMode.values = ['native', 'ptc']
 *
 * and a client selects one per session through `_meta.toolsMode` on
 * session/new and session/resume. Under `ptc` the agent asks the model to write
 * code and exposes every visible tool — including MCP tools mounted for the
 * session — as `tools.<name>(...)`.
 *
 * Support is read from that declaration and nothing else: an agent that does
 * not declare it has no code mode, so the client must not invent one from a
 * runtime id (that would show a switch that silently does nothing).
 */

export type AcpCodeMode = 'on' | 'off'

/** The presentations an agent declares, or null when it declares nothing. */
export function parseCodeModeModes(
  caps: Record<string, unknown> | null | undefined,
): string[] | null {
  const meta = caps?._meta
  if (!meta || typeof meta !== 'object') return null
  const toolsMode = (meta as Record<string, unknown>).toolsMode
  if (!toolsMode || typeof toolsMode !== 'object') return null
  const values = (toolsMode as { values?: unknown }).values
  if (!Array.isArray(values)) return null
  const modes = values.filter((value): value is string => typeof value === 'string')
  return modes.length > 0 ? modes : null
}

/** Whether this agent declares a code-mode presentation. */
export function supportsCodeMode(
  caps: Record<string, unknown> | null | undefined,
): boolean {
  return parseCodeModeModes(caps)?.includes('ptc') === true
}

/** The `_meta` extension for one session, or undefined when nothing is requested. */
export function codeModeSessionMeta(
  mode: AcpCodeMode | undefined,
  caps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (mode !== 'on' || !supportsCodeMode(caps)) return undefined
  return { toolsMode: 'ptc' }
}

/**
 * Merge the app-resource extension with the code-mode request. The code-mode
 * key wins over an accidental same-named app-resource key; everything else is
 * preserved so a runtime that rejects unknown meta still keeps its resources.
 */
export function mergeSessionMeta(
  appMeta: Record<string, unknown> | undefined,
  mode: AcpCodeMode | undefined,
  caps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const requested = codeModeSessionMeta(mode, caps)
  if (!requested) return appMeta
  return { ...(appMeta ?? {}), ...requested }
}
