import type { AcpSessionRestoreAttempt, AcpSessionRestoreMethod } from '../domain/contracts'
import { mergeTopLevelModelsIntoConfigOptions } from '../domain/session/config-options'
import type { AcpRpcRequest } from '../ports'

export type { AcpRpcRequest }

export interface RestoreOrCreateSessionInput {
  request: AcpRpcRequest
  cwd: string
  resumeSessionId: string | null
  resumeSupported: boolean
  loadSupported: boolean
  mcpServers?: unknown[]
  /** Default true: never silently remove tools after a failed session/new. */
  preserveMcpOnRetry?: boolean
  /** Runtime-specific native options; not a standard ACP system prompt field. */
  sessionMeta?: Record<string, unknown>
  codeMode?: boolean
  onSuppressUpdates?: (suppress: boolean) => void
  retryDelayMs?: number
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
}

export interface RestoreOrCreateSessionResult {
  mcpServersAccepted: boolean
  recoveredToolOutputs?: Array<{ toolCallId: string; text: string }>
  nativeSessionAccepted: boolean
  sessionId: string
  configOptions: unknown
  restoreMethod: AcpSessionRestoreMethod
  sessionRestored: boolean
  requestedSessionId?: string
  restoreAttempts: AcpSessionRestoreAttempt[]
}

const utf8Encoder = new TextEncoder()

function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

function jsonRpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

function jsonRpcErrorData(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  return (error as { data?: unknown }).data
}

