import { closeAcpSessions } from './sdk-client'
import { createSessionConfigHome, type SessionConfigHome } from '../resources/session-config'
import { AvailableCommandsCache, type AcpAvailableCommand } from '../session/available-commands'
import { QuotaCache } from '../session/quota'
import type { AcpAgentQuota } from '../contracts'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  methods,
  RequestError,
  type ClientApp,
  type ClientConnection,
  type InitializeResponse,
} from '@agentclientprotocol/sdk'
import type {
  AcpAuthMethod,
  AcpConnectionStatus,
  AcpPermissionOutcome,
  AcpProxySettings,
  AcpRuntimeInfo,
  AcpSessionRestoreMethod,
  AppError,
  CodexAuthPreflight,
  InkdownVirtualResource,
} from "../contracts"
import { DEFAULT_ACP_RUNTIME_ID, err, ok, type Result } from "../contracts"
import { findBuiltinAcpRuntime } from "../contracts"
import { getAcpRuntimeAdapter, type AcpRuntimeAdapter } from '../runtimes'
import {
  getLiveAcpProcess,
  isSpawnedAcpProcessAlive,
  spawnAcpProcess,
  tryReuseLiveAcpProcess,
  type SpawnedAcpProcess,
} from '../process/process-manager'
import { connectSdkClient, sdkRequest, type SdkStreamHandle } from './sdk-client'
import { registerAcpClientHandlers, type AcpClientHandlerDeps } from './client-handlers'
import { restoreOrCreateAcpSession, type RestoreOrCreateSessionResult } from './session-open'
import { AcpTerminalManager } from './acp-terminal'
import { buildAcpProxySpawnEnv, readAcpProxySettings } from './acp-proxy-service'
import { getDefaultAgentDataDir } from './acp-paths'
import type { AppResourceReport } from '../resources/app-resources'
import { readAppResourcesDir, isAbsolutePathLike, readAppRulesText, digestAppResources } from '../resources/app-resources'
import { buildCompatGuideText, compatDeliveryKey } from '../session/compat-guide'
import { APP_SKILLS_MCP_SERVER_NAME, buildAppSkillsMcpServer } from '../mcp/app-skills-mcp'
import { randomUUID } from 'node:crypto'
import { isSupportedBridgeVersion } from '../resources/eligibility'
import { runConnectAuthGate } from '../auth/connect-auth-gate'
import {
  parseLoadSessionSupported,
  parsePromptCapabilities,
  parseResumeSessionSupported,
} from '../session/session-capabilities'

export interface AcpClientCallbacks {
  /** 权限审批回调：当 Agent 尝试执行工具调用或敏感操作时触发 */
  onPermissionRequest?: (payload: {
    sessionId?: string
    toolCall?: { id?: string; title?: string; kind?: string }
    params: Record<string, unknown>
  }) => Promise<AcpPermissionOutcome>
  /** 会话内容流式/状态更新通知 */
  onSessionUpdate?: (params: Record<string, unknown>) => void
  /** 连接状态机变化通知 */
  onStatusChange?: (status: AcpConnectionStatus, detail?: string) => void
  /** Agent 进程 stderr 输出行（供排错与诊断） */
  onStderrLine?: (line: string) => void
  /** 虚拟文件读取（默认不支持，除非宿主提供） */
  readSnapshot?: (resource: InkdownVirtualResource) => Promise<string>
  /** 日志打印 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export interface AcpClientOptions {
  /** 运行时标识，如 'codex-acp', 'claude', 'cursor-cli', 'deepseek', 'gemini' 等 */
  runtime?: string | AcpRuntimeInfo
  /** 工作区根目录路径（必需） */
  workspaceRoot: string
  /** 客户端信息声明（向 Agent 表明调用方身份） */
  clientInfo?: {
    name: string
    version?: string
  }
  /** 数据持久化目录（缺省自动根据操作系统返回标准路径） */
  dataDir?: string
  /** 代理配置（覆盖默认配置文件） */
  proxy?: Partial<AcpProxySettings>
  /** 附加环境变量 */
  env?: NodeJS.ProcessEnv
  /**
   * 应用资源目录（单目录接口）：`{ directory: 绝对路径 }`，
   * 含 AGENTS.md 与 skills/ 下 SKILL.md。提供即走原生资源准备
   * （读取/合并/注入/报告），缺席则保持旧行为一字不动。
   * `attachSkillsMcp` 缺省 true：建会话时自动挂载技能 MCP（调用方
   * 同名服务优先保留）；显式 false 关闭自动挂载。
   * configurationScope=session：子进程独占临时原生配置根，断开清理；
   * 不复制认证。缺省 overlay 保持现有用户登录环境。
   */
  resources?: { directory: string; attachSkillsMcp?: boolean; configurationScope?: 'overlay' | 'session' }
  /** 事件与审批回调 */
  callbacks?: AcpClientCallbacks
}

