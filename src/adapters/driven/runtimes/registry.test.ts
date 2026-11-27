import { describe, expect, it } from 'vitest'
import { DEFAULT_ACP_RUNTIME_ID, emptyAcpAuthPreflight } from '../../../domain/contracts'
import { isAcpRuntimePlugin, type AcpRuntimePlugin } from '../../../ports'
import {
  BUILTIN_ACP_RUNTIMES,
  BUILTIN_RUNTIME_PLUGINS,
  DEFAULT_RUNTIME_REGISTRY,
  createBuiltinRuntimeRegistry,
  createRuntimeRegistry,
  getRuntimePlugin,
  isSupportedBridgeVersion,
  resolveRuntimeEligibility,
} from './registry'
import { resolveCursorCommand } from './cursor'

describe('RuntimeRegistry & AcpRuntimePlugin architecture', () => {
  it('supports isolated custom registries without mutating the built-in default registry', () => {
    const ollamaPlugin: AcpRuntimePlugin = {
      id: 'ollama-acp',
      aliases: ['ollama'],
      manifest: {
        id: 'ollama-acp',
        name: 'Ollama',
        description: 'Local Ollama ACP server',
        command: 'ollama-acp',
        args: ['--stdio'],
        requiredEnvKeys: [],
        authHint: 'Local model, no sign-in required',
      },
      auth: {
        probeAuth: () => ({ ...emptyAcpAuthPreflight(), looksLoggedIn: true }),
      },
      resources: {
        capability: { entry: null, strategy: 'compatibility', configHome: null },
        supportedBridgeVersions: ['1.0.0'],
      },
    }

    expect(isAcpRuntimePlugin(ollamaPlugin)).toBe(true)

    const customOnly = createRuntimeRegistry([ollamaPlugin])
    expect(customOnly.list().map((p) => p.id)).toEqual(['ollama-acp'])
    expect(customOnly.get('ollama')?.id).toBe('ollama-acp')
    expect(customOnly.isSupportedBridgeVersion('ollama-acp', '1.0.0')).toEqual({ eligible: true })
    expect(customOnly.isSupportedBridgeVersion('ollama-acp', '2.0.0')).toEqual({
      eligible: false,
      reason: 'unsupported-bridge-version',
    })

    // Built-in default registry stays completely unaffected
    expect(DEFAULT_RUNTIME_REGISTRY.get('ollama-acp')).toBeUndefined()

    // Isolated clone with built-ins + custom plugin
    const extended = createBuiltinRuntimeRegistry([ollamaPlugin])
    expect(extended.get('ollama-acp')?.id).toBe('ollama-acp')
    expect(extended.get('codex-acp')?.id).toBe('codex-acp')
    expect(DEFAULT_RUNTIME_REGISTRY.get('ollama-acp')).toBeUndefined()
  })

  it('derives all built-in manifests with complete spawn metadata and consistent ids', () => {
    expect(BUILTIN_ACP_RUNTIMES.length).toBe(BUILTIN_RUNTIME_PLUGINS.length)
    expect(BUILTIN_ACP_RUNTIMES.length).toBe(10)

    for (const runtime of BUILTIN_ACP_RUNTIMES) {
      expect(runtime.id.trim().length).toBeGreaterThan(0)
      expect(runtime.command.trim().length).toBeGreaterThan(0)
      expect(Array.isArray(runtime.args)).toBe(true)
      expect(typeof runtime.description).toBe('string')
      expect(typeof runtime.authHint).toBe('string')
      expect(Array.isArray(runtime.requiredEnvKeys)).toBe(true)

      const plugin = getRuntimePlugin(runtime.id)
      expect(plugin.id).toBe(runtime.id)
      expect(plugin.manifest).toBe(runtime)
      expect(typeof plugin.auth?.probeAuth).toBe('function')
      expect(typeof plugin.auth!.probeAuth!().looksLoggedIn).toBe('boolean')
    }
  })

  it('resolves aliases (cursor -> cursor-cli) and falls back cleanly for unknown ids', () => {
    expect(getRuntimePlugin('cursor').id).toBe('cursor-cli')
    expect(getRuntimePlugin(DEFAULT_ACP_RUNTIME_ID).id).toBe('codex-acp')

    const unknown = getRuntimePlugin('antigravity-acp')
    expect(unknown.id).toBe('antigravity-acp')
    expect(unknown.auth?.probeAuth?.().looksLoggedIn).toBe(false)
  })

  it('derives bridge version eligibility directly from plugin declarations', () => {
    expect(resolveRuntimeEligibility('codex-acp')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('claude')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('opencode')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('agy')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('antigravity-cli')).toEqual({
      eligible: false,
      reason: 'runtime-not-verified',
    })
    expect(isSupportedBridgeVersion('codex-acp', 'v2.2.2')).toEqual({ eligible: true })
    expect(isSupportedBridgeVersion('agy', '0.1.26')).toEqual({ eligible: true })
    expect(isSupportedBridgeVersion('agy', '0.1.99')).toEqual({
      eligible: false,
      reason: 'unsupported-bridge-version',
    })
  })

  it('preserves opencode v1 vs v2 separation and native antigravity-cli vs legacy agy bridge', () => {
    const v1 = DEFAULT_RUNTIME_REGISTRY.findManifest('opencode')!
    const v2 = DEFAULT_RUNTIME_REGISTRY.findManifest('opencode-v2')!
    expect(v1.command).not.toBe(v2.command)
    expect(v2.command.toLowerCase()).not.toContain('bunx')

    const native = DEFAULT_RUNTIME_REGISTRY.findManifest('antigravity-cli')!
    const bridge = DEFAULT_RUNTIME_REGISTRY.findManifest('agy')!
    expect(native).toMatchObject({ command: process.platform === 'win32' ? 'agy.exe' : 'agy', args: ['acp'] })
    expect(bridge).toMatchObject({ command: 'bunx', args: ['-y', '@yitom/agy-acp-map@latest'] })
    expect(getRuntimePlugin('antigravity-cli').resources?.sessionMeta).toBeUndefined()
    expect(resolveCursorCommand().args).toEqual(['acp'])
  })
})
