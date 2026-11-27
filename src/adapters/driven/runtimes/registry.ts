import {
  DEFAULT_ACP_RUNTIME_ID,
  emptyAcpAuthPreflight,
  type AcpRuntimeInfo,
  type AppResourceCapability,
  type NativeEligibility,
} from '../../../domain/contracts'
import type {
  AcpRuntimePlugin,
  ProvisionedSessionConfigHome,
  ReadonlyRuntimeRegistryPort,
  RuntimeRegistryPort,
} from '../../../ports'
import { createSessionConfigHomeFromLayout } from '../resources/session-config'
import { agyRuntimePlugin } from './agy'
import { antigravityCliRuntimePlugin } from './antigravity-cli'
import { claudeRuntimePlugin } from './claude'
import { codexRuntimePlugin } from './codex'
import { copilotRuntimePlugin } from './copilot'
import { cursorRuntimePlugin } from './cursor'
import { deepseekRuntimePlugin } from './deepseek'
import { geminiRuntimePlugin } from './gemini'
import { opencodeRuntimePlugin } from './opencode'
import { opencodeV2RuntimePlugin } from './opencode-v2'

export const BUILTIN_RUNTIME_PLUGINS: readonly AcpRuntimePlugin[] = [
  codexRuntimePlugin,
  claudeRuntimePlugin,
  geminiRuntimePlugin,
  copilotRuntimePlugin,
  opencodeRuntimePlugin,
  opencodeV2RuntimePlugin,
  cursorRuntimePlugin,
  deepseekRuntimePlugin,
  antigravityCliRuntimePlugin,
  agyRuntimePlugin,
] as const

function createFallbackPlugin(runtimeId: string): AcpRuntimePlugin {
  return {
    id: runtimeId,
    manifest: {
      id: runtimeId,
      name: runtimeId,
      description: `Custom ACP runtime (${runtimeId})`,
      command: runtimeId,
      args: [],
      requiredEnvKeys: [],
    },
    auth: {
      probeAuth: emptyAcpAuthPreflight,
    },
  }
}

/**
 * Isolated runtime plugin registry.
 *
 * Hosts can create independent registries via `createRuntimeRegistry()` or
 * `createBuiltinRuntimeRegistry()`, register custom plugins without mutating
 * any global singleton, and pass the registry (or a single `AcpRuntimePlugin`)
 * directly into `new AcpClient({ runtime, runtimeRegistry })`.
 */
export class AcpRuntimeRegistry implements RuntimeRegistryPort {
  private readonly plugins = new Map<string, AcpRuntimePlugin>()
  private readonly aliasMap = new Map<string, string>()

  constructor(initialPlugins: Iterable<AcpRuntimePlugin> = []) {
    for (const plugin of initialPlugins) {
      this.register(plugin)
    }
  }

  register(plugin: AcpRuntimePlugin): RuntimeRegistryPort {
    const id = plugin.id.trim()
    if (!id) throw new Error('Runtime plugin id must be non-empty')
    this.plugins.set(id, plugin)
    for (const alias of plugin.aliases ?? []) {
      const normalized = alias.trim()
      if (normalized) this.aliasMap.set(normalized, id)
    }
    return this
  }

  private resolveId(runtimeId: string): string {
    const trimmed = (runtimeId ?? '').trim()
    return this.aliasMap.get(trimmed) ?? trimmed
  }

  get(runtimeId: string): AcpRuntimePlugin | undefined {
    return this.plugins.get(this.resolveId(runtimeId))
  }

  resolve(runtimeId: string): AcpRuntimePlugin {
    return this.get(runtimeId) ?? createFallbackPlugin((runtimeId ?? '').trim())
  }

  list(): AcpRuntimePlugin[] {
    return [...this.plugins.values()]
  }

  listManifests(): AcpRuntimeInfo[] {
    return this.list().map((plugin) => plugin.manifest)
  }

  findManifest(runtimeId: string): AcpRuntimeInfo | undefined {
    return this.get(runtimeId)?.manifest
  }

  getDefaultManifest(): AcpRuntimeInfo {
    const manifest = this.findManifest(DEFAULT_ACP_RUNTIME_ID) ?? this.listManifests()[0]
    if (!manifest) {
      throw new Error(`缺少默认 ACP 运行时: ${DEFAULT_ACP_RUNTIME_ID}`)
    }
    return manifest
  }

  resolveResourceEligibility(runtimeId: string): NativeEligibility {
    const plugin = this.get(runtimeId)
    const versions = plugin?.resources?.supportedBridgeVersions
    if (!versions || versions.length === 0) {
      return { eligible: false, reason: 'runtime-not-verified' }
    }
    return { eligible: true }
  }

