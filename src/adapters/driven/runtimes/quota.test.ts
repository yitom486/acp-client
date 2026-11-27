import { describe, expect, it } from 'vitest'
import { AcpClient } from '../../driving/sdk/acp-client'
import {
  agyRuntimePlugin,
  antigravityCliRuntimePlugin,
  claudeRuntimePlugin,
  codexRuntimePlugin,
  cursorRuntimePlugin,
  opencodeRuntimePlugin,
} from './index'

describe('runtimes quota probes', () => {
  it('codexRuntimePlugin provides probeQuota and returns structured quota', async () => {
    expect(typeof codexRuntimePlugin.quota?.probeQuota).toBe('function')
    const quota = await codexRuntimePlugin.quota!.probeQuota()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('codex-acp')
    expect(quota?.provider).toContain('Codex')
    if (quota?.status === 'ok') {
      expect(quota.account).toBeDefined()
      if (quota.account?.email) {
        expect(typeof quota.account.email).toBe('string')
      }
    }
  }, 15000)

  it('claudeRuntimePlugin provides probeQuota and gracefully handles unauthorized/banned', async () => {
    expect(typeof claudeRuntimePlugin.quota?.probeQuota).toBe('function')
    const quota = await claudeRuntimePlugin.quota!.probeQuota()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('claude')
    expect(quota?.provider).toContain('Claude')
    expect(['ok', 'unauthorized', 'banned']).toContain(quota?.status)
  }, 15000)

  it('opencodeRuntimePlugin provides official CLI probeQuota', async () => {
    expect(typeof opencodeRuntimePlugin.quota?.probeQuota).toBe('function')
    const quota = await opencodeRuntimePlugin.quota!.probeQuota()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('opencode')
    expect(['ok', 'unauthorized']).toContain(quota?.status)
  }, 15000)

  it('cursorRuntimePlugin keeps probeQuota interface and returns null until official quota exists', async () => {
    expect(typeof cursorRuntimePlugin.quota?.probeQuota).toBe('function')
    expect(await cursorRuntimePlugin.quota!.probeQuota()).toBeNull()
  })

  it('agyRuntimePlugin keeps probeQuota interface and returns null until official ACP quota exists', async () => {
    expect(typeof agyRuntimePlugin.quota?.probeQuota).toBe('function')
    expect(await agyRuntimePlugin.quota!.probeQuota()).toBeNull()
  })

  it('antigravityCliRuntimePlugin keeps probeQuota interface and returns null until official ACP quota exists', async () => {
    expect(typeof antigravityCliRuntimePlugin.quota?.probeQuota).toBe('function')
    expect(await antigravityCliRuntimePlugin.quota!.probeQuota()).toBeNull()
  })

  it('AcpClient integrates quota methods', async () => {
    const client = new AcpClient({ workspaceRoot: process.cwd() })
    expect(typeof client.getQuota).toBe('function')
    expect(typeof client.getCachedQuota).toBe('function')
    const quota = await client.getQuota()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('codex-acp')
    expect(client.getCachedQuota()).toBe(quota)
  }, 15000)
})
