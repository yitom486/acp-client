import {
  DEFAULT_ACP_RUNTIME_ID,
  err,
  ok,
  type AcpAgentQuota,
  type AcpConnectionStatus,
  type AcpPermissionOutcome,
  type AcpProxySettings,
  type AcpRuntimeInfo,
  type AcpSessionRestoreMethod,
  type AppError,
  type AppResourcePrep,
  type AppResourceReport,
  type Result,
} from '../domain/contracts'
import { AvailableCommandsCache, type AcpAvailableCommand } from '../domain/session/available-commands'
import { mergeSessionMeta, type AcpCodeMode } from '../domain/session/code-mode'
import { buildCompatGuideText, compatDeliveryKey } from '../domain/session/compat-guide'
import { QuotaCache } from '../domain/session/quota'
import {
  parseLoadSessionSupported,
  parseResumeSessionSupported,
} from '../domain/session/session-capabilities'
import type { AcpMcpHealthMonitor } from '../domain/transport/connection-health'
import {
  ACP_PROMPT_IDLE_TIMEOUT_MS,
  ACP_PROMPT_MAX_DURATION_MS,
  ACP_SDK_REQUEST_TIMEOUT_MS,
  SdkRequestTimeoutError,
  isAcpRuntimePlugin,
  type AcpRuntimePlugin,
  type AgentInitializeResponse,
  type AgentTransportConnection,
  type AgentTransportPort,
  type HostPathsPort,
  type ManagedAgentProcess,
  type ProcessLauncherPort,
  type ProvisionedSessionConfigHome,
  type ProxySettingsStorePort,
  type ResourceProvisionerPort,
  type ReadonlyRuntimeRegistryPort,
  type SdkRequestActivityController,
} from '../ports'
import { AcpMcpRecoveryCancelledError, AcpMcpSessionRecovery } from './mcp-session-recovery'
import { PermissionCoordinator, type PermissionCallback } from './permission-coordinator'
import { isAuthenticationRequired, restoreOrCreateAcpSession } from './session-open'

const ACP_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetConfigOption: 'session/set_config_option',
} as const

export interface AcpClientCallbacks {
  onPermissionRequest?: PermissionCallback
  onSessionUpdate?: (params: Record<string, unknown>) => void
  onStatusChange?: (status: AcpConnectionStatus, detail?: string) => void
  onStderrLine?: (line: string) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export interface AcpPromptOptions {
  timeoutMs?: number
  idleTimeoutMs?: number
  maxDurationMs?: number
  images?: Array<{ mimeType: string; data: string }>
}

export interface AcpCreateSessionOptions {
  resumeSessionId?: string | null
  mcpServers?: unknown[]
  mcpHealth?: AcpMcpHealthMonitor
  codeMode?: AcpCodeMode
}

export interface AcpSessionOpened {
  sessionId: string
  restoreMethod: AcpSessionRestoreMethod
  configOptions?: unknown
  resourceReport?: AppResourceReport | null
}

export interface AcpClientEngineOptions {
  /** Runtime id string, bare AcpRuntimeInfo, or a full self-contained AcpRuntimePlugin. */
  runtime?: string | AcpRuntimeInfo | AcpRuntimePlugin
  workspaceRoot: string
  clientInfo?: { name: string; version?: string }
  dataDir?: string
  proxy?: Partial<AcpProxySettings>
  env?: Record<string, string | undefined>
  requestTimeoutMs?: number
  promptIdleTimeoutMs?: number
  promptMaxDurationMs?: number
  quotaCacheTtlMs?: number
  maxReadBytes?: number
  terminalOutputByteLimit?: number
  resources?: {
    directory: string
    attachSkillsMcp?: boolean
    configurationScope?: 'overlay' | 'session'
  }
  callbacks?: AcpClientCallbacks
}

export interface AcpClientEnginePorts {
  runtimeRegistry: ReadonlyRuntimeRegistryPort
  transport: AgentTransportPort
  processLauncher: ProcessLauncherPort
  proxyStore: ProxySettingsStorePort
  paths: HostPathsPort
  resources: ResourceProvisionerPort
  defaultClientVersion: string
  defaultMaxReadBytes: number
  generateScopeKey: () => string
}

interface SessionLedgerEntry {
  restoreMethod: AcpSessionRestoreMethod
  gen: number
  skillsExposed: 'mcp-exposed' | 'none'
  nativeRules: boolean
}

/**
 * Pure Hexagonal Application Engine for ACP client connections and sessions.
 *
 * Depends strictly on `domain/` and `ports/` — zero Node.js I/O, zero
 * `@agentclientprotocol/sdk`, and zero hardcoded runtime implementations.
 */
export class AcpClientEngine {
  private readonly runtimeInfo: AcpRuntimeInfo
  private readonly plugin: AcpRuntimePlugin
  private readonly hasCustomRuntime: boolean
  private readonly workspaceRoot: string
  private readonly clientInfo: { name: string; version: string }
  private readonly dataDir: string
  private readonly proxyOverride?: Partial<AcpProxySettings>
  private readonly extraEnv: Record<string, string | undefined>
  private readonly requestTimeoutMs: number
  private readonly promptIdleTimeoutMs: number
  private readonly promptMaxDurationMs: number
  private readonly quotaCacheTtlMs: number
  private readonly maxReadBytes: number
  private readonly callbacks: AcpClientCallbacks
  private readonly resourcesDir: string | null
  private readonly attachSkillsMcp: boolean
  private readonly configurationScope: 'overlay' | 'session'
  private readonly processScopeKey: string

