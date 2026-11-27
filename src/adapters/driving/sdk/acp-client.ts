import {
  AcpClientEngine,
  type AcpClientCallbacks,
  type AcpClientEngineOptions,
  type AcpClientEnginePorts,
  type AcpCreateSessionOptions,
  type AcpPromptOptions,
} from '../../../application'
import { createDefaultAcpPorts } from '../../../bootstrap/default-ports'
import type {
  AcpAgentQuota,
  AcpConnectionStatus,
  AcpSessionRestoreMethod,
  AppError,
  AppResourceReport,
  Result,
} from '../../../domain/contracts'
import type { AcpAvailableCommand } from '../../../domain/session/available-commands'
import type {
  AcpRuntimePlugin,
  AgentInitializeResponse,
  RuntimeRegistryPort,
} from '../../../ports'

export type { AcpClientCallbacks, AcpCreateSessionOptions, AcpPromptOptions }

export interface AcpClientOptions extends AcpClientEngineOptions {
  /** Optional isolated runtime registry (defaults to built-in 10 runtimes). */
  runtimeRegistry?: RuntimeRegistryPort
  /** Optional port overrides for custom host adapters or pure in-memory testing. */
  ports?: Partial<AcpClientEnginePorts>
}

export class AcpSessionHandle {
  constructor(
    public readonly sessionId: string,
    private readonly client: AcpClient,
    public readonly restoreMethod: AcpSessionRestoreMethod,
    public readonly configOptions?: unknown,
    public readonly resourceReport?: AppResourceReport | null,
  ) {}

  async prompt(promptText: string, options?: AcpPromptOptions): Promise<Result<unknown, AppError>> {
    return this.client.promptSession(this.sessionId, promptText, options)
  }

  get quota(): AcpAgentQuota | undefined {
    return this.client.getCachedQuota(this.sessionId)
  }

  async getQuota(): Promise<AcpAgentQuota | null> {
    return this.client.getQuota(this.sessionId)
  }

  get availableCommands(): AcpAvailableCommand[] | undefined {
    return this.client.getAvailableCommands(this.sessionId)
  }

  cancel(): Promise<Result<void, AppError>> {
    return this.client.cancelSession(this.sessionId)
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<Result<unknown, AppError>> {
    return this.client.setSessionConfigOption(this.sessionId, configId, value)
  }
}

/**
 * Driving Adapter: Public TypeScript/Node SDK Facade over `AcpClientEngine`.
 */
export class AcpClient {
  private readonly engine: AcpClientEngine

  constructor(options: AcpClientOptions) {
    const ports = createDefaultAcpPorts({
      runtimeRegistry: options.runtimeRegistry,
      terminalOutputByteLimit: options.terminalOutputByteLimit,
      overrides: options.ports,
    })
    this.engine = new AcpClientEngine(options, ports)
  }

  get currentStatus(): AcpConnectionStatus {
    return this.engine.currentStatus
  }

  get isConnected(): boolean {
    return this.engine.isConnected
  }

  get agent(): unknown {
    return this.engine.agent
  }

  get initializeResponse(): AgentInitializeResponse | null {
    return this.engine.initializeResponse
  }

  get resourceReport(): AppResourceReport | null {
    return this.engine.resourceReport
  }

  get runtimePlugin(): AcpRuntimePlugin {
    return this.engine.runtimePlugin
  }

  authenticate(methodId: string): Promise<Result<void, AppError>> {
    return this.engine.authenticate(methodId)
  }

  connect(): Promise<Result<{ status: AcpConnectionStatus; init: AgentInitializeResponse }, AppError>> {
    return this.engine.connect()
  }

  getCachedQuota(sessionId?: string): AcpAgentQuota | undefined {
    return this.engine.getCachedQuota(sessionId)
  }

  getQuota(sessionId?: string): Promise<AcpAgentQuota | null> {
    return this.engine.getQuota(sessionId)
  }

  getAvailableCommands(sessionId: string): AcpAvailableCommand[] | undefined {
    return this.engine.getAvailableCommands(sessionId)
  }

  waitForAvailableCommands(sessionId: string, timeoutMs = 150): Promise<AcpAvailableCommand[] | undefined> {
    return this.engine.waitForAvailableCommands(sessionId, timeoutMs)
  }

  async createSession(
    options?: AcpCreateSessionOptions,
  ): Promise<Result<AcpSessionHandle, AppError>> {
    const opened = await this.engine.createSession(options)
    if (!opened.ok) return opened
    return {
      ok: true,
      value: new AcpSessionHandle(
        opened.value.sessionId,
        this,
        opened.value.restoreMethod,
        opened.value.configOptions,
        opened.value.resourceReport,
      ),
    }
  }

  promptSession(
    sessionId: string,
    promptText: string,
    options?: AcpPromptOptions,
  ): Promise<Result<unknown, AppError>> {
    return this.engine.promptSession(sessionId, promptText, options)
  }

  cancelSession(sessionId: string): Promise<Result<void, AppError>> {
    return this.engine.cancelSession(sessionId)
  }

  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<unknown, AppError>> {
    return this.engine.setSessionConfigOption(sessionId, configId, value)
  }

  disconnect(reason?: string): Promise<void> {
    return this.engine.disconnect(reason)
  }
}
