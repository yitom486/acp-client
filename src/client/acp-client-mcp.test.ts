import { afterEach, describe, expect, it } from 'vitest'
import { agent, client, methods, type InitializeResponse, type ClientConnection } from '@agentclientprotocol/sdk'
import { AcpClient } from './acp-client'
import { McpConnectionHealth } from '../mcp/connection-health'

const live: AcpClient[] = []
afterEach(async () => { await Promise.all(live.splice(0).map((owner) => owner.disconnect())) })

/** Real ACP in-memory peer; no model, network, credentials or process startup. */
function setup() {
  const owner = new AcpClient({ workspaceRoot: process.cwd() })
  const calls: string[] = []
  const peer = agent({ name: 'mcp-recovery-peer' })
  const app = client({ name: 'sdk-mcp-test' })
  const health = new McpConnectionHealth()
  const transport = {}
  peer.onRequest(methods.agent.session.new, async () => { calls.push('new'); return { sessionId: 'kept-session' } })
  let resume: () => Promise<object> = async () => { calls.push('resume'); health.discovered({}); return {} }
  peer.onRequest(methods.agent.session.resume, () => resume())
  peer.onRequest(methods.agent.session.prompt, async (ctx) => {
    calls.push('prompt')
    expect(ctx.params.sessionId).toBe('kept-session')
    expect(ctx.params.prompt).toEqual([{ type: 'text', text: 'one user message' }])
    return { stopReason: 'end_turn' as const }
  })
  const connection = app.connect(peer)
  Object.assign(owner as unknown as { sdkConnection: ClientConnection; status: string; initResponse: InitializeResponse }, {
    sdkConnection: connection,
    status: 'connected',
    initResponse: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
  })
  live.push(owner)
  return { owner, health, transport, calls, setResume: (callback: typeof resume) => { resume = callback } }
}

describe('AcpClient automatic MCP recovery', () => {
  it('recovers before prompt through the public session handle', async () => {
    const { owner, health, transport, calls } = setup()
    const opened = await owner.createSession({ mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }], mcpHealth: health })
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
    const { owner, setResume, health, transport, calls } = setup()
    setResume(async () => { calls.push('resume'); throw new Error('restore unavailable') })
    const opened = await owner.createSession({ mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }], mcpHealth: health })
    if (!opened.ok) throw new Error(opened.error.message)
    health.discovered(transport)
    health.closed(transport)
    const result = await opened.value.prompt('one user message')
    expect(!result.ok && result.error.message).toContain('reconnect')
    expect(calls).toEqual(['new', 'resume'])
  })

  it('cancels a pending recovery through the public session handle', async () => {
    const { owner, setResume, health, transport, calls } = setup()
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    setResume(async () => { calls.push('resume'); entered(); return {} })
    const opened = await owner.createSession({ mcpServers: [{ name: 'host', command: 'server', args: [], env: [] }], mcpHealth: health })
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