export class AcpSessionHandle {
  constructor(
    public readonly sessionId: string,
    private readonly client: AcpClient,
    public readonly restoreMethod: AcpSessionRestoreMethod,
    public readonly configOptions?: unknown,
    /** 建会话时刻的应用资源加载报告快照（规则/技能分开记录） */
    public readonly resourceReport?: AppResourceReport | null,
  ) {}

  /** 向当前会话发送 Prompt / 消息交互 */
  async prompt(promptText: string, options?: { timeoutMs?: number; images?: Array<{ mimeType: string; data: string }> }): Promise<Result<unknown, AppError>> {
    return this.client.promptSession(this.sessionId, promptText, options)
  }

  /** Agent 通过 available_commands_update 提供的斜杠命令（调用 = prompt 发送 `/name args` 文本） */
  /** 当前会话最近获取或解析到的配额（5h / 周额度 / 余额） */
  get quota(): AcpAgentQuota | undefined {
    return this.client.getCachedQuota(this.sessionId)
  }

  /** 主动获取/刷新配额（优先缓存，过期或无缓存时触发适配器探针） */
  async getQuota(): Promise<AcpAgentQuota | null> {
    return this.client.getQuota(this.sessionId)
  }

  get availableCommands(): AcpAvailableCommand[] | undefined {
    return this.client.getAvailableCommands(this.sessionId)
  }

  /** 修改会话配置项（如模型 ID、模式等） */
  async setConfigOption(configId: string, value: string | boolean): Promise<Result<unknown, AppError>> {
    return this.client.setSessionConfigOption(this.sessionId, configId, value)
  }
}

/**
 * 独立的 Headless ACP 客户端：
 * - 纯 TypeScript / Node.js 实现，零 Electron 依赖；
 * - 统一管理多种 Agent 运行时（Codex, Claude, Cursor, DeepSeek 等）；
 * - 自动负责子进程生命周期、Stdio 传输桥接、协议握手与断线清理；
 * - 可在任意 Node.js 项目、CLI 命令行工具或 Web 服务中直接复用。
 */
export class AcpClient {
  private status: AcpConnectionStatus = 'disconnected'
  private readonly commandsCache = new AvailableCommandsCache()
  private readonly quotaCache = new QuotaCache()
  private runtimeInfo: AcpRuntimeInfo
  private adapter: AcpRuntimeAdapter
  private readonly workspaceRoot: string
  private readonly clientInfo: { name: string; version: string }
  private readonly dataDir: string
  private readonly extraEnv: NodeJS.ProcessEnv
  private readonly configurationScope: 'overlay' | 'session'
  private sessionConfig: SessionConfigHome | null = null
  private readonly resourcesDir: string | null
  private readonly processScopeKey = randomUUID()
  private readonly callbacks: AcpClientCallbacks
  private readonly terminals = new AcpTerminalManager()