export function isAuthenticationRequired(message: string): boolean {
  return (
    !/\bmcp\b/i.test(message) &&
    /authentication required|not authenticated|please (?:log|sign) in|需要认证|尚未认证/i.test(message)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Pure JSON-RPC transient error classifier (zero `@agentclientprotocol/sdk`
 * dependency — matches any JSON-RPC error carrying numeric `code` + optional `data`).
 */
export function isTransientAcpTransportError(error: unknown): boolean {
  const code = jsonRpcErrorCode(error)
  if (code !== null) {
    if (code === -32800 || code === -32601 || code === -32602) return false
    const data = jsonRpcErrorData(error)
    let detail = ''
    try {
      detail = data === undefined ? '' : JSON.stringify(data)
    } catch {
      detail = String(data)
    }
    return /超时|timeout|timed out|temporar|busy|unavailable|closed|abort|econnreset|epipe/i.test(
      `${errorMessage(error)} ${detail}`,
    )
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /ACP connection closed|connection closed|closed|abort|超时|timeout|timed out|econnreset|epipe|stdio|stream/i.test(
    message,
  )
}

export async function restoreOrCreateAcpSession(
  input: RestoreOrCreateSessionInput,
): Promise<RestoreOrCreateSessionResult> {
  const resumeId = input.resumeSessionId?.trim() || null
  const restoreAttempts: AcpSessionRestoreAttempt[] = []
  let mcpServersAccepted = (input.mcpServers ?? []).length > 0
  let nativeSessionAccepted = false
  const sessionMeta = input.codeMode
    ? { ...(input.sessionMeta ?? {}), toolsMode: 'ptc' }
    : input.sessionMeta
  let recoveredToolOutputs: RestoreOrCreateSessionResult['recoveredToolOutputs']

  const request = async (method: string, params: Record<string, unknown>) => {
    const opened = await requestSessionWithResources(input.request, method, params, sessionMeta)
    nativeSessionAccepted = opened.nativeSessionAccepted
    const meta = opened.result._meta as { toolOutputRecovery?: { outputs?: unknown } } | undefined
    const outputs = meta?.toolOutputRecovery?.outputs
    let total = 0
    recoveredToolOutputs = Array.isArray(outputs)
      ? outputs.slice(0, 20).flatMap((row) => {
          if (
            !row ||
            typeof row.toolCallId !== 'string' ||
            row.toolCallId.length > 120 ||
            typeof row.text !== 'string'
          ) {
            return []
          }
          const bytes = utf8ByteLength(row.text)
          if (bytes > 128 * 1024 || total + bytes > 256 * 1024) return []
          total += bytes
          return [{ toolCallId: row.toolCallId, text: row.text }]
        })
      : undefined
    return opened.result
  }

  const delayMs = input.retryDelayMs ?? 250
  const log =
    input.log ??
    ((level, message, data) => {
      const line = `[acp] ${message}`
      if (level === 'warn') console.warn(line, data ?? '')
      else console.info(line, data ?? '')
    })

  const tryRestoreMethod = async (
    method: 'resume' | 'load',
    rpcMethod: string,
  ): Promise<Record<string, unknown> | null> => {
    const maxTries = 2
    let lastError = ''
    for (let tryIndex = 1; tryIndex <= maxTries; tryIndex++) {
      log('info', 'session restore attempt', {
        method: rpcMethod,
        sessionId: resumeId,
        try: tryIndex,
        maxTries,
      })
      try {
        const result = (await request(rpcMethod, {
          sessionId: resumeId,
          cwd: input.cwd,
          mcpServers: input.mcpServers ?? [],
        })) as Record<string, unknown>
        restoreAttempts.push({ method, ok: true, tries: tryIndex })
        log('info', 'session restore ok', { method: rpcMethod, sessionId: resumeId })
        return result
      } catch (error) {
        lastError = errorMessage(error)
        if (isAuthenticationRequired(lastError)) throw error
        log('warn', 'session restore failed', {
          method: rpcMethod,
          sessionId: resumeId,
          try: tryIndex,
          error: lastError,
        })
        const canRetry = tryIndex < maxTries && isTransientAcpTransportError(error)
        if (!canRetry) {
          restoreAttempts.push({ method, ok: false, tries: tryIndex, error: lastError })
          return null
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    restoreAttempts.push({ method, ok: false, tries: maxTries, error: lastError })
    return null
  }

  log('info', 'openSession', {
    resumeId,
    resumeSupported: input.resumeSupported,
    loadSupported: input.loadSupported,
  })

  const requestSessionNew = async (): Promise<Record<string, unknown>> => {
    const baseParams = {
      cwd: input.cwd,
      mcpServers: input.mcpServers ?? [],
    }
    try {
      return (await request('session/new', baseParams)) as Record<string, unknown>
    } catch (firstError) {
      if (isAuthenticationRequired(errorMessage(firstError)) || isTransientAcpTransportError(firstError)) {
        throw firstError
      }
      if ((input.mcpServers ?? []).length === 0) throw firstError
      const preserve = input.preserveMcpOnRetry !== false
      log(
        'warn',
        preserve ? 'session/new failed, retry with mcpServers' : 'session/new failed, retry without mcpServers',
        { error: errorMessage(firstError) },
      )
      try {
        const result = (await request('session/new', {
          cwd: input.cwd,
          mcpServers: preserve ? input.mcpServers ?? [] : [],
        })) as Record<string, unknown>
        mcpServersAccepted = preserve
        return result
      } catch {
        throw firstError
      }
    }
  }

  const withModelsFallback = (result: Record<string, unknown>): unknown =>
    mergeTopLevelModelsIntoConfigOptions(result.configOptions, result)

  if (resumeId && input.resumeSupported) {
    const resumed = await tryRestoreMethod('resume', 'session/resume')
    if (resumed) {
      const id = typeof resumed.sessionId === 'string' ? resumed.sessionId : resumeId
      return {
        sessionId: id,
        configOptions: withModelsFallback(resumed),
        restoreMethod: 'resume',
        sessionRestored: true,
        recoveredToolOutputs,
        mcpServersAccepted,
        nativeSessionAccepted,
        requestedSessionId: resumeId,
        restoreAttempts,
      }
    }
  } else if (resumeId && !input.resumeSupported) {
    log('info', 'skip session/resume：Agent 未声明 resume 能力')
  }

  if (resumeId && input.loadSupported) {
    input.onSuppressUpdates?.(true)
    try {
      const loaded = await tryRestoreMethod('load', 'session/load')
      if (loaded) {
        const id = typeof loaded.sessionId === 'string' ? loaded.sessionId : resumeId
        return {
          sessionId: id,
          configOptions: withModelsFallback(loaded),
          restoreMethod: 'load',
          sessionRestored: true,
          recoveredToolOutputs,
          mcpServersAccepted,
          nativeSessionAccepted,
          requestedSessionId: resumeId,
          restoreAttempts,
        }
      }
    } finally {
      input.onSuppressUpdates?.(false)
    }
  } else if (resumeId && !input.loadSupported) {
    log('info', 'skip session/load：Agent 未声明 loadSession 能力')
  }

  log('info', 'falling back to session/new', { resumeId, restoreAttempts })
  const sessionResult = await requestSessionNew()
  const newSessionId = typeof sessionResult.sessionId === 'string' ? sessionResult.sessionId : null
  if (!newSessionId) {
    throw new Error('session/new 未返回 sessionId')
  }

  return {
    sessionId: newSessionId,
    configOptions: withModelsFallback(sessionResult),
    restoreMethod: 'new',
    sessionRestored: false,
    mcpServersAccepted,
    nativeSessionAccepted,
    requestedSessionId: resumeId ?? undefined,
    restoreAttempts,
  }
}

/** Retry rejected native extensions without changing the MCP descriptors. */
export async function requestSessionWithResources(
  request: AcpRpcRequest,
  method: string,
  params: Record<string, unknown>,
  sessionMeta?: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; nativeSessionAccepted: boolean }> {
  if (!sessionMeta) {
    return { result: (await request(method, params)) as Record<string, unknown>, nativeSessionAccepted: false }
  }
  try {
    return {
      result: (await request(method, { ...params, _meta: sessionMeta })) as Record<string, unknown>,
      nativeSessionAccepted: true,
    }
  } catch (error) {
    const rejected =
      jsonRpcErrorCode(error) === -32602 ||
      /native.*meta.*reject|unsupported.*(meta|systemPrompt)|unknown.*(meta|systemPrompt)/i.test(
        errorMessage(error),
      )
    if (!rejected || isTransientAcpTransportError(error)) throw error
    return { result: (await request(method, params)) as Record<string, unknown>, nativeSessionAccepted: false }
  }
}