  private status: AcpConnectionStatus = 'disconnected'
  private processHandle: ManagedAgentProcess | null = null
  private connection: AgentTransportConnection | null = null
  private initResponse: AgentInitializeResponse | null = null
  private sessionConfig: ProvisionedSessionConfigHome | null = null
  private resourcePrep: { profileTag: string | null; report: AppResourceReport } | null = null
  private connectionGen = 0
  private authenticatingEndpoint: unknown
  private suppressRecoveryUpdates = false

  private readonly commandsCache = new AvailableCommandsCache()
  private readonly quotaCache = new QuotaCache()
  private readonly permissions = new PermissionCoordinator()
  private readonly mcpRecovery: AcpMcpSessionRecovery
  private readonly inflightTrackers = new Map<string, SdkRequestActivityController>()
  private readonly sessionLedger = new Map<string, SessionLedgerEntry>()
  private readonly compatSentKeys = new Set<string>()

  constructor(
    options: AcpClientEngineOptions,
    private readonly ports: AcpClientEnginePorts,
  ) {
    this.workspaceRoot = options.workspaceRoot
    this.clientInfo = {
      name: options.clientInfo?.name ?? 'acp-client',
      version: options.clientInfo?.version ?? ports.defaultClientVersion,
    }
    this.dataDir = options.dataDir ?? ports.paths.getDefaultDataDir()
    this.proxyOverride = options.proxy
    this.extraEnv = options.env ?? {}
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === 'number' && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : ACP_SDK_REQUEST_TIMEOUT_MS
    this.promptIdleTimeoutMs =
      typeof options.promptIdleTimeoutMs === 'number' && options.promptIdleTimeoutMs >= 0
        ? options.promptIdleTimeoutMs
        : ACP_PROMPT_IDLE_TIMEOUT_MS
    this.promptMaxDurationMs =
      typeof options.promptMaxDurationMs === 'number' && options.promptMaxDurationMs >= 0
        ? options.promptMaxDurationMs
        : ACP_PROMPT_MAX_DURATION_MS
    this.quotaCacheTtlMs =
      typeof options.quotaCacheTtlMs === 'number' && options.quotaCacheTtlMs >= 0
        ? options.quotaCacheTtlMs
        : 30_000
    this.maxReadBytes =
      typeof options.maxReadBytes === 'number' && options.maxReadBytes > 0
        ? options.maxReadBytes
        : ports.defaultMaxReadBytes

    if (options.resources && !ports.resources.isAbsolutePath(options.resources.directory)) {
      throw new Error('resources.directory 必须是本机绝对路径')
    }
    this.configurationScope = options.resources?.configurationScope ?? 'overlay'
    if (this.configurationScope !== 'overlay' && this.configurationScope !== 'session') {
      throw new Error('Invalid resources.configurationScope')
    }
    this.resourcesDir = options.resources?.directory ?? null
    this.attachSkillsMcp = options.resources?.attachSkillsMcp !== false
    this.callbacks = options.callbacks ?? {}
    this.processScopeKey = ports.generateScopeKey()

    // Resolve runtime plugin + manifest cleanly from string | AcpRuntimeInfo | AcpRuntimePlugin
    if (isAcpRuntimePlugin(options.runtime)) {
      this.plugin = options.runtime
      this.runtimeInfo = options.runtime.manifest
      this.hasCustomRuntime = false
    } else if (typeof options.runtime === 'object' && options.runtime !== null) {
      this.hasCustomRuntime = true
      this.runtimeInfo = options.runtime
      this.plugin = ports.runtimeRegistry.resolve(options.runtime.id)
    } else {
      const runtimeId = options.runtime ?? DEFAULT_ACP_RUNTIME_ID
      this.hasCustomRuntime = false
      const found = ports.runtimeRegistry.get(runtimeId)
      if (!found) {
        throw new Error(`未知或未注册的 ACP 运行时模板: ${runtimeId}`)
      }
      this.plugin = found
      this.runtimeInfo = found.manifest
    }

    this.mcpRecovery = new AcpMcpSessionRecovery({
      request: (method, params, signal) => {
        if (!this.connection) throw new AcpMcpRecoveryCancelledError('ACP connection closed')
        return this.connection.endpoint.request(method, params, { cancellationSignal: signal })
      },
      requestTimeoutMs: this.requestTimeoutMs,
      getCapabilities: () => ({
        resume: Boolean(
          this.initResponse &&
            parseResumeSessionSupported(this.initResponse.agentCapabilities ?? null),
        ),
        load: Boolean(
          this.initResponse &&
            parseLoadSessionSupported(this.initResponse.agentCapabilities ?? null),
        ),
      }),
      isConnected: () => this.isConnected,
      isBusy: (sessionId) => [...this.inflightTrackers.keys()].some((id) => id !== sessionId),
      onSuppressUpdates: (suppress) => {
        this.suppressRecoveryUpdates = suppress
      },
      onEvent: (event) =>
        this.callbacks.onLog?.('info', 'mcp.recovery.' + event.type, {
          sessionId: event.sessionId,
          method: event.method,
        }),
    })
  }

