import type {
  AcpAgentQuota,
  AcpAuthMethod,
  AcpAuthPreflight,
  AcpProxySettings,
  AcpRuntimeInfo,
  AppResourceCapability,
  AppResourcePrep,
  NativeEligibility,
  SessionConfigLayoutSpec,
} from '../domain/contracts'

export interface RuntimeEnvOverrides {
  env: Record<string, string | undefined>
  envRemove: string[]
}

export interface RuntimeResourcePrepInput {
  directory: string
  workspaceRoot: string
  command?: string
  /** Effective child process environment; avoid reading global process.env. */
  env?: Record<string, string | undefined>
}

export interface RuntimeAuthCapability {
  probeAuth?: () => AcpAuthPreflight
  orderAuthMethods?: (methods: AcpAuthMethod[]) => AcpAuthMethod[]
  canSkipInteractiveAuth?: (methodId: string, force?: boolean) => boolean
  /**
   * Keychain-backed credential fallback: when file preflight misses, attempt a
   * direct session open before entering interactive needs_auth.
   */
  tryDirectSessionFirst?: boolean
}

export interface RuntimeSpawnCapability {
  /** Pre-spawn CLI resolver: return null when CLI is missing to fail fast. */
  resolveCommand?: () => { command: string; args: string[] } | null
  /** Pre-spawn blocker message (e.g. missing required API key). */
  resolveBlocker?: () => string | null | undefined
  getSpawnEnv?: (proxySettings?: Partial<AcpProxySettings>) => RuntimeEnvOverrides
  beforeSpawn?: () => Promise<void>
  onColdStart?: () => Promise<void>
}

export interface RuntimeResourceCapability {
  capability: AppResourceCapability
  /** Verified exact bridge versions eligible for native resource delivery. */
  supportedBridgeVersions?: readonly string[]
  prepareOverlay?: (input: RuntimeResourcePrepInput) => Promise<AppResourcePrep>
  sessionMeta?: (directory: string) => Record<string, unknown> | undefined
  /** Declarative layout for `configurationScope: 'session'` isolated config homes. */
  sessionConfigLayout?: SessionConfigLayoutSpec
}

export interface RuntimeQuotaCapability {
  probeQuota: (options?: { sessionId?: string }) => Promise<AcpAgentQuota | null>
}

export interface RuntimeCustomProviderResult {
  provider: unknown | null
  customEnv: Record<string, string | undefined>
  isCustom: boolean
}

/**
 * Self-contained ACP runtime plugin (Driven Adapter port).
 *
 * Adding a new ACP agent requires creating a single plugin object implementing
 * this interface and registering it in a RuntimeRegistry (or passing it directly
 * to `new AcpClient({ runtime: myPlugin })`).
 */
export interface AcpRuntimePlugin {
  readonly id: string
  readonly manifest: AcpRuntimeInfo
  readonly aliases?: readonly string[]
  readonly auth?: RuntimeAuthCapability
  readonly spawn?: RuntimeSpawnCapability
  readonly resources?: RuntimeResourceCapability
  readonly quota?: RuntimeQuotaCapability
  readonly getCustomProvider?: () => Promise<RuntimeCustomProviderResult>
}

export function isAcpRuntimePlugin(value: unknown): value is AcpRuntimePlugin {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    Boolean(candidate.manifest) &&
    typeof candidate.manifest === 'object' &&
    typeof (candidate.manifest as Record<string, unknown>).command === 'string'
  )
}

/**
 * Isolated runtime registry port. Each registry instance holds its own plugin
 * map so hosts can compose custom runtimes without mutating global singletons.
 */
export interface RuntimeRegistryPort {
  register(plugin: AcpRuntimePlugin): RuntimeRegistryPort
  get(runtimeId: string): AcpRuntimePlugin | undefined
  resolve(runtimeId: string): AcpRuntimePlugin
  list(): AcpRuntimePlugin[]
  listManifests(): AcpRuntimeInfo[]
  findManifest(runtimeId: string): AcpRuntimeInfo | undefined
  getDefaultManifest(): AcpRuntimeInfo
  resolveResourceEligibility(runtimeId: string): NativeEligibility
  isSupportedBridgeVersion(runtimeId: string, version?: string): NativeEligibility
  clone(): RuntimeRegistryPort
}
