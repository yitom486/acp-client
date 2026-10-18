import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpMcpSessionRecovery, AcpMcpRecoveryCancelledError, type AcpMcpRecoveryEvent } from './mcp-session-recovery'
import { McpConnectionHealth } from '../mcp/connection-health'

let manager: AcpMcpSessionRecovery
let health: McpConnectionHealth
let client: object
let request: ReturnType<typeof vi.fn>
let suppressed: boolean
let connected: boolean
let events: AcpMcpRecoveryEvent[]
const sessionId = 'existing-session'
const servers = [{ name: 'host-tools', command: '/host/mcp', args: ['stdio'], env: [{ name: 'PRIVATE_TOKEN', value: 'never-log-me' }] }]
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  health = new McpConnectionHealth()
  client = {}
  suppressed = false
  connected = true
  events = []
  request = vi.fn(async () => ({ sessionId }))
  manager = new AcpMcpSessionRecovery({
    request,
    getCapabilities: () => ({ resume: true, load: true }),
    isConnected: () => connected,
    onSuppressUpdates: (value) => { suppressed = value },
    onEvent: (event) => events.push(event),
    discoveryTimeoutMs: 100,
    requestTimeoutMs: 200,
  })
  manager.register({ sessionId, cwd: '/workspace', mcpServers: servers, sessionMeta: { toolsMode: 'ptc', custom: 'host-rules' }, monitor: health })
  health.discovered(client)
})
afterEach(() => { manager.reset(); vi.useRealTimers() })

describe('AcpMcpSessionRecovery', () => {
  it('leaves healthy, unknown and initially lazy sessions alone', async () => {
    await manager.ensureReady(sessionId)
    await manager.ensureReady('unknown')
    health.closed(client)
    manager.register({ sessionId: 'lazy', cwd: '/workspace', mcpServers: servers, monitor: health })
    await manager.ensureReady('lazy')
    expect(request).not.toHaveBeenCalled()
  })

  it('restores the same session with saved descriptors and waits for new tools/list', async () => {
    health.closed(client)
    const pending = manager.ensureReady(sessionId)
    await flush()
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('session/resume', { sessionId, cwd: '/workspace', mcpServers: servers, _meta: { toolsMode: 'ptc', custom: 'host-rules' } }, expect.any(AbortSignal))
    expect(suppressed).toBe(true)
    health.discovered({})
    await pending
    expect(suppressed).toBe(false)
    await manager.ensureReady(sessionId)
    expect(request).toHaveBeenCalledOnce()
    expect(events.map((event) => event.type)).toEqual(['started', 'discovered'])
    expect(JSON.stringify(events)).not.toContain('never-log-me')
  })

  it('falls back to load with MCP intact and never creates a replacement session', async () => {
    health.closed(client)
    request.mockImplementation(async (method: string) => {
      if (method === 'session/resume') throw new Error('resume unavailable')
      health.discovered({})
      return { sessionId }
    })
    await manager.ensureReady(sessionId)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['session/resume', 'session/load'])
    expect(request.mock.calls.every(([, params]) => params.mcpServers.length === 1)).toBe(true)
  })

  it('does not mistake RPC success for rediscovered tools', async () => {
    health.closed(client)
    const checked = expect(manager.ensureReady(sessionId)).rejects.toThrow('rediscover')
    await vi.advanceTimersByTimeAsync(201)
    await checked
    expect(request).toHaveBeenCalledTimes(2)
    expect(suppressed).toBe(false)
  })

  it('stops on a changed session id without trying another method', async () => {
    health.closed(client)
    request.mockResolvedValue({ sessionId: 'different-session' })
    await expect(manager.ensureReady(sessionId)).rejects.toThrow('different session')
    expect(request).toHaveBeenCalledOnce()
  })

  it('rejects a downgrade from requested PTC while keeping MCP on extension fallback', async () => {
    health.closed(client)
    request.mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      if (params._meta) throw new Error('unsupported meta')
      return { sessionId }
    })
    await expect(manager.ensureReady(sessionId)).rejects.toThrow('Code mode')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([method, params]) => method === 'session/resume' && params.mcpServers.length === 1)).toBe(true)
  })

  it('cancels discovery waiting', async () => {
    health.closed(client)
    const checked = expect(manager.ensureReady(sessionId)).rejects.toBeInstanceOf(AcpMcpRecoveryCancelledError)
    await flush()
    manager.cancel(sessionId)
    await checked
    expect(suppressed).toBe(false)
    expect(request).toHaveBeenCalledOnce()
  })

  it('cancels a hanging restore RPC without waiting for its response', async () => {
    health.closed(client)
    request.mockReturnValue(new Promise(() => undefined))
    const checked = expect(manager.ensureReady(sessionId)).rejects.toBeInstanceOf(AcpMcpRecoveryCancelledError)
    await flush()
    manager.cancel(sessionId)
    await checked
    expect(suppressed).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds hanging RPC attempts and exposes a reconnect error', async () => {
    health.closed(client)
    request.mockReturnValue(new Promise(() => undefined))
    const checked = expect(manager.ensureReady(sessionId)).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(401)
    await checked
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shares recovery for the same session and blocks other prompts during replay', async () => {
    health.closed(client)
    const first = manager.ensureReady(sessionId)
    expect(manager.ensureReady(sessionId)).toBe(first)
    await expect(manager.ensureReady('another-session')).rejects.toThrow('Another session')
    await flush()
    health.discovered({})
    await first
    expect(request).toHaveBeenCalledOnce()
  })

  it('invalidates old work on reset and ignores late responses', async () => {
    health.closed(client)
    let finish!: (value: unknown) => void
    request.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const checked = expect(manager.ensureReady(sessionId)).rejects.toBeInstanceOf(AcpMcpRecoveryCancelledError)
    await flush()
    manager.reset()
    suppressed = true // Represents the next connection owning replay suppression.
    finish({ sessionId })
    await checked
    expect(suppressed).toBe(true)
    expect(events.some((event) => event.type === 'discovered')).toBe(false)
  })

  it('snapshots descriptors instead of following caller mutations', async () => {
    const descriptor = [{ name: 'scope-specific', command: '/host/mcp', env: [] }]
    manager.register({ sessionId: 'secondary', cwd: '/other-workspace', mcpServers: descriptor, monitor: health })
    descriptor[0]!.name = 'mutated'
    health.closed(client)
    request.mockImplementation(async () => { health.discovered({}); return { sessionId: 'secondary' } })
    await manager.ensureReady('secondary')
    expect(request.mock.calls[0]).toEqual(['session/resume', { sessionId: 'secondary', cwd: '/other-workspace', mcpServers: [{ name: 'scope-specific', command: '/host/mcp', env: [] }] }, expect.any(AbortSignal)])
  })

  it('requires reconnect when restore capabilities are absent', async () => {
    const unsupported = new AcpMcpSessionRecovery({ request, getCapabilities: () => ({ resume: false, load: false }), isConnected: () => true })
    unsupported.register({ sessionId, cwd: '/workspace', mcpServers: servers, monitor: health })
    health.closed(client)
    await expect(unsupported.ensureReady(sessionId)).rejects.toThrow('cannot restore')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not share bindings between independent owners', async () => {
    const other = new AcpMcpSessionRecovery({ request, getCapabilities: () => ({ resume: true, load: true }), isConnected: () => true })
    health.closed(client)
    await other.ensureReady(sessionId)
    expect(request).not.toHaveBeenCalled()
  })
})
