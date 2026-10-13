import { describe, expect, it } from 'vitest'
import { opencodeV2Adapter } from './index'

describe('runtimes/opencode-v2', () => {
  it('派发专属适配器（不与 1.x 共用 id）', () => {
    expect(opencodeV2Adapter.id).toBe('opencode-v2')
    expect(typeof opencodeV2Adapter.probeAuth).toBe('function')
    expect(typeof opencodeV2Adapter.probeAuth().looksLoggedIn).toBe('boolean')
  })

  it('默认透传 authMethods、不跳过交互式认证', () => {
    const methods = [{ id: 'm1' }]
    expect(opencodeV2Adapter.orderAuthMethods?.(methods)).toBe(methods)
    expect(opencodeV2Adapter.canSkipInteractiveAuth?.('any-method')).toBe(false)
  })

  it('SQLite 漏检时允许 gate 直连兜底', () => {
    expect(opencodeV2Adapter.tryDirectSessionFirst).toBe(true)
  })
})
