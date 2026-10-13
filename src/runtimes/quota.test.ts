import { describe, expect, it } from 'vitest'
import {
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  cursorAdapter,
  agyAdapter,
} from './index'
import { AcpClient } from '../client/acp-client'

describe('runtimes quota probes', () => {
  it('codexAdapter provides probeQuota and returns structured quota', async () => {
    expect(typeof codexAdapter.probeQuota).toBe('function')
    const quota = await codexAdapter.probeQuota!()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('codex-acp')
    expect(quota?.provider).toContain('Codex')
    if (quota?.status === 'ok') {
      expect(quota.account?.plan).toBe('ChatGPT plus')
      expect(quota.account?.email).toBe('yitom486@gmail.com')
    }
  })

  it('claudeAdapter provides probeQuota and gracefully handles unauthorized/banned', async () => {
    expect(typeof claudeAdapter.probeQuota).toBe('function')
    const quota = await claudeAdapter.probeQuota!()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('claude')
    expect(quota?.provider).toContain('Claude')
    expect(['ok', 'unauthorized', 'banned']).toContain(quota?.status)
  })

  it('opencodeAdapter provides probeQuota', async () => {
    expect(typeof opencodeAdapter.probeQuota).toBe('function')
    const quota = await opencodeAdapter.probeQuota!()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('opencode')
    expect(['ok', 'unauthorized']).toContain(quota?.status)
  })

  it('cursorAdapter provides probeQuota', async () => {
    expect(typeof cursorAdapter.probeQuota).toBe('function')
    const quota = await cursorAdapter.probeQuota!()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('cursor-cli')
    expect(['ok', 'unauthorized']).toContain(quota?.status)
  })

  it('agyAdapter provides probeQuota', async () => {
    expect(typeof agyAdapter.probeQuota).toBe('function')
    const quota = await agyAdapter.probeQuota!()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('agy')
    expect(quota?.provider).toContain('Antigravity')
    expect(['ok', 'unauthorized']).toContain(quota?.status)
    if (quota?.status === 'ok') {
      expect(quota.primaryWindow).defined
      expect(quota.credits?.unlimited).toBe(true)
    }
  })

  it('AcpClient integrates quota methods', async () => {
    const client = new AcpClient({ workspaceRoot: process.cwd() })
    expect(typeof client.getQuota).toBe('function')
    expect(typeof client.getCachedQuota).toBe('function')
    const quota = await client.getQuota()
    expect(quota).not.toBeNull()
    expect(quota?.runtimeId).toBe('codex-acp')
    const cached = client.getCachedQuota()
    expect(cached).toBe(quota)
  })
})
