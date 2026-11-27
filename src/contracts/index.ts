/**
 * @yitom/acp-client 核心契约与数据类型
 *
 * 自包含的跨平台 ACP 规范定义，零外部私有包依赖。
 */

// ── 错误与 Result 结果集 ──

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

// ── ACP 连接与运行时状态 ──

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

export interface AcpAuthPreflightResult {
  codexHome: string
  hasCodexHome: boolean
  hasAuthFile: boolean
  hasApiKeyEnv: boolean
  looksLoggedIn: boolean
}

export type CodexAuthPreflight = AcpAuthPreflightResult

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

// ── 运行时适配器常量与包名 ──

export const CODEX_ACP_NPM_PACKAGE = '@agentclientprotocol/codex-acp' as const
export const CLAUDE_ACP_NPM_PACKAGE = '@agentclientprotocol/claude-agent-acp' as const
export const DEEPSEEK_DSH_NPM_PACKAGE = '@deepseek-ai/dsh' as const
export const AGY_ACP_NPM_PACKAGE = '@yitom/agy-acp-map' as const
export const OPENCODE_CLI_NPM_PACKAGE = '@opencode/cli' as const
export const DEFAULT_ACP_RUNTIME_ID = 'codex-acp'

function isWindowsPlatform(): boolean {
  const proc = (globalThis as { process?: { platform?: string } }).process
  return proc?.platform === 'win32'
}

export const BUILTIN_ACP_RUNTIMES: readonly AcpRuntimeInfo[] = [
  {
    id: 'codex-acp',
    name: 'ChatGPT',
    description:
      '通过 bunx 启动官方 @agentclientprotocol/codex-acp；可复用本机 ~/.codex（ChatGPT / API Key）',
    authHint:
      '复用本机 ~/.codex 登录（auth.json 或 OPENAI_API_KEY / CODEX_API_KEY）；未登录按下方 Agent 认证方式完成登录',
    command: 'bunx',
    args: ['-y', `${CODEX_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  {
    id: 'claude',
    name: 'Claude',
    description:
      '通过 bunx 启动官方 @agentclientprotocol/claude-agent-acp；可复用本机 Claude Code 登录态（~/.claude.json）或 ANTHROPIC_API_KEY',
    authHint:
      '复用本机 Claude Code 登录（~/.claude.json / ~/.claude/.credentials.json 或 ANTHROPIC_API_KEY）；未登录先跑 claude login',
    command: 'bunx',
    args: ['-y', `${CLAUDE_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: ['ANTHROPIC_API_KEY'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    description: '启动本机 Gemini CLI（--acp）；复用 Gemini CLI 登录态（~/.gemini/）',
    authHint:
      '复用本机 Gemini CLI 登录（~/.gemini/oauth_creds.json 或 GEMINI_API_KEY / GOOGLE_API_KEY）；未登录先在本机终端跑 gemini 完成登录',
    command: isWindowsPlatform() ? 'gemini.cmd' : 'gemini',
    args: ['--acp'],
    requiredEnvKeys: [],
  },
  {
    id: 'copilot',
    name: 'Copilot',
    description: '启动本机 Copilot CLI（--acp --stdio）；复用 Copilot CLI 的 GitHub 登录态',
    authHint:
      '复用本机 Copilot CLI 的 GitHub 登录（~/.copilot/config.json 或 COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN）；未登录先跑 copilot login',
    command: isWindowsPlatform() ? 'copilot.cmd' : 'copilot',
    args: ['--acp', '--stdio'],
    requiredEnvKeys: [],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description:
      '启动本机 opencode（acp）；复用 `opencode auth login` 写入 auth.json（~/.local/share/opencode/auth.json）的各 provider 凭证',
    authHint:
      '已登录（%LOCALAPPDATA%\\opencode\\auth.json 或 ~/.local/share/opencode/auth.json）则直接连接；否则先跑 opencode auth login',
    command: isWindowsPlatform() ? 'opencode.exe' : 'opencode',
    args: ['acp'],
    requiredEnvKeys: [],
  },
  {
    id: 'opencode-v2',
    name: 'OpenCode v2',
    description:
      '通过 npx 启动独立产品线 @opencode/cli v2（acp）；与 1.x 共存，复用 v2 SQLite 登录态',
    authHint:
      'v2 登录态在 SQLite（auth.json 仅兼容残留）；未登录先用 v2 二进制跑 opencode auth login',
    command: 'npx',
    args: ['-y', OPENCODE_CLI_NPM_PACKAGE, 'acp'],
    requiredEnvKeys: [],
  },
  {
    id: 'cursor-cli',
    name: 'Cursor',
    description:
      '启动 Cursor 官方 CLI（agent acp）；复用本机 Cursor 登录态（未登录可运行 `agent login`）。安装路径探测（%LOCALAPPDATA%\\cursor-agent / ~/.local/bin/agent）见主进程 cursor 适配器',
    authHint:
      '复用本机 Cursor 登录态（或 CURSOR_API_KEY / CURSOR_AUTH_TOKEN）；未登录先跑 agent login',
    command: isWindowsPlatform() ? 'agent.cmd' : 'agent',
    args: ['acp'],
    requiredEnvKeys: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description:
      '通过 bunx 启动 @deepseek-ai/dsh（--profile acp）；无 ACP 登录，靠 harness 自身凭证（DEEPSEEK_API_KEY / harness 配置）；模型经 session 到达，无需额外动作',
    authHint:
      '无 ACP 登录，靠 harness 自身凭证（DEEPSEEK_API_KEY / harness 配置）；未配置先导出 DEEPSEEK_API_KEY；模型经 session 到达，无需额外动作；若官方最新 dsh 存在坏依赖（如 rc.3 缺失），可设 DSH_PACKAGE pin 旧版',
    command: 'bunx',
    args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
    requiredEnvKeys: ['DEEPSEEK_API_KEY'],
  },
  {
    id: 'antigravity-cli',
    name: 'Antigravity',
    description: '启动 Google Antigravity CLI 自带的 agy acp 服务',
    authHint: '复用 Antigravity CLI 登录。需要登录时选择 Agent 提供的方式，或在终端运行 agy acp --login',
    command: isWindowsPlatform() ? 'agy.exe' : 'agy',
    args: ['acp'],
    requiredEnvKeys: [],
  },
  {
    id: 'agy',
    name: 'Antigravity (legacy bridge)',
    description:
      '通过 bunx 启动 @yitom/agy-acp-map，兼容旧会话 ID 和桥接扩展',
    authHint: '复用 Antigravity CLI 本地登录态；未登录先在本机终端完成 agy 登录后再连接',
    command: 'bunx',
    args: ['-y', `${AGY_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: [],
  },
] as const

export function findBuiltinAcpRuntime(id: string): AcpRuntimeInfo | undefined {
  return BUILTIN_ACP_RUNTIMES.find((item) => item.id === id)
}

export * from './quota'
