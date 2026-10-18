import { describe, it, expect } from 'bun:test'
import { RequestError } from '@agentclientprotocol/sdk'
import { restoreOrCreateAcpSession, requestSessionWithResources } from './session-open'

describe('host session policy migrated to SDK', () => {
  it('preserves requested MCP tools on an explicit reader retry', async () => {
    const calls: unknown[] = []
    const tools = [{ name: 'reader', command: 'reader-server', args: [], env: [] }]
    const result = await restoreOrCreateAcpSession({
      cwd: '/books', resumeSessionId: null, resumeSupported: false, loadSupported: false,
      mcpServers: tools, preserveMcpOnRetry: true, log: () => {},
      request: async (_method, params) => { calls.push(params); if (calls.length === 1) throw Error('transient MCP failure'); return { sessionId: 'reader' } },
    })
    expect(calls).toEqual([{ cwd: '/books', mcpServers: tools }, { cwd: '/books', mcpServers: tools }])
    expect(result.mcpServersAccepted).toBe(true)
  })

  it('rejecting optional metadata retries without dropping tools', async () => {
    const calls: unknown[] = []
    const params = { cwd: '/books', mcpServers: [{ name: 'reader', command: 'reader-server', args: [], env: [] }] }
    const result = await requestSessionWithResources(async (_method, value) => {
      calls.push(value)
      if (calls.length === 1) throw RequestError.invalidParams()
      return { sessionId: 'reader' }
    }, 'session/new', params, { appResources: { directory: '/rules' } })
    expect(result.nativeSessionAccepted).toBe(false)
    expect(calls[1]).toEqual(params)
  })

  it('limits recovered output rows and bytes at the extension boundary', async () => {
    const result = await restoreOrCreateAcpSession({
      cwd: '/books', resumeSessionId: 'old', resumeSupported: true, loadSupported: false, log: () => {},
      request: async () => ({ sessionId: 'old', _meta: { toolOutputRecovery: { outputs: [
        { toolCallId: 'invalid', text: 'x'.repeat(128 * 1024 + 1) },
        { toolCallId: 'bad-type', text: 1 },
        ...Array.from({ length: 25 }, (_, i) => ({ toolCallId: 'tool-' + i, text: '原文' })),
      ] } } }),
    })
    expect(result.recoveredToolOutputs).toHaveLength(18)
    expect(result.recoveredToolOutputs?.every(row => row.toolCallId.startsWith('tool-'))).toBe(true)
  })
})
