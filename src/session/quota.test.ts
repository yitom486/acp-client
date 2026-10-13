import { describe, expect, it } from 'vitest'
import { parseRateLimitsFromStatusText, QuotaCache } from './quota'

describe('quota-parser', () => {
  it('parses real Codex /status screenshot text correctly', () => {
    const text = `Model: gpt-6.1-sol[high]
Directory: D:\\project\\js\\Electron\\inkdown
Approval: on-request
Sandbox: workspace-write
Account: ChatGPT plus (yitom486@gmail.com)
Session: 01a1297c-673d-7693-8273-6ab523d87af4

Token usage: 44.0M total (2.3M input + 41.5M cached input, 224.1K output)
Context window: 10% used (48.9K used / 475.0K)
codex 5h limit: 99% left (resets 18:05)
codex Weekly limit: 100% left (resets 13:05 on 10月20日)
codex Credits: 126.1931995000`

    const result = parseRateLimitsFromStatusText(text, 'codex-acp')
    expect(result).not.toBeNull()
    expect(result?.runtimeId).toBe('codex-acp')
    expect(result?.account?.plan).toBe('ChatGPT plus')
    expect(result?.account?.email).toBe('yitom486@gmail.com')

    expect(result?.primaryWindow?.label).toBe('5h limit')
    expect(result?.primaryWindow?.percentLeft).toBe(99)
    expect(result?.primaryWindow?.usedPercent).toBe(1)
    expect(result?.primaryWindow?.resetsAt).toBe('18:05')
    expect(result?.primaryWindow?.windowDurationMins).toBe(300)

    expect(result?.secondaryWindow?.label).toBe('Weekly limit')
    expect(result?.secondaryWindow?.percentLeft).toBe(100)
    expect(result?.secondaryWindow?.resetsAt).toBe('13:05 on 10月20日')
    expect(result?.secondaryWindow?.windowDurationMins).toBe(10080)

    expect(result?.credits?.balance).toBe(126.1931995)
    expect(result?.credits?.unlimited).toBe(false)
    expect(result?.status).toBe('ok')
  })

  it('parses Claude 5-hour and weekly limits correctly', () => {
    const text = `Claude Code v0.87.0
Model: claude-3-7-sonnet-20250219
5-hour limit: 75% remaining (resets at 17:00)
Weekly limit: 92% remaining (resets Monday)
Total cost: $1.20 USD`

    const result = parseRateLimitsFromStatusText(text, 'claude')
    expect(result).not.toBeNull()
    expect(result?.primaryWindow?.label).toBe('5-hour limit')
    expect(result?.primaryWindow?.percentLeft).toBe(75)
    expect(result?.primaryWindow?.usedPercent).toBe(25)
    expect(result?.primaryWindow?.resetsAt).toBe('17:00')

    expect(result?.secondaryWindow?.label).toBe('Weekly limit')
    expect(result?.secondaryWindow?.percentLeft).toBe(92)
    expect(result?.status).toBe('ok')
  })

  it('detects banned/suspended accounts', () => {
    const text = 'Error: Your account has been suspended or banned by the administrator.'
    const result = parseRateLimitsFromStatusText(text, 'claude')
    expect(result).not.toBeNull()
    expect(result?.status).toBe('banned')
    expect(result?.message).toContain('封禁')
  })

  it('detects exhausted quota', () => {
    const text = 'RESOURCE_EXHAUSTED: Individual quota reached. Resets in ~76h'
    const result = parseRateLimitsFromStatusText(text, 'agy')
    expect(result).not.toBeNull()
    expect(result?.status).toBe('exhausted')
    expect(result?.message).toContain('用尽')
  })

  it('detects low quota warning when percentLeft <= 10', () => {
    const text = 'codex 5h limit: 8% left (resets 20:00)'
    const result = parseRateLimitsFromStatusText(text, 'codex-acp')
    expect(result).not.toBeNull()
    expect(result?.status).toBe('warning')
  })

  it('QuotaCache observes session update message chunks and caches by session and runtime', () => {
    const cache = new QuotaCache()
    expect(cache.observe(null)).toBeNull()
    expect(cache.observe({ sessionId: 's1', update: { content: { type: 'text', text: 'hello world' } } })).toBeNull()

    const updateParams = {
      sessionId: 's-123',
      update: {
        content: {
          type: 'text',
          text: 'codex 5h limit: 95% left (resets 15:00)\ncodex Credits: unlimited',
        },
      },
    }

    const hit = cache.observe(updateParams, 'codex-acp')
    expect(hit).not.toBeNull()
    expect(hit?.primaryWindow?.percentLeft).toBe(95)
    expect(hit?.credits?.unlimited).toBe(true)

    expect(cache.get('s-123')?.primaryWindow?.percentLeft).toBe(95)
    expect(cache.get(undefined, 'codex-acp')?.primaryWindow?.percentLeft).toBe(95)

    cache.clear()
    expect(cache.get('s-123')).toBeUndefined()
  })
})