  get currentStatus(): AcpConnectionStatus {
    return this.status
  }

  get isConnected(): boolean {
    return this.status === 'connected' && this.connection !== null
  }

  get agent(): unknown {
    return this.connection?.rawAgent ?? this.connection?.endpoint ?? null
  }

  get initializeResponse(): AgentInitializeResponse | null {
    return this.initResponse
  }

  get resourceReport(): AppResourceReport | null {
    const report = this.resourcePrep?.report
    return report ? { ...report, skillsFound: [...report.skillsFound] } : null
  }

  get runtimePlugin(): AcpRuntimePlugin {
    return this.plugin
  }

  touchSessionActivity(sessionId?: string): void {
    if (sessionId) {
      this.inflightTrackers.get(sessionId)?.touch()
      return
    }
    for (const tracker of this.inflightTrackers.values()) {
      tracker.touch()
    }
  }

  pauseSessionActivity(sessionId?: string): () => void {
    if (sessionId) {
      return this.inflightTrackers.get(sessionId)?.pause() ?? (() => undefined)
    }
    const resumes = [...this.inflightTrackers.values()].map((tracker) => tracker.pause())
    let released = false
    return () => {
      if (released) return
      released = true
      for (const resume of resumes) resume()
    }
  }

  async authenticate(methodId: string): Promise<Result<void, AppError>> {
    const endpoint = this.connection?.endpoint
    if (!endpoint || !this.isConnected) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }
    const method = this.initResponse?.authMethods?.find((entry) => entry.id === methodId)
    if (!method) {
      return err({ code: 'INVALID_ARGUMENT', message: 'Agent 未声明此认证方式' })
    }
    if (method.type === 'terminal') {
      return err({ code: 'INVALID_ARGUMENT', message: '此认证方式需要在交互式终端中运行' })
    }
    if (this.authenticatingEndpoint === endpoint) {
      return err({ code: 'INVALID_STATE', message: 'Agent 正在认证' })
    }

    this.authenticatingEndpoint = endpoint
    try {
      await endpoint.request(ACP_METHODS.authenticate, { methodId }, { timeoutMs: this.requestTimeoutMs })
      if (this.connection?.endpoint !== endpoint) {
        return err({ code: 'CANCELLED', message: '认证期间 Agent 连接已关闭' })
      }
      return ok(undefined)
    } catch (error) {
      if (this.connection?.endpoint !== endpoint) {
        return err({ code: 'CANCELLED', message: '认证期间 Agent 连接已关闭' })
      }
      const message = error instanceof Error ? error.message : String(error)
      return err({
        code:
          error instanceof SdkRequestTimeoutError
            ? 'ACP_TIMEOUT'
            : isAuthenticationRequired(message)
              ? 'UNAUTHORIZED'
              : 'ACP_PROTOCOL_ERROR',
        message,
      })
    } finally {
      if (this.authenticatingEndpoint === endpoint) this.authenticatingEndpoint = undefined
    }
  }