  private processHandle: SpawnedAcpProcess | null = null
  private sdkApp: ClientApp | null = null
  private sdkConnection: ClientConnection | null = null
  private streamHandle: SdkStreamHandle | null = null
  private initResponse: InitializeResponse | null = null
  /** 在途 prompt 会话集合（忙时不打断温进程的判定依据） */
  private readonly inflightPrompts = new Set<string>()
  /** 本次连接周期的应用资源准备结果（无 resources 入口时为 null） */
  private resourcePrep: { profileTag: string | null; report: AppResourceReport } | null = null
  /** 连接代次（connect 推进；兼容记账与重连后重附带的诊断依据） */
  private connectionGen = 0
  /** 是否自动挂载技能 MCP（resources.attachSkillsMcp，缺省 true） */
  private readonly attachSkillsMcp: boolean
  /**
   * 会话兼容记账：sessionId → { 建会话时的恢复方式/代次/技能暴露 }。
   * 兼容引导按“会话 + 代次 + 资源摘要”键只发一次；取消/失败不重置；
   * 断开即清空（会话随进程消亡）。
   */
  private readonly sessionLedger = new Map<
    string,
    { restoreMethod: string; gen: number; skillsExposed: 'mcp-exposed' | 'none'; nativeRules?: boolean }
  >()
  /** 已发送兼容引导的交付键（见 compatDeliveryKey，有界不累积） */
  private readonly compatSentKeys = new Set<string>()
  /** 已发送兼容引导的快照（同一次交付的正文与摘要配对，不混版本） */
  private readonly compatSnapshots = new Map<string, { text: string; digest: string | null }>()
  /** 当前连接的应用资源加载报告（规则/技能分开记录；无则为 null） */
  get resourceReport(): AppResourceReport | null {
    const report = this.resourcePrep?.report
    return report ? { ...report, skillsFound: [...report.skillsFound] } : null
  }

  constructor(options: AcpClientOptions) {
    this.workspaceRoot = options.workspaceRoot
    this.clientInfo = {
      name: options.clientInfo?.name ?? 'inkdown',
      version: options.clientInfo?.version ?? '0.1.1',
    }
    this.dataDir = options.dataDir ?? getDefaultAgentDataDir()
    this.extraEnv = options.env ?? {}
    if (options.resources && !isAbsolutePathLike(options.resources.directory)) {
      throw new Error('resources.directory 必须是本机绝对路径')
    }
    this.configurationScope = options.resources?.configurationScope ?? 'overlay'
    if (!['overlay','session'].includes(this.configurationScope)) throw new Error('Invalid resources.configurationScope')
    this.resourcesDir = options.resources?.directory ?? null
    this.attachSkillsMcp = options.resources?.attachSkillsMcp !== false
    this.callbacks = options.callbacks ?? {}

    const runtimeId =
      typeof options.runtime === 'string'
        ? options.runtime
        : options.runtime?.id ?? DEFAULT_ACP_RUNTIME_ID

    this.adapter = getAcpRuntimeAdapter(runtimeId)

    if (typeof options.runtime === 'object' && options.runtime !== null) {
      this.runtimeInfo = options.runtime
    } else {
      const found = findBuiltinAcpRuntime(runtimeId)
      if (!found) {
        throw new Error(`未知或未注册的 ACP 运行时模板: ${runtimeId}`)
      }
      this.runtimeInfo = found
    }
  }

  get currentStatus(): AcpConnectionStatus {
    return this.status
  }

  get isConnected(): boolean {
    return this.status === 'connected' && Boolean(this.sdkConnection?.agent)
  }

  /** 获取底层当前 Agent 的 RPC 客户端句柄 */
  get agent() {
    return this.sdkConnection?.agent ?? null
  }

  get initializeResponse(): InitializeResponse | null {
    return this.initResponse
  }

