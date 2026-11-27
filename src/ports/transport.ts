import type { AcpAuthMethod, AcpPermissionOutcome } from '../domain/contracts'
import type { ManagedAgentProcess } from './process-launcher'

/** Default control-plane RPC timeout: 120s */
export const ACP_SDK_REQUEST_TIMEOUT_MS = 120_000
/** Default prompt idle timeout: 5 minutes of silence */
export const ACP_PROMPT_IDLE_TIMEOUT_MS = 300_000
/** Default prompt max hard duration: 0 = unlimited */
export const ACP_PROMPT_MAX_DURATION_MS = 0

export type AcpRpcRequest = (method: string, params?: unknown) => Promise<unknown>

export type SdkRequestTimeoutKind = 'timeout' | 'idle' | 'max_duration'

export class SdkRequestTimeoutError extends Error {
  readonly kind: SdkRequestTimeoutKind
  readonly method: string
  readonly durationMs: number

  constructor(kind: SdkRequestTimeoutKind, method: string, durationMs: number) {
    const secs = Math.max(1, Math.round(durationMs / 1000))
    const message =
      kind === 'idle'
        ? `请求超时 (${secs}s 无活动): ${method}`
        : kind === 'max_duration'
          ? `请求超时 (超过最大时长 ${secs}s): ${method}`
          : `请求超时: ${method}`
    super(message)
    this.name = 'SdkRequestTimeoutError'
    this.kind = kind
    this.method = method
    this.durationMs = durationMs
  }
}

export interface SdkRequestActivityController {
  touch(): void
  pause(): () => void
}

export interface SdkRequestActivityOptions {
  idleTimeoutMs?: number
  maxDurationMs?: number
  activity?: SdkRequestActivityController
}

export interface AgentInitializeResponse {
  protocolVersion: number
  authMethods?: AcpAuthMethod[]
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: Record<string, unknown>
  [key: string]: unknown
}

export interface AgentRpcEndpoint {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; cancellationSignal?: AbortSignal },
  ): Promise<T>
  requestWithActivity<T = unknown>(
    method: string,
    params: unknown,
    options?: SdkRequestActivityOptions,
  ): Promise<T>
  notify(method: string, params?: unknown): Promise<void>
  closeSessions(sessionIds: Iterable<string>, timeoutMs?: number): Promise<string[]>
  createActivityController(): SdkRequestActivityController
}

export interface AgentTransportHandlers {
  getWorkspaceRoot: () => string | null
  onPermission: (payload: {
    sessionId?: string
    params: Record<string, unknown>
    signal: AbortSignal
  }) => Promise<AcpPermissionOutcome>
  onSessionUpdate: (params: Record<string, unknown>) => void
  onActivity?: (sessionId?: string) => void
  onPauseActivity?: (sessionId?: string) => () => void
  maxReadBytes?: number
}

export interface AgentTransportConnection {
  readonly endpoint: AgentRpcEndpoint
  /** Raw underlying SDK agent handle when using the official ACP SDK adapter */
  readonly rawAgent?: unknown
  close(): void
}

export interface AgentTransportPort {
  connect(input: {
    process: ManagedAgentProcess
    handlers: AgentTransportHandlers
    runtimeId: string
    clientInfo: { name: string; version: string }
  }): AgentTransportConnection
}