  async connect(): Promise<
    Result<{ status: AcpConnectionStatus; init: AgentInitializeResponse }, AppError>
  > {
    if (this.inflightTrackers.size > 0) {
      return err({ code: 'ACP_PROTOCOL_ERROR', message: 'Agent 正在回答，请结束后重新连接' })
    }
    if (this.isConnected && this.initResponse) {
      return ok({ status: this.status, init: this.initResponse })
    }
    if (this.status === 'connecting') {
      return err({ code: 'ACP_PROTOCOL_ERROR', message: 'Agent 正在连接' })
    }

    this.connectionGen += 1
    this.mcpRecovery.reset()
    const connectGen = this.connectionGen

    try {
      this.setStatus('connecting')

      // 1. Pre-spawn blocker check
      const blocker = this.plugin.spawn?.resolveBlocker?.()
      if (blocker) {
        this.setStatus('error', blocker)
        return err({ code: 'ACP_SPAWN_ERROR', message: blocker })
      }

      // 2. Dynamic CLI command resolution (explicit custom AcpRuntimeInfo is never overwritten)
      const effectiveRuntime = { ...this.runtimeInfo }
      if (!this.hasCustomRuntime && this.plugin.spawn?.resolveCommand) {
        const resolved = this.plugin.spawn.resolveCommand()
        if (!resolved) {
          const message = `运行时 CLI 未安装: ${this.runtimeInfo.id}`
          this.setStatus('error', message)
          return err({ code: 'ACP_SPAWN_ERROR', message })
        }
        effectiveRuntime.command = resolved.command
        effectiveRuntime.args = resolved.args
      }

      // 3. Proxy & environment synthesis
      const storedProxy = await this.ports.proxyStore.read(this.dataDir)
      const effectiveProxy: AcpProxySettings = this.proxyOverride
        ? { ...storedProxy, ...this.proxyOverride }
        : storedProxy
      const proxyEnv = this.ports.proxyStore.buildSpawnEnv(effectiveProxy)
      const baseEnv = this.plugin.spawn?.getSpawnEnv?.(effectiveProxy) ?? proxyEnv
      const spawnEnv = {
        ...baseEnv,
        env: { ...(baseEnv.env ?? {}), ...this.extraEnv },
      }

      // 4. App resources preparation (overlay or isolated session scope)
      let resourceEnv: Record<string, string | undefined> = {}
      let profileTag: string | null = null
      if (this.resourcesDir && this.configurationScope === 'session') {
        const layout = this.plugin.resources?.sessionConfigLayout
        if (!layout) {
          throw new Error(`Session configuration home is not verified for runtime: ${this.runtimeInfo.id}`)
        }
        const profile = await this.ports.resources.createSessionConfigHome({
          runtimeId: this.runtimeInfo.id,
          resourcesDir: this.resourcesDir,
          layout,
        })
        if (connectGen !== this.connectionGen || this.currentStatus !== 'connecting') {
          await profile.dispose()
          return err({ code: 'CANCELLED', message: '连接已取消' })
        }
        this.sessionConfig = profile
        resourceEnv = profile.env
        const load = this.ports.resources.readResourcesDir(this.resourcesDir)
        this.resourcePrep = {
          profileTag: null,
          report: {
            rulesApplied: false,
            rulesPrepared: false,
            skillsApplied: false,
            rulesChars: load.rules?.chars ?? 0,
            profileDigest: this.ports.resources.digestResources(load),
            skillsFound: load.skills.map((s) => s.name),
            configurationScope: 'session',
            configurationDirectory: profile.directory,
            configurationRulesFile: profile.rulesFile,
            reason: profile.nativeRules
              ? 'isolated-config-not-runtime-verified'
              : 'isolated-config-rule-discovery-not-verified',
          },
        }
      } else if (this.resourcesDir && this.plugin.resources?.prepareOverlay) {
        try {
          const prep: AppResourcePrep = await this.plugin.resources.prepareOverlay({
            directory: this.resourcesDir,
            workspaceRoot: this.workspaceRoot,
            command: effectiveRuntime.command,
            env: spawnEnv.env,
          })
          if (prep.env) resourceEnv = prep.env
          prep.report.rulesPrepared = prep.report.rulesPrepared ?? prep.report.rulesApplied
          prep.report.rulesApplied = false
          prep.report.skillsApplied = false
          const digest = prep.report.profileDigest
          profileTag = digest ? `${this.runtimeInfo.id}:resources@${digest.slice(0, 16)}` : null
          this.resourcePrep = { profileTag, report: prep.report }
        } catch (error) {
          this.resourcePrep = {
            profileTag: null,
            report: {
              rulesApplied: false,
              rulesChars: 0,
              profileDigest: null,
              skillsFound: [],
              reason: 'prepare-failed',
            },
          }
          this.callbacks.onLog?.('warn', '应用资源准备失败，已回退兼容', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (this.resourcesDir) {
        const load = this.ports.resources.readResourcesDir(this.resourcesDir)
        this.resourcePrep = {
          profileTag: null,
          report: {
            rulesApplied: false,
            rulesPrepared: false,
            skillsApplied: false,
            rulesChars: load.rules?.chars ?? 0,
            profileDigest: this.ports.resources.digestResources(load),
            skillsFound: load.skills.map((s) => s.name),
            reason: 'runtime-not-supported',
          },
        }
      }

      const finalEnv = { ...spawnEnv.env, ...resourceEnv }

      await this.plugin.spawn?.beforeSpawn?.()
      if (connectGen !== this.connectionGen || this.currentStatus !== 'connecting') {
        return err({ code: 'CANCELLED', message: '连接已取消' })
      }

      // 5. Launch or reuse warm agent process
      let reuseDegraded = false
      let reusedProcess: ManagedAgentProcess | null = null
      if (profileTag) {
        const reuse = this.ports.processLauncher.tryReuse({
          runtimeId: this.runtimeInfo.id,
          scopeKey: this.processScopeKey,
          expectedTag: profileTag,
          isBusy: (proc) => this.inflightTrackers.size > 0 && this.processHandle === proc,
        })
        if (reuse.status === 'hit') {
          reusedProcess = reuse.process
        } else if (reuse.status === 'busy') {
          reusedProcess = reuse.process
          reuseDegraded = true
          this.callbacks.onLog?.(
            'warn',
            '应用资源摘要已变更但旧进程正忙，沿用旧进程并降级，新摘要下次冷启动生效',
          )
        }
      }

      const processHandle =
        reusedProcess ??
        this.ports.processLauncher.launch({
          runtime: effectiveRuntime,
          cwd: this.workspaceRoot,
          scopeKey: this.processScopeKey,
          env: finalEnv,
          envRemove: spawnEnv.envRemove,
          profileTag,
          onStderrLine: (line) => this.callbacks.onStderrLine?.(line),
          onExit: (code, signal) => {
            if (this.connectionGen !== connectGen) return
            this.callbacks.onLog?.('warn', `Agent 进程已退出 (code: ${code}, signal: ${signal})`)
            if (this.status === 'connected' || this.status === 'connecting') {
              void this.disconnect('Agent 进程异常终止')
            }
          },
        })
      this.processHandle = processHandle

      // 6. Connect ACP transport port
      this.connection = this.ports.transport.connect({
        process: processHandle,
        runtimeId: this.runtimeInfo.id,
        clientInfo: this.clientInfo,
        handlers: {
          getWorkspaceRoot: () => this.workspaceRoot,
          onPermission: (payload) =>
            this.permissions.handleRequest(this.callbacks.onPermissionRequest, payload),
          onSessionUpdate: (params) => {
            this.commandsCache.observe(params)
            this.quotaCache.observe(params, this.runtimeInfo.id)
            if (!this.suppressRecoveryUpdates) this.callbacks.onSessionUpdate?.(params)
          },
          onActivity: (sessionId) => this.touchSessionActivity(sessionId),
          onPauseActivity: (sessionId) => this.pauseSessionActivity(sessionId),
          maxReadBytes: this.maxReadBytes,
        },
      })

      // 7. ACP initialize handshake
      const initResp = await this.connection.endpoint.request<AgentInitializeResponse>(
        ACP_METHODS.initialize,
        {
          protocolVersion: 1,
          clientInfo: this.clientInfo,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            session: {
              configOptions: { boolean: {} },
            },
          },
        },
        { timeoutMs: this.requestTimeoutMs },
      )

      this.initResponse = initResp

      if (this.resourcePrep) {
        const bridgeVersion =
          typeof initResp.agentInfo?.version === 'string' ? initResp.agentInfo.version : undefined
        const normalizedVersion = bridgeVersion?.trim().replace(/^v/, '') ?? ''
        const allowedVersions = this.plugin.resources?.supportedBridgeVersions ?? []
        const supported = Boolean(normalizedVersion) && allowedVersions.includes(normalizedVersion)
        this.resourcePrep.report.bridgeVersion = bridgeVersion
        this.resourcePrep.report.bridgeSupported = supported
        if (this.processHandle) this.processHandle.bridgeVersion = bridgeVersion
        if (supported && this.resourcePrep.report.reason === 'native-session-version-not-verified') {
          delete this.resourcePrep.report.reason
        }
        if (!supported) {
          this.resourcePrep.report.reason =
            this.resourcePrep.report.reason ?? 'unsupported-bridge-version'
        }
        if (reuseDegraded) {
          this.resourcePrep.report.reason =
            this.resourcePrep.report.reason ?? 'busy-deferred-stale-rules'
        }
      }

      this.setStatus('connected')
      return ok({ status: 'connected', init: initResp })
    } catch (e) {
      if (connectGen !== this.connectionGen) {
        return err({ code: 'CANCELLED', message: '连接已被新请求取代' })
      }
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus('error', message)
      await this.disconnect(message)
      return err({
        code: e instanceof SdkRequestTimeoutError ? 'ACP_TIMEOUT' : 'ACP_PROTOCOL_ERROR',
        message,
      })
    }
  }

  getCachedQuota(sessionId?: string): AcpAgentQuota | undefined {
    return this.quotaCache.get(sessionId, this.runtimeInfo.id)
  }

  async getQuota(sessionId?: string): Promise<AcpAgentQuota | null> {
    const cached = this.getCachedQuota(sessionId)
    if (cached && this.quotaCacheTtlMs > 0 && Date.now() - cached.updatedAt < this.quotaCacheTtlMs) {
      return cached
    }
    if (this.plugin.quota?.probeQuota) {
      const probed = await this.plugin.quota.probeQuota({ sessionId })
      if (probed) {
        this.quotaCache.set(probed, sessionId)
        return probed
      }
    }
    return cached ?? null
  }

  getAvailableCommands(sessionId: string): AcpAvailableCommand[] | undefined {
    return this.commandsCache.get(sessionId)
  }

  waitForAvailableCommands(sessionId: string, timeoutMs = 150): Promise<AcpAvailableCommand[] | undefined> {
    return this.commandsCache.wait(sessionId, timeoutMs)
  }

  async createSession(
    options?: AcpCreateSessionOptions,
  ): Promise<Result<AcpSessionOpened, AppError>> {
    const endpoint = this.connection?.endpoint
    if (!endpoint) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }
    if (this.mcpRecovery.isRecovering) {
      return err({ code: 'ACP_PROTOCOL_ERROR', message: 'Wait for MCP recovery before opening another session' })
    }

    const generation = this.connectionGen
    const init = this.initResponse
    const resumeSupported = Boolean(init && parseResumeSessionSupported(init.agentCapabilities ?? null))
    const loadSupported = Boolean(init && parseLoadSessionSupported(init.agentCapabilities ?? null))

    try {
      let skillsExposed: 'mcp-exposed' | 'none' = 'none'
      let mcpServers = options?.mcpServers ?? []
      if (this.resourcesDir && this.attachSkillsMcp) {
        const descriptor = this.ports.resources.buildSkillsMcpServer(this.resourcesDir)
        if (!descriptor) {
          this.callbacks.onLog?.('warn', '技能 MCP 描述符构建失败，本次会话无技能 MCP')
        } else {
          const callerNames = new Set<string>()
          for (const entry of mcpServers) {
            if (
              entry !== null &&
              typeof entry === 'object' &&
              typeof (entry as { name?: unknown }).name === 'string'
            ) {
              callerNames.add((entry as { name: string }).name)
            }
          }
          if (callerNames.has(descriptor.name)) {
            this.callbacks.onLog?.('warn', '调用方已有同名技能 MCP 服务，保留调用方版本', {
              name: descriptor.name,
            })
          } else {
            mcpServers = [...mcpServers, descriptor]
            skillsExposed = 'mcp-exposed'
          }
        }
      }

      const sessionMeta = mergeSessionMeta(
        (!this.sessionConfig || this.runtimeInfo.id === 'agy') &&
          this.resourcesDir &&
          this.resourcePrep?.report.bridgeSupported
          ? this.plugin.resources?.sessionMeta?.(this.resourcesDir)
          : undefined,
        options?.codeMode,
        this.initResponse?.agentCapabilities,
      )

      const openResult = await restoreOrCreateAcpSession({
        request: (method, params) => endpoint.request(method, params, { timeoutMs: this.requestTimeoutMs }),
        cwd: this.workspaceRoot,
        resumeSessionId: options?.resumeSessionId ?? null,
        resumeSupported,
        loadSupported,
        mcpServers,
        sessionMeta,
        preserveMcpOnRetry: true,
        log: (level, msg, meta) => this.callbacks.onLog?.(level, msg, meta),
      })

      if (generation !== this.connectionGen || !this.isConnected) {
        return err({ code: 'CANCELLED', message: 'Connection changed while opening session' })
      }
      if (!openResult.mcpServersAccepted) skillsExposed = 'none'
      if (options?.mcpHealth && mcpServers.length) {
        this.mcpRecovery.register({
          sessionId: openResult.sessionId,
          cwd: this.workspaceRoot,
          mcpServers,
          sessionMeta: openResult.nativeSessionAccepted ? sessionMeta : undefined,
          monitor: options.mcpHealth,
        })
      }

      this.sessionLedger.set(openResult.sessionId, {
        restoreMethod: openResult.restoreMethod,
        gen: this.connectionGen,
        skillsExposed,
        nativeRules: openResult.nativeSessionAccepted,
      })

      const resourceReport: AppResourceReport | null = this.resourcePrep?.report
        ? {
            ...this.resourcePrep.report,
            skillsFound: [...this.resourcePrep.report.skillsFound],
            skillsExposed,
            rulesApplied:
              openResult.nativeSessionAccepted ||
              (!this.plugin.resources?.sessionMeta &&
                openResult.restoreMethod === 'new' &&
                this.resourcePrep.report.bridgeSupported === true &&
                this.resourcePrep.report.rulesPrepared === true),
            ...(openResult.restoreMethod !== 'new' && !openResult.nativeSessionAccepted
              ? { reason: 'session-restored-not-verified' }
              : {}),
          }
        : null

      return ok({
        sessionId: openResult.sessionId,
        restoreMethod: openResult.restoreMethod,
        configOptions: openResult.configOptions,
        resourceReport,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err({
        code:
          e instanceof SdkRequestTimeoutError
            ? 'ACP_TIMEOUT'
            : isAuthenticationRequired(message)
              ? 'UNAUTHORIZED'
              : 'ACP_PROTOCOL_ERROR',
        message,
      })
    }
  }

  async promptSession(
    sessionId: string,
    promptText: string,
    options?: AcpPromptOptions,
  ): Promise<Result<unknown, AppError>> {
    const endpoint = this.connection?.endpoint
    if (!endpoint) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }
    if (!this.isConnected) return err({ code: 'ACP_NOT_CONNECTED', message: 'Agent is not connected' })
    if (this.inflightTrackers.has(sessionId)) {
      return err({ code: 'ACP_PROTOCOL_ERROR', message: 'Session already has an in-flight prompt' })
    }

    const generation = this.connectionGen
    const tracker = endpoint.createActivityController()
    this.inflightTrackers.set(sessionId, tracker)

    try {
      await this.mcpRecovery.ensureReady(sessionId)
      if (generation !== this.connectionGen || !this.isConnected) {
        throw new AcpMcpRecoveryCancelledError('ACP connection changed')
      }

      const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }]
      for (const image of options?.images ?? []) {
        if (!image?.data || !image?.mimeType) continue
        prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data })
      }

