import { describe, expect, it } from 'vitest'
import { QuotaCache } from './quota'

describe('QuotaCache 的 ACP usage_update（上下文用量）', () => {
  it('observe 只记录用量，不产出余额对象', () => {
    const cache = new QuotaCache()
    const observed = cache.observe(
      { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 2500, size: 10000 } },
      'deepseek',
    )
    expect(observed).toBeNull()
    expect(cache.get('s1', 'deepseek')).toBeUndefined()
  })

  it('有余额时并入 extraWindows 的 Context 窗口', () => {
    const cache = new QuotaCache()
    cache.set({ runtimeId: 'deepseek', credits: { balance: 42, currency: 'CNY' }, updatedAt: Date.now() }, 's1')
    cache.observe(
      { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 2500, size: 10000 } },
      'deepseek',
    )
    const merged = cache.applyContextUsage(cache.get('s1', 'deepseek'), 's1', 'deepseek')
    expect(merged?.credits).toEqual({ balance: 42, currency: 'CNY' })
    expect(merged?.extraWindows?.[0]).toMatchObject({
      label: 'Context',
      used: 2500,
      total: 10000,
      usedPercent: 25,
      percentLeft: 75,
    })
  })

  it('没有余额时单独给出 Context 主窗口', () => {
    const cache = new QuotaCache()
    cache.observe(
      { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 9000, size: 10000 } },
      'deepseek',
    )
    const quota = cache.applyContextUsage(null, 's1', 'deepseek')
    expect(quota?.primaryWindow?.label).toBe('Context')
    expect(quota?.primaryWindow?.percentLeft).toBe(10)
    expect(quota?.status).toBe('ok')
  })

  it('重复上报 Context 不产生重复窗口', () => {
    const cache = new QuotaCache()
    cache.set(
      {
        runtimeId: 'deepseek',
        updatedAt: Date.now(),
        extraWindows: [{ label: 'Context', used: 1, total: 10, percentLeft: 90 }],
      },
      's1',
    )
    cache.observe(
      { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 5, size: 10 } },
      'deepseek',
    )
    const merged = cache.applyContextUsage(cache.get('s1', 'deepseek'), 's1', 'deepseek')
    expect(merged?.extraWindows?.filter((item) => item.label === 'Context')).toHaveLength(1)
    expect(merged?.extraWindows?.[0]?.used).toBe(5)
  })

  it('非法 used/size 被忽略', () => {
    const cache = new QuotaCache()
    cache.observe({ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 'x', size: 0 } }, 'deepseek')
    expect(cache.applyContextUsage(null, 's1', 'deepseek')).toBeNull()
  })
})
