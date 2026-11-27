import { describe, expect, it } from 'vitest'
import { opencodeV2RuntimePlugin } from './index'

describe('runtimes/opencode-v2', () => {
  it('派发专属插件（不与 1.x 共用 id）', () => {
    expect(opencodeV2RuntimePlugin.id).toBe('opencode-v2')
    expect(typeof opencodeV2RuntimePlugin.auth?.probeAuth).toBe('function')
    expect(typeof opencodeV2RuntimePlugin.auth!.probeAuth!().looksLoggedIn).toBe('boolean')
  })

  it('默认透传 authMethods、不跳过交互式认证', () => {
    const methods = [{ id: 'm1' }]
    expect(opencodeV2RuntimePlugin.auth?.orderAuthMethods?.(methods)).toBe(methods)
    expect(opencodeV2RuntimePlugin.auth?.canSkipInteractiveAuth?.('any-method')).toBe(false)
  })

  it('SQLite 漏检时允许 gate 直连兜底', () => {
    expect(opencodeV2RuntimePlugin.auth?.tryDirectSessionFirst).toBe(true)
  })
})
