import { describe, expect, it, vi } from 'vitest'
import { emptyAcpAuthPreflight, ok } from '../domain/contracts'
import type {
  AcpRuntimePlugin,
  AgentRpcEndpoint,
  AgentTransportHandlers,
  ManagedAgentProcess,
  RuntimeRegistryPort,
} from '../ports'
import { AcpClientEngine, type AcpClientEnginePorts } from './acp-client-engine'

function createFakeRegistry(plugin: AcpRuntimePlugin): RuntimeRegistryPort {
  const map = new Map<string, AcpRuntimePlugin>([[plugin.id, plugin]])
  return {
    register(p) {
      map.set(p.id, p)
      return this
    },
    get: (id) => map.get(id),
    resolve: (id) => map.get(id) ?? plugin,
    list: () => [...map.values()],
    listManifests: () => [...map.values()].map((p) => p.manifest),
    findManifest: (id) => map.get(id)?.manifest,
    getDefaultManifest: () => plugin.manifest,
    resolveResourceEligibility: () => ({ eligible: false, reason: 'runtime-not-verified' }),
    isSupportedBridgeVersion: () => ({ eligible: false, reason: 'runtime-not-verified' }),
    clone: () => createFakeRegistry(plugin),
  }
}

describe('AcpClientEngine (pure in-memory hexagonal core test — zero OS processes, zero disk IO)', () => {
  it('runs connect -> authenticate -> createSession -> prompt -> cancel -> disconnect purely through fake ports', async () => {
    const customPlugin: AcpRuntimePlugin = {
      id: 'fake-agent',
      manifest: {
        id: 'fake-agent',
        name: 'Fake Agent',
        description: 'Pure in-memory test runtime',
        command: 'fake-agent',
        args: ['acp'],
        requiredEnvKeys: [],
      },
      auth: { probeAuth: emptyAcpAuthPreflight },
      quota: {
        probeQuota: async () => ({
          runtimeId: 'fake-agent',
          provider: 'Fake',
          status: 'ok',
          updatedAt: Date.now(),
        }),
      },
    }

    let capturedHandlers: AgentTransportHandlers | undefined
    let authenticated = false
    const rpcCalls: Array<{ method: string; params: unknown }> = []
    const killed = vi.fn()
    const closed = vi.fn()

    const fakeProcess: ManagedAgentProcess = {
      id: 'fake-proc-1',
      runtimeId: 'fake-agent',
      pid: 4242,
      isAlive: () => true,
      kill: killed,
    }

    const fakeEndpoint: AgentRpcEndpoint = {
      async request<T = unknown>(method: string, params?: unknown): Promise<T> {
        rpcCalls.push({ method, params })
        if (method === 'initialize') {
          return {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal', name: 'OAuth' }],
            agentInfo: { name: 'fake', version: '1.0.0' },
            agentCapabilities: { sessionCapabilities: { close: {} } },
          } as T
        }
        if (method === 'authenticate') {
          authenticated = true
          return {} as T
        }
        if (method === 'session/new') {
          if (!authenticated) throw new Error('Authentication required')
          return { sessionId: 'sess-1', configOptions: [] } as T
        }
        if (method === 'session/set_config_option') {
          return { configOptions: [] } as T
        }
        throw new Error(`Unexpected RPC: ${method}`)
      },
      async requestWithActivity<T = unknown>(method: string, params: unknown): Promise<T> {
        rpcCalls.push({ method, params })
        capturedHandlers?.onSessionUpdate({
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Code review' }],
          },
        })
        return { stopReason: 'end_turn' } as T
      },
      async notify(method: string, params?: unknown): Promise<void> {
        rpcCalls.push({ method, params })
      },
      async closeSessions(sessionIds: Iterable<string>): Promise<string[]> {
        rpcCalls.push({ method: 'session/close', params: [...sessionIds] })
        return []
      },
      createActivityController() {
        return { touch: () => undefined, pause: () => () => undefined }
      },
    }

    const fakePorts: AcpClientEnginePorts = {
      runtimeRegistry: createFakeRegistry(customPlugin),
      processLauncher: {
        launch: () => fakeProcess,
        tryReuse: () => ({ status: 'miss' }),
      },
      transport: {
        connect({ handlers }) {
          capturedHandlers = handlers
          return { endpoint: fakeEndpoint, close: closed }
        },
      },
      proxyStore: {
        read: async () => ({ enabled: false, host: '127.0.0.1', port: 7897 }),
        save: async (s) => ok(s),
        buildSpawnEnv: () => ({ env: {}, envRemove: [] }),
      },
      paths: { getDefaultDataDir: () => '/memory/acp-client' },
      resources: {
        isAbsolutePath: (p) => p.startsWith('/'),
        readResourcesDir: () => ({ directoryReadable: false, rules: null, skills: [], warnings: [] }),
        readRulesText: () => null,
        digestResources: () => null,
        createSessionConfigHome: async () => {
          throw new Error('unused')
        },
        buildSkillsMcpServer: () => null,
      },
      defaultClientVersion: '0.2.0-test',
      defaultMaxReadBytes: 1024 * 1024,
      generateScopeKey: () => 'fake-scope',
    }

    const engine = new AcpClientEngine(
      { runtime: customPlugin, workspaceRoot: '/memory/workspace' },
      fakePorts,
    )

    expect((await engine.connect()).ok).toBe(true)
    expect(engine.isConnected).toBe(true)

    // Unauthenticated session/new returns UNAUTHORIZED
    const unauth = await engine.createSession()
    expect(unauth).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })

    // Authenticate and open session
    expect(await engine.authenticate('oauth-personal')).toEqual({ ok: true, value: undefined })
    const opened = await engine.createSession()
    expect(opened).toMatchObject({ ok: true, value: { sessionId: 'sess-1', restoreMethod: 'new' } })

    // Prompt + passive available_commands observation
    const prompted = await engine.promptSession('sess-1', 'hello')
    expect(prompted).toEqual({ ok: true, value: { stopReason: 'end_turn' } })
    expect(engine.getAvailableCommands('sess-1')).toEqual([
      { name: 'review', description: 'Code review' },
    ])

    // Quota probe through plugin port
    const quota = await engine.getQuota('sess-1')
    expect(quota?.runtimeId).toBe('fake-agent')

    // Cancel + graceful disconnect closes owned sessions & kills process
    expect(await engine.cancelSession('sess-1')).toEqual({ ok: true, value: undefined })
    await engine.disconnect()
    expect(engine.isConnected).toBe(false)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(killed).toHaveBeenCalledTimes(1)
    expect(rpcCalls.some((c) => c.method === 'session/close')).toBe(true)
  })
})
