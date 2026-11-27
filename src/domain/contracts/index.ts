/**
 * @yitom/acp-client pure domain contracts & value types.
 *
 * Self-contained ACP domain types with zero Node.js I/O or third-party SDK dependencies.
 */

export type AppErrorCode =
  | 'CANCELLED'
  | 'FILE_READ_ERROR'
  | 'FILE_WRITE_ERROR'
  | 'FILE_NOT_FOUND'
  | 'ACP_SPAWN_ERROR'
  | 'ACP_PROTOCOL_ERROR'
  | 'ACP_NOT_CONNECTED'
  | 'ACP_TIMEOUT'
  | 'BUN_NOT_INSTALLED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'UNKNOWN'

export interface AppError {
  code: AppErrorCode
  message: string
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok
}

// ── ACP connection & runtime domain models ──

export type AcpConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaiting_auth'
  | 'connected'
  | 'error'

export interface AcpRuntimeInfo {
  id: string
  name: string
  description: string
  command: string
  args: string[]
  requiredEnvKeys: string[]
  authHint?: string
}

export interface AcpAuthMethod {
  id: string
  name?: string
  description?: string
  type?: string
}

export type AcpSessionRestoreMethod = 'resume' | 'load' | 'new'

export interface AcpSessionRestoreAttempt {
  method: 'resume' | 'load'
  ok: boolean
  tries: number
  error?: string
}

export interface AcpPromptCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

export interface AcpConfigOptionValue {
  value: string
  name: string
  description?: string
}

export interface AcpConfigOption {
  configId: string
  name: string
  description?: string
  category?: string
  type: 'select' | 'boolean' | string
  currentValue?: string | boolean | number
  options?: AcpConfigOptionValue[]
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

/**
 * Runtime-agnostic local credential preflight result (boolean presence only;
 * never exposes secret contents).
 */
export interface AcpAuthPreflight {
  homeDir: string
  hasHomeDir: boolean
  hasAuthFile: boolean
  hasApiKeyEnv: boolean
  looksLoggedIn: boolean
}

export function emptyAcpAuthPreflight(): AcpAuthPreflight {
  return {
    homeDir: '',
    hasHomeDir: false,
    hasAuthFile: false,
    hasApiKeyEnv: false,
    looksLoggedIn: false,
  }
}

export interface AcpProviderConfig {
  name?: string
  baseUrl: string
  model: string
  wireApi: 'chat' | 'responses'
}

export interface AcpProviderSavePayload extends AcpProviderConfig {
  apiKey: string
}

export interface AcpProviderStatus {
  configured: boolean
  name?: string
  baseUrl?: string
  model?: string
  wireApi?: 'chat' | 'responses'
  hasApiKey: boolean
}

export interface AcpProxySettings {
  enabled: boolean
  host: string
  port: number
}

// ── Package & runtime constants ──

export const CODEX_ACP_NPM_PACKAGE = '@agentclientprotocol/codex-acp' as const
export const CLAUDE_ACP_NPM_PACKAGE = '@agentclientprotocol/claude-agent-acp' as const
export const DEEPSEEK_DSH_NPM_PACKAGE = '@deepseek-ai/dsh' as const
export const AGY_ACP_NPM_PACKAGE = '@yitom/agy-acp-map' as const
export const OPENCODE_CLI_NPM_PACKAGE = '@opencode/cli' as const
export const DEFAULT_ACP_RUNTIME_ID = 'codex-acp'

export * from './quota'
export * from './resources'
