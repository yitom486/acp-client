import { describe, expect, it } from 'vitest'
import {
  codeModeSessionMeta,
  mergeSessionMeta,
  parseCodeModeModes,
  supportsCodeMode,
} from './code-mode'

const DECLARED = { _meta: { toolsMode: { values: ['native', 'ptc'] } } }
const NATIVE_ONLY = { _meta: { toolsMode: { values: ['native'] } } }
const UNDECLARED = { mcpCapabilities: { http: true } }

describe('code mode capability', () => {
  it('只认 initialize 的 _meta.toolsMode 声明', () => {
    expect(parseCodeModeModes(DECLARED)).toEqual(['native', 'ptc'])
    expect(supportsCodeMode(DECLARED)).toBe(true)
    expect(supportsCodeMode(NATIVE_ONLY)).toBe(false)
    expect(supportsCodeMode(UNDECLARED)).toBe(false)
    expect(supportsCodeMode(null)).toBe(false)
  })

  it('on + 声明 → _meta.toolsMode=ptc；off / 未声明 → undefined', () => {
    expect(codeModeSessionMeta('on', DECLARED)).toEqual({ toolsMode: 'ptc' })
    expect(codeModeSessionMeta('off', DECLARED)).toBeUndefined()
    expect(codeModeSessionMeta(undefined, DECLARED)).toBeUndefined()
    expect(codeModeSessionMeta('on', UNDECLARED)).toBeUndefined()
  })

  it('合并 app 资源 meta 时保留资源键，并让 code mode 键生效', () => {
    expect(mergeSessionMeta({ resources: '/tmp/r' }, 'on', DECLARED)).toEqual({
      resources: '/tmp/r',
      toolsMode: 'ptc',
    })
    expect(mergeSessionMeta({ resources: '/tmp/r' }, 'on', UNDECLARED)).toEqual({ resources: '/tmp/r' })
    expect(mergeSessionMeta(undefined, 'off', DECLARED)).toBeUndefined()
    expect(mergeSessionMeta({ toolsMode: 'native' }, 'on', DECLARED)).toEqual({ toolsMode: 'ptc' })
  })
})
