import type { AcpProxySettings, AppError, Result } from '../domain/contracts'

export interface HostFsPort {
  readTextFile(params: {
    path: string
    workspaceRoot: string
    line?: number
    limit?: number
    maxReadBytes?: number
    blockedExtensions?: ReadonlySet<string>
  }): Promise<{ content: string }>
  writeTextFile(params: {
    path: string
    content: string
    workspaceRoot: string
  }): Promise<Record<string, never>>
}

export interface HostTerminalExitStatus {
  exitCode?: number | null
  signal?: string | null
}

export interface HostTerminalOutputSnapshot {
  output: string
  truncated: boolean
  exitStatus?: HostTerminalExitStatus
}

export interface CreateHostTerminalParams {
  sessionId: string
  command: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  cwd?: string
  outputByteLimit?: number
  workspaceRoot: string
}

export interface HostTerminalPort {
  create(params: CreateHostTerminalParams): { terminalId: string }
  getOutput(terminalId: string): HostTerminalOutputSnapshot
  waitForExit(terminalId: string): Promise<HostTerminalExitStatus>
  kill(terminalId: string): Record<string, never>
  release(terminalId: string): Record<string, never>
  releaseAll(): void
}

export interface ProxySettingsStorePort {
  read(dataDir?: string): Promise<AcpProxySettings>
  save(settings: AcpProxySettings, dataDir?: string): Promise<Result<AcpProxySettings, AppError>>
  buildSpawnEnv(settings: AcpProxySettings): {
    env: Record<string, string | undefined>
    envRemove: string[]
  }
}

export interface HostPathsPort {
  getDefaultDataDir(): string
}
