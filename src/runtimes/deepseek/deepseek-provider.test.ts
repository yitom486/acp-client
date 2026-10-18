import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  buildDeepseekProviderEnv,
  clearDeepseekProvider,
  getDeepseekProviderStatus,
  normalizeDeepseekBaseUrl,
  readStoredDeepseekProvider,
  saveDeepseekProvider,
} from './deepseek-provider'

function emptyDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'acp-dsh-datadir-'))
}

describe('DeepSeek URL 归一化', () => {
  it('空值回落官方 Anthropic 兼容端点', () => {
    expect(normalizeDeepseekBaseUrl()).toBe(DEEPSEEK_OFFICIAL_BASE_URL)
    expect(normalizeDeepseekBaseUrl('   ')).toBe(DEEPSEEK_OFFICIAL_BASE_URL)
  })

  it('官方域名不带路径时补 /anthropic（harness 走 Anthropic Messages API）', () => {
    expect(normalizeDeepseekBaseUrl('https://api.deepseek.com')).toBe(DEEPSEEK_OFFICIAL_BASE_URL)
    expect(normalizeDeepseekBaseUrl('https://api.deepseek.com/')).toBe(DEEPSEEK_OFFICIAL_BASE_URL)
  })

  it('自定义端点原样保留，仅去尾部斜杠', () => {
    expect(normalizeDeepseekBaseUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1')
  })
})

describe('DeepSeek 表单落库', () => {
  it('保存后状态脱敏（不回传 Key）并标记官方端点', () => {
    const dir = emptyDataDir()
    const saved = saveDeepseekProvider({ apiKey: 'sk-test' }, dir)
    expect(saved.ok).toBe(true)
    const status = getDeepseekProviderStatus(dir)
    expect(status).toEqual({
      configured: true,
      baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
      isOfficial: true,
      hasApiKey: true,
    })
    expect(JSON.stringify(status)).not.toContain('sk-test')
  })

  it('只改端点不重填 Token 时保留原 Key', () => {
    const dir = emptyDataDir()
    saveDeepseekProvider({ apiKey: 'sk-test' }, dir)
    const updated = saveDeepseekProvider({ baseUrl: 'https://gw.example.com/v1' }, dir)
    expect(updated.ok).toBe(true)
    expect(readStoredDeepseekProvider(dir)?.apiKey).toBe('sk-test')
    expect(getDeepseekProviderStatus(dir).isOfficial).toBe(false)
  })

  it('首次保存必须带 Token', () => {
    const result = saveDeepseekProvider({ baseUrl: 'https://gw.example.com' }, emptyDataDir())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT')
  })

  it('拒绝非 http(s) 端点', () => {
    const result = saveDeepseekProvider({ baseUrl: 'ftp://x', apiKey: 'k' }, emptyDataDir())
    expect(result.ok).toBe(false)
  })

  it('清除后回到未配置', () => {
    const dir = emptyDataDir()
    saveDeepseekProvider({ apiKey: 'sk-test' }, dir)
    clearDeepseekProvider(dir)
    expect(getDeepseekProviderStatus(dir)).toEqual({
      configured: false,
      isOfficial: true,
      hasApiKey: false,
    })
  })
})

describe('落库 → spawn 环境变量', () => {
  it('转成 DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY', () => {
    const dir = emptyDataDir()
    saveDeepseekProvider({ apiKey: 'sk-test' }, dir)
    expect(buildDeepseekProviderEnv(readStoredDeepseekProvider(dir), {})).toEqual({
      DEEPSEEK_BASE_URL: DEEPSEEK_OFFICIAL_BASE_URL,
      DEEPSEEK_API_KEY: 'sk-test',
    })
  })

  it('调用方显式 env 优先，落库只补空缺', () => {
    const dir = emptyDataDir()
    saveDeepseekProvider({ apiKey: 'sk-stored' }, dir)
    expect(
      buildDeepseekProviderEnv(readStoredDeepseekProvider(dir), { DEEPSEEK_API_KEY: 'sk-explicit' }),
    ).toEqual({ DEEPSEEK_BASE_URL: DEEPSEEK_OFFICIAL_BASE_URL })
  })

  it('未配置时返回空对象', () => {
    expect(buildDeepseekProviderEnv(null, {})).toEqual({})
  })
})
