import { afterEach, describe, expect, it } from 'vitest'
import { agent, client, methods } from '@agentclientprotocol/sdk'
import { McpConnectionHealth } from '../../../domain/transport/connection-health'
import {
  createSdkRequestActivityController,
  sdkRequest,
  sdkRequestWithActivity,
} from '../../driven/transport/sdk-client'
import { AcpClient } from './acp-client'

const live: AcpClient[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map((owner) => owner.disconnect()))
})

/** Real ACP in-memory peer wired cleanly through Hexagonal ports; no OS process startup. */
async function setup() {
  const calls: string[] = []
  const peer = agent({ name: 'mcp-recovery-peer' })
  const app = client({ name: 'sdk-mcp-test' })
  const health = new McpConnectionHealth()
  const transport = {}
  peer.onRequest(methods.agent.initialize, async () => ({
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
  }))
  peer.onRequest(methods.agent.session.new, async () => {
    calls.push('new')
    return { sessionId: 'kept-session' }
  })
  let resume: () => Promise<object> = async () => {
    calls.push('resume')
    health.discovered({})
    return {}
  }
  peer.onRequest(methods.agent.session.resume, () => resume())
  peer.onRequest(methods.agent.session.prompt, async (ctx) => {
    calls.push('prompt')
    expect(ctx.params.sessionId).toBe('kept-session')
    expect(ctx.params.prompt).toEqual([{ type: 'text', text: 'one user message' }])
    return { stopReason: 'end_turn' as const }
  })

  const owner = new AcpClient({
    workspaceRoot: process.cwd(),
    ports: {
      processLauncher: {
        launch: () => ({
          id: 'in-memory-peer',
          runtimeId: 'codex-acp',
          isAlive: () => true,
          kill: () => undefined,
        }),
        tryReuse: () => ({ status: 'miss' }),
      },
      transport: {
        connect: () => {
          const connection = app.connect(peer)
          return {
            endpoint: {
              request: <T = unknown>(
                method: string,
                params?: unknown,
                options?: { timeoutMs?: number; cancellationSignal?: AbortSignal },
              ) =>
                options?.cancellationSignal
                  ? connection.agent.request<T, unknown>(method, params, {
                      cancellationSignal: options.cancellationSignal,
                    })
                  : sdkRequest<T, unknown>(connection.agent, method, params, options?.timeoutMs),
              requestWithActivity: <T = unknown>(method: string, params: unknown, options?: any) =>
                sdkRequestWithActivity<T, unknown>(connection.agent, method, params, options),
              notify: (method: string, params?: unknown) => connection.agent.notify(method, params),
              closeSessions: async () => [],
              createActivityController: createSdkRequestActivityController,
            },
            rawAgent: connection.agent,
            close: () => connection.close(),
          }
        },
      },
    },
  })

  const connected = await owner.connect()
  if (!connected.ok) throw new Error(connected.error.message)
  live.push(owner)
  return {
    owner,
    health,
    transport,
    calls,
    setResume: (callback: typeof resume) => {
      resume = callback
    },
  }
}

describe('AcpClient automatic MCP recovery', () => {
  it('recovers before prompt through the public session handle', async () => {
    const { owner, health, transport, calls } = await setup()
    const opened = await owner.createSession({
      mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }],
      mcpHealth: health,
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error(opened.error.message)
    health.discovered(transport)
    health.closed(transport)
    const response = await opened.value.prompt('one user message')
    expect(response.ok).toBe(true)
    expect(calls).toEqual(['new', 'resume', 'prompt'])
    await opened.value.prompt('one user message')
    expect(calls).toEqual(['new', 'resume', 'prompt', 'prompt'])
  })

  it('blocks user input if restore fails and never creates another session', async () => {
    const { owner, setResume, health, transport, calls } = await setup()
    setResume(async () => {
      calls.push('resume')
      throw new Error('restore unavailable')
    })
    const opened = await owner.createSession({
      mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }],
      mcpHealth: health,
    })
    if (!opened.ok) throw new Error(opened.error.message)
    health.discovered(transport)
    health.closed(transport)
    const result = await opened.value.prompt('one user message')
    expect(!result.ok && result.error.message).toContain('reconnect')
    expect(calls).toEqual(['new', 'resume'])
  })

  it('cancels a pending recovery through the public session handle', async () => {
    const { owner, setResume, health, transport, calls } = await setup()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    setResume(async () => {
      calls.push('resume')
      entered()
      return {}
    })
    const opened = await owner.createSession({
      mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }],
      mcpHealth: health,
    })
    if (!opened.ok) throw new Error(opened.error.message)
    health.discovered(transport)
    health.closed(transport)
    const pending = opened.value.prompt('one user message')
    await started
    await opened.value.cancel()
    const result = await pending
    expect(!result.ok && result.error.code).toBe('CANCELLED')
    expect(calls).toEqual(['new', 'resume'])
  })
})