      const compat = this.buildCompatPrepend(sessionId)
      const blocks = compat ? [{ type: 'text', text: compat }, ...prompt] : prompt

      const hasIdleOption = options?.idleTimeoutMs !== undefined
      const hasTimeoutOption = options?.timeoutMs !== undefined
      const idleTimeoutMs = hasIdleOption
        ? options!.idleTimeoutMs!
        : hasTimeoutOption
          ? 0
          : this.promptIdleTimeoutMs
      const maxDurationMs = options?.maxDurationMs ?? options?.timeoutMs ?? this.promptMaxDurationMs

      const response = await endpoint.requestWithActivity(
        ACP_METHODS.sessionPrompt,
        { sessionId, prompt: blocks },
        { idleTimeoutMs, maxDurationMs, activity: tracker },
      )
      return ok(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (e instanceof AcpMcpRecoveryCancelledError) return err({ code: 'CANCELLED', message })
      if (e instanceof SdkRequestTimeoutError) {
        this.permissions.cancel('session_cancelled', sessionId)
        void this.connection?.endpoint
          .notify(ACP_METHODS.sessionCancel, { sessionId })
          .catch(() => undefined)
        return err({ code: 'ACP_TIMEOUT', message })
      }
      return err({
        code: isAuthenticationRequired(message) ? 'UNAUTHORIZED' : 'ACP_PROTOCOL_ERROR',
        message,
      })
    } finally {
      if (generation === this.connectionGen) this.inflightTrackers.delete(sessionId)
    }
  }

  private buildCompatPrepend(sessionId: string): string | null {
    if (!this.resourcesDir) return null
    if (this.sessionConfig?.nativeRules) return null
    const entry = this.sessionLedger.get(sessionId)
    if (!entry) return null
    const connReport = this.resourcePrep?.report
    const nativelyDelivered =
      entry.nativeRules ||
      (!this.plugin.resources?.sessionMeta &&
        entry.restoreMethod === 'new' &&
        entry.gen === this.connectionGen &&
        connReport?.rulesPrepared === true &&
        connReport?.bridgeSupported === true)
    if (nativelyDelivered) return null

    const load = this.ports.resources.readResourcesDir(this.resourcesDir)
    const rulesText = this.ports.resources.readRulesText(this.resourcesDir)
    const digest = this.ports.resources.digestResources(load)
    const key = compatDeliveryKey(sessionId, this.connectionGen, digest)
    if (this.compatSentKeys.has(key)) return null

    const text = buildCompatGuideText({
      rulesText,
      skills: load.skills.map((s) => ({ name: s.name, description: s.description })),
      skillsViaMcp: entry.skillsExposed === 'mcp-exposed',
      digest,
      sessionId,
      generation: this.connectionGen,
    })
    if (!text) return null
    this.compatSentKeys.add(key)
    return text
  }

  async cancelSession(sessionId: string): Promise<Result<void, AppError>> {
    this.mcpRecovery.cancel(sessionId)
    const endpoint = this.connection?.endpoint
    if (!endpoint) return err({ code: 'ACP_NOT_CONNECTED', message: 'Agent is not connected' })
    try {
      const notifying = endpoint.notify(ACP_METHODS.sessionCancel, { sessionId })
      this.permissions.cancel('session_cancelled', sessionId)
      await notifying
      return ok(undefined)
    } catch (error) {
      return err({
        code: 'ACP_PROTOCOL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<unknown, AppError>> {
    const endpoint = this.connection?.endpoint
    if (!endpoint) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }
    try {
      const response = await endpoint.request(
        ACP_METHODS.sessionSetConfigOption,
        { sessionId, configId, value },
        { timeoutMs: this.requestTimeoutMs },
      )
      return ok(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err({
        code: e instanceof SdkRequestTimeoutError ? 'ACP_TIMEOUT' : 'ACP_PROTOCOL_ERROR',
        message,
      })
    }
  }

  async disconnect(reason?: string): Promise<void> {
    ++this.connectionGen
    this.mcpRecovery.reset()
    this.inflightTrackers.clear()
    this.permissions.cancel('connection_closed')
    this.setStatus('disconnected', reason)
    this.resourcePrep = null

    const capabilities = this.initResponse?.agentCapabilities?.sessionCapabilities as
      | Record<string, unknown>
      | undefined
    if (capabilities?.close && this.connection) {
      const failed = await this.connection.endpoint.closeSessions(this.sessionLedger.keys())
      if (failed.length) {
        this.callbacks.onLog?.('warn', 'Session close failed before process teardown', {
          count: failed.length,
        })
      }
    }

    this.sessionLedger.clear()
    this.compatSentKeys.clear()

    try {
      this.connection?.close()
    } catch {
      // ignore teardown errors
    } finally {
      this.connection = null
      this.initResponse = null
    }

    if (this.processHandle && this.processHandle.isAlive()) {
      try {
        this.processHandle.kill()
      } catch {
        // ignore kill errors
      }
      this.processHandle = null
    }

    const config = this.sessionConfig
    this.sessionConfig = null
    if (config) {
      try {
        await config.dispose()
      } catch {
        this.callbacks.onLog?.('warn', 'Session configuration cleanup failed; directory retained', {
          directory: config.directory,
        })
      }
    }
  }

  private setStatus(status: AcpConnectionStatus, detail?: string): void {
    this.status = status
    this.callbacks.onStatusChange?.(status, detail)
  }
}