  /**
   * 启动并连接 Agent：
   * 1. 预检判停（如缺少 API Key、未安装 CLI）；
   * 2. 跨平台拉起后台守护子进程；
   * 3. 建立 Stdio pass-through 与 ndJsonStream 桥接；
   * 4. 注册权限与 FS 回调；
   * 5. 执行 initialize 协议握手。
   */
  async connect(): Promise<Result<{ status: AcpConnectionStatus; init: InitializeResponse }, AppError>> {
    if (this.inflightPrompts.size > 0) return err({ code: 'ACP_PROTOCOL_ERROR', message: 'Agent 正在回答，请结束后重新连接' })
    if (this.isConnected && this.initResponse) return ok({ status: this.status, init: this.initResponse })
    // 新连接周期开始：代次推进（兼容记账与重连后重附带的键）；旧会话记账保留
    // 至 disconnect（会话随进程消亡，重连后旧 id 按新代次重新评估）。
    if (this.currentStatus === 'connecting') return err({code:'ACP_PROTOCOL_ERROR',message:'Agent 正在连接'})
    this.connectionGen += 1
    const connectGen=this.connectionGen
    try {
      this.setStatus('connecting')

      // 1. 预检判停
      const blocker = this.adapter.resolveSpawnBlocker?.()
      if (blocker) {
        this.setStatus('error', blocker)
        return err({ code: 'ACP_SPAWN_ERROR', message: blocker })
      }

      // 2. 命令行路径动态解析（如 Cursor 探测 agent.cmd / PATH）
      let effectiveRuntime = { ...this.runtimeInfo }
      if (this.adapter.resolveSpawnCommand) {
        const resolved = this.adapter.resolveSpawnCommand()
        if (!resolved) {
          const message = `运行时 CLI 未安装: ${this.runtimeInfo.id}`
          this.setStatus('error', message)
          return err({ code: 'ACP_SPAWN_ERROR', message })
        }
        effectiveRuntime.command = resolved.command
        effectiveRuntime.args = resolved.args
      }

      // 3. 代理与环境变量合成
      const storedProxy = await readAcpProxySettings(this.dataDir)
      const proxyEnv = buildAcpProxySpawnEnv(storedProxy)
      const baseEnv = this.adapter.getSpawnEnv?.(storedProxy) ?? proxyEnv
      // 调用方附加环境（如自定义供应商 CODEX_HOME/KEY）显式优先于代理合成；
      // 无附加时行为与旧版完全一致。
      const spawnEnv = {
        ...baseEnv,
        env: { ...(baseEnv.env ?? {}), ...(this.extraEnv ?? {}) },
      }

      // 应用资源准备（单目录接口）：仅当宿主传入 resources.directory 且
      // adapter 声明 prepareAppResources 时执行；准备失败不阻断连接，
      // 明确记为未应用。注入顺序置后（resources 意图优先于通用 env）。
      let resourceEnv: NodeJS.ProcessEnv = {}
      let profileTag: string | null = null
      if (this.resourcesDir && this.configurationScope === 'session') {
        const profile = await createSessionConfigHome(this.runtimeInfo.id, this.resourcesDir)
        if (connectGen !== this.connectionGen || this.status !== 'connecting') {
          await profile.dispose()
          return err({code:'CANCELLED',message:'连接已取消'})
        }
        this.sessionConfig = profile
        resourceEnv = this.sessionConfig.env
        const load = readAppResourcesDir(this.resourcesDir)
        this.resourcePrep = {profileTag:null,report:{
          rulesApplied:false,rulesPrepared:false,skillsApplied:false,
          rulesChars:load.rules?.chars??0,profileDigest:digestAppResources(load),skillsFound:load.skills.map(s=>s.name),
          configurationScope:'session',configurationDirectory:this.sessionConfig.directory,
          configurationRulesFile:this.sessionConfig.rulesFile,
          reason:this.sessionConfig.nativeRules ? 'isolated-config-not-runtime-verified' : 'isolated-config-rule-discovery-not-verified',
        }}
      } else if (this.resourcesDir && this.adapter.prepareAppResources) {
        try {
          const prep = await this.adapter.prepareAppResources({
            directory: this.resourcesDir,
            command: effectiveRuntime.command,
            workspaceRoot: this.workspaceRoot,
            env: { ...process.env, ...spawnEnv.env },
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
      } else {
        const load = this.resourcesDir ? readAppResourcesDir(this.resourcesDir) : null
        this.resourcePrep = load ? { profileTag: null, report: {
          rulesApplied: false, rulesPrepared: false, skillsApplied: false,
          rulesChars: load.rules?.chars ?? 0, profileDigest: digestAppResources(load),
          skillsFound: load.skills.map(s => s.name), reason: 'runtime-not-supported',
        } } : null
      }
      const finalEnv = { ...spawnEnv.env, ...resourceEnv }

      // 4. 冷启动/生命周期钩子
      await this.adapter.beforeSpawn?.()
      if (connectGen !== this.connectionGen || this.status !== 'connecting') return err({code:'CANCELLED',message:'连接已取消'})

      // 5. 启动或复用进程：resources 路径按绑定标签复用（命中跳过 spawn；
      // 摘要变更而旧进程忙则沿用旧进程由 tryReuse 判定，不杀不断）；
      // 无 resources 入口时沿旧行为每次 spawn（spawn 内清同键旧句柄）。
      let reuseDegraded = false
      let reusedHandle: SpawnedAcpProcess | null = null
      if (profileTag) {
        const reuse = tryReuseLiveAcpProcess(this.runtimeInfo.id, {
          expectedTag: profileTag,
          scopeKey: this.processScopeKey,
          isBusy: (h) => this.inflightPrompts.size > 0 && this.processHandle === h,
        })
        if (reuse.status === 'hit') {
          reusedHandle = reuse.handle
        } else if (reuse.status === 'busy') {
          reusedHandle = reuse.handle
          reuseDegraded = true
          this.callbacks.onLog?.('warn', '应用资源摘要已变更但旧进程正忙，沿用旧进程并降级，新摘要下次冷启动生效')
        }
      }
      const processHandle = reusedHandle ?? spawnAcpProcess({
        runtime: effectiveRuntime,
        cwd: this.workspaceRoot,
        scopeKey: this.processScopeKey,
        env: finalEnv,
        envRemove: spawnEnv.envRemove,
        profileTag,
        onStderrLine: (line) => {
          this.callbacks.onStderrLine?.(line)
        },
        onExit: (code, signal) => {
          if (this.connectionGen !== connectGen) return
          this.callbacks.onLog?.('warn', `Agent 进程已退出 (code: ${code}, signal: ${signal})`)
          if (this.status === 'connected' || this.status === 'connecting') {
            void this.disconnect('Agent 进程异常终止')
          }
        },
      })
      this.processHandle = processHandle

      // 6. 建立 SDK 桥接
      const handlerDeps: AcpClientHandlerDeps = {
        getWorkspaceRoot: () => this.workspaceRoot,
        terminals: this.terminals,
        readSnapshot: async (resource) => {
          if (!this.callbacks.readSnapshot) {
            throw new Error(`当前宿主未实现 readSnapshot 回调: ${resource}`)
          }
          return this.callbacks.readSnapshot(resource)
        },
        onPermission: async (payload) => {
          if (this.callbacks.onPermissionRequest) {
            return this.callbacks.onPermissionRequest({
              sessionId: payload.sessionId,
              toolCall: (payload.params as any)?.toolCall,
              params: payload.params,
            })
          }
          // 默认保守：未提供审批回调时不静默同意，安全返回取消
          return { outcome: 'cancelled' }
        },
        onSessionUpdate: (params) => {
          // Cache before forwarding so the list is readable even if the host
          // has not learned this sessionId yet (commands usually arrive right
          // after session/new|load|resume returns).
          this.commandsCache.observe(params)
          this.quotaCache.observe(params, this.runtimeInfo.id)
          this.callbacks.onSessionUpdate?.(params)
        },
      }

      const { app, connection, streamHandle } = connectSdkClient(
        processHandle.child,
        (clientApp) => {
          registerAcpClientHandlers(clientApp, handlerDeps)
        },
        this.runtimeInfo.id,
      )

      this.sdkApp = app
      this.sdkConnection = connection
      this.streamHandle = streamHandle

      // 7. initialize 握手
      const initResp = await sdkRequest<InitializeResponse, unknown>(
        connection.agent,
        methods.agent.initialize,
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
      )

      this.initResponse = initResp
      // 桥版本门（证据门）：记录握手返回的真实版本；未知/越界即不支持，
      // 由宿主决定兼容，不冒充 native。仅 resources 路径记录。
      if (this.resourcePrep) {
        const agentInfo = (initResp as { agentInfo?: { version?: unknown } })?.agentInfo
        const bridgeVersion = typeof agentInfo?.version === 'string' ? agentInfo.version : undefined
        const supported = isSupportedBridgeVersion(this.runtimeInfo.id, bridgeVersion).eligible
          && (this.adapter.supportedBridgeVersions?.includes(bridgeVersion?.replace(/^v/, '') ?? '') ?? false)
        this.resourcePrep.report.bridgeVersion = bridgeVersion
        this.resourcePrep.report.bridgeSupported = supported
        if (this.processHandle) this.processHandle.bridgeVersion = bridgeVersion
        if (supported && this.resourcePrep.report.reason === 'native-session-version-not-verified') delete this.resourcePrep.report.reason
        if (!supported) {
          this.resourcePrep.report.reason = this.resourcePrep.report.reason ?? 'unsupported-bridge-version'
        }
        // 忙时延后：沿用旧进程，环境内是旧摘要规则，明确记为过期应用
        if (reuseDegraded) {
          this.resourcePrep.report.reason = this.resourcePrep.report.reason ?? 'busy-deferred-stale-rules'
        }
      }
      this.setStatus('connected')
      return ok({ status: 'connected', init: initResp })
    } catch (e) {
      if (connectGen !== this.connectionGen) return err({code:'CANCELLED',message:'连接已被新请求取代'})
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus('error', message)
      await this.disconnect(message)
      return err({ code: 'ACP_PROTOCOL_ERROR', message })
    }
  }

  /** 最近一次 available_commands_update 的命令列表（未收到过则为 undefined） */
  getCachedQuota(sessionId?: string): AcpAgentQuota | undefined {
    return this.quotaCache.get(sessionId, this.runtimeInfo.id)
  }

  async getQuota(sessionId?: string): Promise<AcpAgentQuota | null> {
    const cached = this.getCachedQuota(sessionId)
    if (cached && Date.now() - cached.updatedAt < 30_000) {
      return cached
    }
    if (this.adapter.probeQuota) {
      const probed = await this.adapter.probeQuota({ sessionId })
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

  /** 等待某会话的命令列表（已缓存则立即返回；超时返回 undefined） */
  waitForAvailableCommands(sessionId: string, timeoutMs = 150): Promise<AcpAvailableCommand[] | undefined> {
    return this.commandsCache.wait(sessionId, timeoutMs)
  }

  /** 创建或恢复会话 */
  async createSession(options?: {
    resumeSessionId?: string | null
    mcpServers?: unknown[]
  }): Promise<Result<AcpSessionHandle, AppError>> {
    if (!this.sdkConnection?.agent) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }

    const agent = this.sdkConnection.agent
    const init = this.initResponse

    const resumeSupported = Boolean(
      init && parseResumeSessionSupported(init.agentCapabilities as any),
    )
    const loadSupported = Boolean(
      init && parseLoadSessionSupported(init.agentCapabilities as any),
    )

    try {
      // 技能 MCP 自动挂载：resources 生效且未显式关闭时，把 SDK 通用只读
      // 技能服务并入会话 MCP 列表；调用方同名服务优先保留并告警，不覆盖。
      let skillsExposed: 'mcp-exposed' | 'none' = 'none'
      let mcpServers = options?.mcpServers ?? []
      if (this.resourcesDir && this.attachSkillsMcp) {
        try {
          const descriptor = buildAppSkillsMcpServer(this.resourcesDir)
          const callerNames = new Set<string>()
          for (const entry of mcpServers) {
            if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
              callerNames.add((entry as { name: string }).name)
            }
          }
          if (callerNames.has(descriptor.name)) {
            this.callbacks.onLog?.('warn', '调用方已有同名技能 MCP 服务，保留调用方版本', { name: descriptor.name })
          } else {
            mcpServers = [...mcpServers, descriptor]
            skillsExposed = 'mcp-exposed'
          }
        } catch (error) {
          this.callbacks.onLog?.('warn', '技能 MCP 描述符构建失败，本次会话无技能 MCP', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const openResult = await restoreOrCreateAcpSession({
        request: async (method, params) => {
          return sdkRequest(agent, method, params)
        },
        cwd: this.workspaceRoot,
        resumeSessionId: options?.resumeSessionId ?? null,
        resumeSupported,
        loadSupported,
        mcpServers,
        sessionMeta: (!this.sessionConfig || this.runtimeInfo.id === 'agy') && this.resourcesDir && this.resourcePrep?.report.bridgeSupported
          ? this.adapter.appResourceSessionMeta?.(this.resourcesDir) : undefined,
        log: (level, msg, meta) => {
          this.callbacks.onLog?.(level, msg, meta)
        },
      })

      if (!openResult.mcpServersAccepted) skillsExposed = 'none'
      this.sessionLedger.set(openResult.sessionId, {
        restoreMethod: openResult.restoreMethod,
        gen: this.connectionGen,
        skillsExposed,
        nativeRules: openResult.nativeSessionAccepted,
      })
      const handle = new AcpSessionHandle(
        openResult.sessionId,
        this,
        openResult.restoreMethod,
        openResult.configOptions,
        this.resourcePrep?.report ? {
          ...this.resourcePrep.report,
          skillsFound: [...this.resourcePrep.report.skillsFound],
          skillsExposed,
          rulesApplied: openResult.nativeSessionAccepted || !this.adapter.appResourceSessionMeta && openResult.restoreMethod === 'new'
            && this.resourcePrep.report.bridgeSupported === true
            && this.resourcePrep.report.rulesPrepared === true,
          ...(openResult.restoreMethod !== 'new' && !openResult.nativeSessionAccepted ? { reason: 'session-restored-not-verified' } : {}),
        } : null,
      )

      return ok(handle)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err({ code: 'ACP_PROTOCOL_ERROR', message })
    }
  }

  /** 向指定会话发送消息 */
  async promptSession(
    sessionId: string,
    promptText: string,
    options?: { timeoutMs?: number; images?: Array<{ mimeType: string; data: string }> },
  ): Promise<Result<unknown, AppError>> {
    if (!this.sdkConnection?.agent) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }

    this.inflightPrompts.add(sessionId)
    try {
      const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }]
      for (const image of options?.images ?? []) {
        if (!image?.data || !image?.mimeType) continue
        prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data })
      }
      // SDK 自动兼容引导：必要会话首轮前置同源规则块（稳定标记），原文块原样保留；
      // 原生已交付、已发送过、未知会话一律不碰原文。
      const compat = this.buildCompatPrepend(sessionId)
      const blocks = compat ? [{ type: 'text', text: compat }, ...prompt] : prompt
      const response = await sdkRequest(
        this.sdkConnection.agent,
        methods.agent.session.prompt,
        {
          sessionId,
          prompt: blocks,
        },
        options?.timeoutMs,
      )
      return ok(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err({ code: 'ACP_PROTOCOL_ERROR', message })
    } finally {
      this.inflightPrompts.delete(sessionId)
    }
  }

  /**
   * 兼容引导前置文本（首轮一次制）：
   * - 无 resources / 未知会话 / 原生已交付 → null（原文不动）；
   * - 已按“会话+代次+摘要”发送过 → null（取消/失败重试不重复）；
   * - 否则单次原子读取（正文与摘要配对快照）构建并记账。
   * 恢复会话因送达状态未知，按新代次重新附带一次（有界、可诊断，不声称 exactly-once）。
   */
  private buildCompatPrepend(sessionId: string): string | null {
    if (!this.resourcesDir) return null
    if (this.sessionConfig?.nativeRules) return null
    const entry = this.sessionLedger.get(sessionId)
    if (!entry) return null
    const connReport = this.resourcePrep?.report
    // 原生已交付（同代次新会话 + 已准备 + 桥版本通过）不再附带：
    // 注意读连接级事实重算，不读会话快照（快照只用于报告）。
    const nativelyDelivered = entry.nativeRules || !this.adapter.appResourceSessionMeta && entry.restoreMethod === 'new'
      && entry.gen === this.connectionGen
      && connReport?.rulesPrepared === true
      && connReport?.bridgeSupported === true
    if (nativelyDelivered) return null
    const load = readAppResourcesDir(this.resourcesDir)
    const rulesText = readAppRulesText(this.resourcesDir)
    const digest = digestAppResources(load)
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
    this.compatSnapshots.set(key, { text, digest })
    this.compatSentKeys.add(key)
    return text
  }

  /** 动态更新会话配置项（如模型 ID） */
  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<unknown, AppError>> {
    if (!this.sdkConnection?.agent) {
      return err({ code: 'ACP_NOT_CONNECTED', message: '尚未连接到 Agent 服务端' })
    }

    try {
      const response = await sdkRequest(this.sdkConnection.agent, methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      })
      return ok(response)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return err({ code: 'ACP_PROTOCOL_ERROR', message })
    }
  }

  /** 断开连接并清理资源 */
  async disconnect(reason?: string): Promise<void> {
    this.setStatus('disconnected', reason)
    this.resourcePrep = null
    const capabilities = this.initResponse?.agentCapabilities?.sessionCapabilities as Record<string, unknown> | undefined
    if (capabilities?.close && this.sdkConnection?.agent) {
      const failed = await closeAcpSessions(this.sdkConnection.agent, this.sessionLedger.keys())
      if (failed.length) this.callbacks.onLog?.('warn','Session close failed before process teardown',{count:failed.length})
    }
    // 会话随进程消亡：兼容记账与快照一并清空，不向新连接串线
    this.sessionLedger.clear()
    this.compatSentKeys.clear()
    this.compatSnapshots.clear()
    try {
      this.streamHandle?.dispose()
      this.sdkConnection?.close()
    } catch {
      // 忽略关闭异常
    } finally {
      this.sdkConnection = null
      this.streamHandle = null
      this.sdkApp = null
      this.initResponse = null
    }

    if (this.processHandle && isSpawnedAcpProcessAlive(this.processHandle)) {
      try {
        this.processHandle.kill()
      } catch {
        // 忽略杀死进程异常
      }
      this.processHandle = null
    }
    const config=this.sessionConfig
    this.sessionConfig=null
    if(config) {
      try {await config.dispose()}
      catch {this.callbacks.onLog?.('warn','Session configuration cleanup failed; directory retained',{directory:config.directory})}
    }
  }

  private setStatus(status: AcpConnectionStatus, detail?: string): void {
    this.status = status
    this.callbacks.onStatusChange?.(status, detail)
  }
}
