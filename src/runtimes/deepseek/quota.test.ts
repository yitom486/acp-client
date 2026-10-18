import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseDeepseekBalance,
  parseDshCredentialGrants,
  parsePlatformAccount,
  parsePlatformWallet,
  probeDeepseekQuota,
  resetDeepseekQuotaCache,
} from './quota'

const MISSING_CREDENTIALS = 'C:/__autumnflow_missing_credentials__.yaml'

const BALANCE = {
  is_available: true,
  balance_infos: [
    { currency: 'USD', total_balance: '3.50', granted_balance: '0.00', topped_up_balance: '3.50' },
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
}

const CREDENTIALS = `version: 1
records:
  aaa111:
    kind: grant
    payload:
      version: 1
      secret: not-a-token
  bbb222:
    kind: grant
    payload:
      version: 1
      token: "platform-grant-token"
      issuer: "https://platform.deepseek.com"
`

function envelope(bizData: unknown, bizCode = 0): Response {
  return new Response(JSON.stringify({ code: 0, data: { biz_code: bizCode, biz_data: bizData } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function withCredentialsFile<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cred-'))
  const file = join(dir, '.credentials.yaml')
  writeFileSync(file, CREDENTIALS, 'utf8')
  return run(file).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('parseDeepseekBalance (API key)', () => {
  it('映射余额并优先 CNY，不伪造速率窗口', () => {
    const quota = parseDeepseekBalance(BALANCE)!
    expect(quota.runtimeId).toBe('deepseek')
    expect(quota.provider).toBe('DeepSeek')
    expect(quota.status).toBe('ok')
    expect(quota.account?.type).toBe('apiKey')
    expect(quota.credits).toEqual({ balance: 110, currency: 'CNY' })
    expect(quota.primaryWindow).toBeUndefined()
    expect(quota.secondaryWindow).toBeUndefined()
  })

  it('只有 USD 时使用 USD', () => {
    const quota = parseDeepseekBalance({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '12.34' }],
    })!
    expect(quota.credits).toEqual({ balance: 12.34, currency: 'USD' })
  })

  it('is_available=false 视为额度耗尽', () => {
    const quota = parseDeepseekBalance({
      is_available: false,
      balance_infos: [{ currency: 'CNY', total_balance: '0.00' }],
    })!
    expect(quota.status).toBe('exhausted')
    expect(quota.message).toContain('is_available')
  })

  it('缺字段/非法金额返回 null，不猜 0', () => {
    expect(parseDeepseekBalance(null)).toBeNull()
    expect(parseDeepseekBalance({})).toBeNull()
    expect(parseDeepseekBalance({ balance_infos: [] })).toBeNull()
    expect(parseDeepseekBalance({ balance_infos: [{ currency: 'CNY' }] })).toBeNull()
    expect(parseDeepseekBalance({ balance_infos: [{ total_balance: { nope: 1 } }] })).toBeNull()
  })
})

describe('parseDshCredentialGrants', () => {
  it('只取带 token 的 grant，并保留 issuer', () => {
    expect(parseDshCredentialGrants(CREDENTIALS)).toEqual([
      { token: 'platform-grant-token', issuer: 'https://platform.deepseek.com' },
    ])
  })

  it('空文件 / 无 records 段 → 空数组', () => {
    expect(parseDshCredentialGrants('')).toEqual([])
    expect(parseDshCredentialGrants('version: 1\nrecords:\n')).toEqual([])
    expect(parseDshCredentialGrants('version: 1\nother:\n  a: b\n')).toEqual([])
  })
})

describe('platform wallet / profile parsing', () => {
  it('钱包优先 CNY，并保留币种', () => {
    expect(
      parsePlatformWallet({
        normal_wallets: [
          { currency: 'USD', balance: '1.00' },
          { currency: 'CNY', balance: '88.50' },
        ],
        bonus_wallets: [],
      }),
    ).toEqual({ balance: 88.5, currency: 'CNY' })
  })

  it('非法余额不猜 0', () => {
    expect(parsePlatformWallet({ normal_wallets: [{ currency: 'CNY', balance: 'abc' }] })).toBeUndefined()
    expect(parsePlatformWallet({})).toBeUndefined()
    expect(parsePlatformWallet(null)).toBeUndefined()
  })

  it('资料映射邮箱与昵称', () => {
    expect(
      parsePlatformAccount({ email: 'a@b.c', id_profile: { name: 'Yitom' } }),
    ).toEqual({ email: 'a@b.c', name: 'Yitom', plan: 'DeepSeek Account', type: 'account' })
    expect(parsePlatformAccount({})).toBeUndefined()
  })
})

describe('probeDeepseekQuota', () => {
  beforeEach(() => {
    resetDeepseekQuotaCache()
  })

  it('无 key 且无平台凭据时不发请求', async () => {
    let calls = 0
    const quota = await probeDeepseekQuota({
      env: {},
      credentialsFile: MISSING_CREDENTIALS,
      fetchImpl: (async () => {
        calls += 1
        return response(BALANCE)
      }) as unknown as typeof fetch,
    })
    expect(quota).toBeNull()
    expect(calls).toBe(0)
  })

  it('API Key：官方余额端点 + Bearer，30s 缓存', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      return response(BALANCE)
    }) as unknown as typeof fetch

    let now = 1_000
    const options = {
      env: { DEEPSEEK_API_KEY: 'sk-test' },
      credentialsFile: MISSING_CREDENTIALS,
      fetchImpl,
      now: () => now,
    }

    const first = await probeDeepseekQuota(options)
    expect(first!.credits).toEqual({ balance: 110, currency: 'CNY' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://api.deepseek.com/user/balance')
    expect(seen[0]!.auth).toBe('Bearer sk-test')

    now += 10_000
    expect(await probeDeepseekQuota(options)).toBe(first)
    expect(seen).toHaveLength(1)

    now += 30_000
    await probeDeepseekQuota(options)
    expect(seen).toHaveLength(2)
  })

  it('API Key 401：unauthorized 且不缓存', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return response({ error: 'invalid key' }, 401)
    }) as unknown as typeof fetch

    const first = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'bad' },
      credentialsFile: MISSING_CREDENTIALS,
      fetchImpl,
    })
    expect(first!.status).toBe('unauthorized')
    expect(first!.message).toContain('401')

    await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'bad' },
      credentialsFile: MISSING_CREDENTIALS,
      fetchImpl,
    })
    expect(calls).toBe(2)
  })

  it('平台账户：读 grant、带 x-dsh-auth-token、合并余额与邮箱', async () => {
    await withCredentialsFile(async (file) => {
      const calls: Array<{ url: string; token?: string }> = []
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        calls.push({ url, token: (init?.headers as Record<string, string> | undefined)?.['x-dsh-auth-token'] })
        if (url.endsWith('/api/v0/users/get_user_summary')) {
          return envelope({ normal_wallets: [{ currency: 'CNY', balance: '88.50' }] })
        }
        if (url.endsWith('/auth-api/v0/users/current')) {
          return envelope({ email: 'a@b.c', id_profile: { name: 'Yitom' } })
        }
        return response({}, 404)
      }) as unknown as typeof fetch

      const quota = await probeDeepseekQuota({
        env: {},
        credentialsFile: file,
        platformOrigin: 'https://platform.deepseek.com',
        fetchImpl,
      })

      expect(quota).not.toBeNull()
      expect(quota!.credits).toEqual({ balance: 88.5, currency: 'CNY' })
      expect(quota!.account).toEqual({
        email: 'a@b.c',
        name: 'Yitom',
        plan: 'DeepSeek Account',
        type: 'account',
      })
      expect(quota!.status).toBe('ok')
      expect(calls.map(call => call.url).sort()).toEqual([
        'https://platform.deepseek.com/api/v0/users/get_user_summary',
        'https://platform.deepseek.com/auth-api/v0/users/current',
      ])
      expect(calls.every(call => call.token === 'platform-grant-token')).toBe(true)
    })
  })

  it('平台 grant 过期时优先回落到 API Key', async () => {
    await withCredentialsFile(async (file) => {
      const fetchImpl = (async (url: string) => {
        if (url.startsWith('https://platform.deepseek.com')) return response({}, 401)
        return response(BALANCE)
      }) as unknown as typeof fetch

      const quota = await probeDeepseekQuota({
        env: { DEEPSEEK_API_KEY: 'sk-test' },
        credentialsFile: file,
        platformOrigin: 'https://platform.deepseek.com',
        fetchImpl,
      })

      expect(quota!.status).toBe('ok')
      expect(quota!.account?.type).toBe('apiKey')
    })
  })

  it('平台 grant 过期且无 key：返回 unauthorized，不编造额度', async () => {
    await withCredentialsFile(async (file) => {
      const fetchImpl = (async () => response({}, 401)) as unknown as typeof fetch
      const quota = await probeDeepseekQuota({
        env: {},
        credentialsFile: file,
        platformOrigin: 'https://platform.deepseek.com',
        fetchImpl,
      })
      expect(quota!.status).toBe('unauthorized')
      expect(quota!.credits).toBeUndefined()
    })
  })

  it('5xx / 网络异常返回 null，不抛也不产生假额度', async () => {
    const fiveHundred = (async () => response({}, 500)) as unknown as typeof fetch
    expect(
      await probeDeepseekQuota({
        env: { DEEPSEEK_API_KEY: 'sk-test' },
        credentialsFile: MISSING_CREDENTIALS,
        fetchImpl: fiveHundred,
      }),
    ).toBeNull()

    const offline = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(
      await probeDeepseekQuota({
        env: { DEEPSEEK_API_KEY: 'sk-test' },
        credentialsFile: MISSING_CREDENTIALS,
        fetchImpl: offline,
      }),
    ).toBeNull()
  })

  it('拒绝非 HTTPS 且非回环的 API base URL', async () => {
    let calls = 0
    const quota = await probeDeepseekQuota({
      env: { DEEPSEEK_API_KEY: 'sk-test', DEEPSEEK_BASE_URL: 'http://api.deepseek.com' },
      credentialsFile: MISSING_CREDENTIALS,
      fetchImpl: (async () => {
        calls += 1
        return response(BALANCE)
      }) as unknown as typeof fetch,
    })
    expect(quota).toBeNull()
    expect(calls).toBe(0)
  })
})
