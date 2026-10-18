/**
 * Session-level "code mode" (PTC) request.
 *
 * ACP has no standard field for how tools are presented to the model. The
 * DeepSeek Harness offers a PTC presentation where the model writes code and
 * reaches every visible tool — including MCP tools mounted for the session —
 * as `tools.<name>(...)`. A client asks for it through the `_meta.toolsMode`
 * extension carried by session/new and session/resume.
 *
 * Only runtimes that actually implement that extension are marked below: an
 * unknown runtime must not receive a hint it would ignore or reject. Add a
 * runtime here only after its ACP surface documents the behaviour.
 */

export type AcpCodeMode = 'on' | 'off'

/** Runtimes whose ACP surface understands `_meta.toolsMode`. */
const CODE_MODE_RUNTIMES: ReadonlySet<string> = new Set(['deepseek'])

/** Whether this runtime can present its tools as a code-mode SDK. */
export function supportsCodeMode(runtimeId: string): boolean {
  return CODE_MODE_RUNTIMES.has(runtimeId)
}

/**
 * The `_meta` extension for one session, or undefined when the request is off
 * or the runtime has no code mode.
 */
export function codeModeSessionMeta(
  mode: AcpCodeMode | undefined,
  runtimeId: string,
): Record<string, unknown> | undefined {
  if (mode !== 'on' || !supportsCodeMode(runtimeId)) return undefined
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
  runtimeId: string,
): Record<string, unknown> | undefined {
  const requested = codeModeSessionMeta(mode, runtimeId)
  if (!requested) return appMeta
  return { ...(appMeta ?? {}), ...requested }
}
