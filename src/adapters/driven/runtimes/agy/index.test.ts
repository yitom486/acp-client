import { describe, expect, it } from 'vitest'
import { agyRuntimePlugin, probeAgyAuth } from './index'

describe('agyRuntimePlugin（legacy @yitom/agy-acp-map 桥接插件）', () => {
  it('probe 中性空结果（authMethods 为 []，直连即可）', () => {
    const probed = probeAgyAuth()
    expect(probed.looksLoggedIn).toBe(false)
    expect(probed.hasAuthFile).toBe(false)
    expect(probed.hasApiKeyEnv).toBe(false)
    expect(agyRuntimePlugin.auth?.probeAuth?.()).toEqual(probed)
  })

  it('tryDirectSessionFirst=true 且无自定义 spawn 命令覆盖', () => {
    expect(agyRuntimePlugin.id).toBe('agy')
    expect(agyRuntimePlugin.auth?.tryDirectSessionFirst).toBe(true)
    expect(agyRuntimePlugin.spawn?.resolveCommand).toBeUndefined()
  })
})
