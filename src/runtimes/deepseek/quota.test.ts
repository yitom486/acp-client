import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  readHarnessCredential,
  saveDeepseekProvider,
} from './deepseek-provider'
import { probeDeepseekQuota, resolveDeepseekApiBase, resolveDeepseekQuotaKey } from './quota'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function dshHomeWithRef(value: string): string {
  const dir = tempDir('acp-dsh-home-')
  writeFileSync(
    join(dir, '.credentials.yaml'),
    ['version: 1', 'records:', '  - kind: grant', 'refs:', `  DEEPSEEK_API_KEY: ${value}`, ''].join('\n'),
    'utf8',
  )
  return dir
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('DeepSeek 余额 Key / API 根解析', () => {
  it('显式 env 优先，其次表单落库，最后 harness 凭证库', () => {
    const dataDir = tempDir('acp-dsh-data-')
    saveDeepseekProvider({ apiKey: 'sk-form' }, dataDir)
    const dshHome = dshHomeWithRef('sk-harness')

    expect(resolveDeepseekQuotaKey({ env: { DEEPSEEK_API_KEY: 'sk-env', DSH_HOME: dshHome }, dataDir })).toBe('sk-env')
    expect(resolveDeepseekQuotaKey({ env: { DSH_HOME: dshHome }, dataDir })).toBe('sk-form')
    expect(resolveDeepseekQuotaKey({ env: { DSH_HOME: dshHome } })).toBe('sk-harness')
    expect(resolveDeepseekQuotaKey({ env: { DSH_HOME: tempDir('acp-dsh-empty-') } })).toBeNull()
  })

  it('harness refs 只认顶层 refs 块', () => {
    expect(readHarnessCredential('DEEPSEEK_API_KEY', { DSH_HOME: dshHomeWithRef('sk-1') })).toBe('sk-1')
    expect(readHarnessCredential('OTHER_KEY', { DSH_HOME: dshHomeWithRef('sk-1') })).toBeNull()
  })

  it('余额接口去掉 harness 的 /anthropic 兼容路径', () => {
    expect(resolveDeepseekApiBase({ env: {} })).toBe('https://api.deepseek.com')
    expect(
      resolveDeepseekApiBase({ env: { DEEPSEEK_BASE_URL: DEEPSEEK_OFFICIAL_BASE_URL } }),
    ).toBe('https://api.deepseek.com')
    expect(
      resolveDeepseekApiBase({ env: { DEEPSEEK_BASE_URL: 'https://gw.example.com/v1/' } }),
    ).toBe('https://gw.example.com/v1')
  })
})

describe('DeepSeek 余额探针', () => {
  it('正常余额映射为 credits + ok', async () => {
    const quota = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      fetchImpl: (async () =>
        jsonResponse({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
          ],
        })) as typeof fetch,
    })
    expect(quota?.status).toBe('ok')
    expect(quota?.credits).toEqual({ balance: 110, currency: 'CNY' })
    expect(quota?.message).toContain('110.00')
    expect(quota?.runtimeId).toBe('deepseek')
  })

  it('is_available=false 判为 exhausted', async () => {
    const quota = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      fetchImpl: (async () =>
        jsonResponse({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0' }] })) as typeof fetch,
    })
    expect(quota?.status).toBe('exhausted')
  })

  it('无 Key 时给出 unauthorized 而不是静默 null', async () => {
    const quota = await probeDeepseekQuota({ env: { DSH_HOME: tempDir('acp-dsh-none-') } })
    expect(quota?.status).toBe('unauthorized')
  })

  it('401 判为 unauthorized', async () => {
    const quota = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'sk-bad' },
      fetchImpl: (async () => jsonResponse({ error: 'bad key' }, 401)) as typeof fetch,
    })
    expect(quota?.status).toBe('unauthorized')
  })

  it('网络失败返回 null（不谎报额度）', async () => {
    const quota = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      fetchImpl: (async () => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch,
    })
    expect(quota).toBeNull()
  })
})
