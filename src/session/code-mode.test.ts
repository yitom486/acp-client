import { describe, expect, it } from 'vitest'
import {
  codeModeSessionMeta,
  mergeSessionMeta,
  supportsCodeMode,
} from './code-mode'

describe('code mode capability', () => {
  it('只有声明支持的运行时才开启', () => {
    expect(supportsCodeMode('deepseek')).toBe(true)
    for (const runtime of ['codex-acp', 'claude', 'opencode', 'cursor-cli', 'agy', 'gemini', 'copilot']) {
      expect(supportsCodeMode(runtime)).toBe(false)
    }
  })

  it('on → _meta.toolsMode=ptc；off / 不支持 → undefined', () => {
    expect(codeModeSessionMeta('on', 'deepseek')).toEqual({ toolsMode: 'ptc' })
    expect(codeModeSessionMeta('off', 'deepseek')).toBeUndefined()
    expect(codeModeSessionMeta(undefined, 'deepseek')).toBeUndefined()
    expect(codeModeSessionMeta('on', 'codex-acp')).toBeUndefined()
  })

  it('合并 app 资源 meta 时保留资源键，并让 code mode 键生效', () => {
    expect(mergeSessionMeta({ resources: '/tmp/r' }, 'on', 'deepseek')).toEqual({
      resources: '/tmp/r',
      toolsMode: 'ptc',
    })
    // 其它运行时原样返回，不额外加键
    expect(mergeSessionMeta({ resources: '/tmp/r' }, 'on', 'claude')).toEqual({ resources: '/tmp/r' })
    // off 时保持原对象语义（undefined 仍是 undefined）
    expect(mergeSessionMeta(undefined, 'off', 'deepseek')).toBeUndefined()
    // 冲突时 code mode 覆盖同名键，避免被资源声明静默覆盖
    expect(mergeSessionMeta({ toolsMode: 'native' }, 'on', 'deepseek')).toEqual({ toolsMode: 'ptc' })
  })
})
