import type { AcpRuntimeInfo } from '../domain/contracts'

export interface ManagedAgentProcess {
  readonly id: string
  readonly runtimeId: string
  readonly pid?: number
  readonly profileTag?: string | null
  bridgeVersion?: string
  isAlive(): boolean
  kill(): void
  /** Opaque underlying process handle consumed by the matching AgentTransportPort */
  readonly rawHandle?: unknown
}

export interface LaunchAgentProcessRequest {
  runtime: AcpRuntimeInfo
  cwd: string
  scopeKey?: string
  env?: Record<string, string | undefined>
  envRemove?: string[]
  profileTag?: string | null
  onStderrLine?: (line: string) => void
  onExit?: (code: number | null, signal: string | null) => void
}

export interface ReuseAgentProcessRequest {
  runtimeId: string
  scopeKey?: string
  expectedTag?: string | null
  isBusy?: (process: ManagedAgentProcess) => boolean
}

export type ReuseAgentProcessResult =
  | { status: 'hit'; process: ManagedAgentProcess }
  | { status: 'busy'; process: ManagedAgentProcess }
  | { status: 'miss' }

export interface ProcessLauncherPort {
  launch(request: LaunchAgentProcessRequest): ManagedAgentProcess
  tryReuse(request: ReuseAgentProcessRequest): ReuseAgentProcessResult
}