  isSupportedBridgeVersion(runtimeId: string, version?: string): NativeEligibility {
    const plugin = this.get(runtimeId)
    const versions = plugin?.resources?.supportedBridgeVersions
    if (!versions || versions.length === 0) {
      return { eligible: false, reason: 'runtime-not-verified' }
    }
    const normalized = version?.trim().replace(/^v/, '')
    if (!normalized) {
      return { eligible: false, reason: 'unknown-bridge-version' }
    }
    if (!versions.includes(normalized)) {
      return { eligible: false, reason: 'unsupported-bridge-version' }
    }
    return { eligible: true }
  }

  clone(): RuntimeRegistryPort {
    return new AcpRuntimeRegistry(this.plugins.values())
  }
}

/** Create an empty isolated registry (bring your own plugins). */
export function createRuntimeRegistry(plugins: Iterable<AcpRuntimePlugin> = []): RuntimeRegistryPort {
  return new AcpRuntimeRegistry(plugins)
}

/** Create a fresh isolated registry pre-populated with all 10 built-in ACP runtime plugins. */
export function createBuiltinRuntimeRegistry(
  extraPlugins: Iterable<AcpRuntimePlugin> = [],
): RuntimeRegistryPort {
  const registry = new AcpRuntimeRegistry(BUILTIN_RUNTIME_PLUGINS)
  for (const plugin of extraPlugins) {
    registry.register(plugin)
  }
  return registry
}

const builtinRegistry = createBuiltinRuntimeRegistry()

/** Read-only access to the default runtime registrations. */
export const DEFAULT_RUNTIME_REGISTRY: ReadonlyRuntimeRegistryPort = Object.freeze({
  get: builtinRegistry.get.bind(builtinRegistry),
  resolve: builtinRegistry.resolve.bind(builtinRegistry),
  list: builtinRegistry.list.bind(builtinRegistry),
  listManifests: builtinRegistry.listManifests.bind(builtinRegistry),
  findManifest: builtinRegistry.findManifest.bind(builtinRegistry),
  getDefaultManifest: builtinRegistry.getDefaultManifest.bind(builtinRegistry),
  resolveResourceEligibility: builtinRegistry.resolveResourceEligibility.bind(builtinRegistry),
  isSupportedBridgeVersion: builtinRegistry.isSupportedBridgeVersion.bind(builtinRegistry),
  clone: builtinRegistry.clone.bind(builtinRegistry),
})

/** Built-in runtime manifests derived directly from the registered plugins (single source of truth). */
export const BUILTIN_ACP_RUNTIMES: readonly AcpRuntimeInfo[] =
  DEFAULT_RUNTIME_REGISTRY.listManifests()

/** Built-in resource capability matrix derived directly from the registered plugins. */
export const APP_RESOURCE_CAPABILITIES: Readonly<Record<string, AppResourceCapability>> =
  Object.fromEntries(
    DEFAULT_RUNTIME_REGISTRY.list()
      .filter((plugin) => Boolean(plugin.resources?.capability))
      .map((plugin) => [plugin.id, plugin.resources!.capability]),
  )

/** Built-in verified bridge versions derived directly from the registered plugins. */
export const NATIVE_ELIGIBLE_BRIDGE_VERSIONS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    DEFAULT_RUNTIME_REGISTRY.list()
      .filter((plugin) => (plugin.resources?.supportedBridgeVersions?.length ?? 0) > 0)
      .map((plugin) => [plugin.id, plugin.resources!.supportedBridgeVersions!]),
  )

export function getRuntimePlugin(
  runtimeId: string,
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): AcpRuntimePlugin {
  return registry.resolve(runtimeId)
}

export function listAcpRuntimes(
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): AcpRuntimeInfo[] {
  return registry.listManifests()
}

export function getAcpRuntime(
  id: string,
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): AcpRuntimeInfo | undefined {
  return registry.findManifest(id)
}

export function findBuiltinAcpRuntime(id: string): AcpRuntimeInfo | undefined {
  return DEFAULT_RUNTIME_REGISTRY.findManifest(id)
}

export function getDefaultAcpRuntime(
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): AcpRuntimeInfo {
  return registry.getDefaultManifest()
}

export function resolveRuntimeEligibility(
  runtimeId: string,
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): NativeEligibility {
  return registry.resolveResourceEligibility(runtimeId)
}

export function isSupportedBridgeVersion(
  runtimeId: string,
  version?: string,
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): NativeEligibility {
  return registry.isSupportedBridgeVersion(runtimeId, version)
}

export async function createSessionConfigHome(
  runtimeId: string,
  resourcesDir: string,
  registry: ReadonlyRuntimeRegistryPort = DEFAULT_RUNTIME_REGISTRY,
): Promise<ProvisionedSessionConfigHome> {
  const plugin = registry.get(runtimeId)
  const layout = plugin?.resources?.sessionConfigLayout
  if (!layout) {
    throw new Error(`Session configuration home is not verified for runtime: ${runtimeId}`)
  }
  return createSessionConfigHomeFromLayout({ resourcesDir, layout })
}
