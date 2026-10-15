import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  digestAppResources,
  readAppResourcesDir,
} from './app-resources'
import { mergeCodexConfigJson, mergeConfigTomlPreserving } from './config-text'
import { isSupportedBridgeVersion, resolveRuntimeEligibility } from './eligibility'

describe('应用资源目录读取', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  })
  function makeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-res-'))
    dirs.push(dir)
    for (const [rel, text] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, text, 'utf8')
    }
    return dir
  }

  it('AGENTS.md 与 skills/ 正常发现，摘要稳定', () => {
    const dir = makeDir({
      'AGENTS.md': '# host rules\n',
      'skills/render/SKILL.md': '---\nname: render\n---\nbody\n',
      'skills/empty-note.txt': 'not a skill',
    })
    const load = readAppResourcesDir(dir)
    expect(load.directoryReadable).toBe(true)
    expect(load.rules?.chars).toBeGreaterThan(0)
    expect(load.skills.map((s) => s.name)).toEqual(['render'])
    expect(load.skills[0]?.path).toBe('skills/render/SKILL.md')
    const d1 = digestAppResources(load)
    const d2 = digestAppResources(readAppResourcesDir(dir))
    expect(d1).toBe(d2)
    expect(d1).toHaveLength(64)
  })

  it('缺 AGENTS.md 返回 null 规则并警告，不抛错', () => {
    const dir = makeDir({ 'skills/x/SKILL.md': 'body\n' })
    const load = readAppResourcesDir(dir)
    expect(load.rules).toBeNull()
    expect(digestAppResources(load)).toBeNull()
    expect(load.warnings.length).toBeGreaterThan(0)
    expect(load.skills.map((s) => s.name)).toEqual(['x'])
  })

  it('无 SKILL.md 的技能目录被跳过并警告', () => {
    const dir = makeDir({ 'AGENTS.md': 'rules\n', 'skills/broken/README.md': 'nope\n' })
    const load = readAppResourcesDir(dir)
    expect(load.skills).toEqual([])
    expect(load.warnings.some((w) => w.includes('broken'))).toBe(true)
  })

  it('目录不可读整体回退', () => {
    const load = readAppResourcesDir(join(tmpdir(), 'acp-res-missing-dir'))
    expect(load.directoryReadable).toBe(false)
    expect(load.rules).toBeNull()
    expect(load.skills).toEqual([])
  })

  it('内容变化摘要变化', () => {
    const a = makeDir({ 'AGENTS.md': 'v1\n' })
    const b = makeDir({ 'AGENTS.md': 'v2\n' })
    expect(digestAppResources(readAppResourcesDir(a))).not.toBe(digestAppResources(readAppResourcesDir(b)))
  })
})

describe('CODEX_CONFIG 合并', () => {
  it('无现有值只写宿主块', () => {
    const res = mergeCodexConfigJson({ hostBlock: 'HOST' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.json)).toEqual({ developer_instructions: 'HOST' })
    expect(res.preservedUserInstructions).toBe(false)
  })

  it('保留全部已有键与用户 instructions（宿主在前）', () => {
    const res = mergeCodexConfigJson({
      existingRaw: JSON.stringify({ model: 'm', developer_instructions: 'USER' }),
      hostBlock: 'HOST',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const parsed = JSON.parse(res.json) as Record<string, unknown>
    expect(parsed['model']).toBe('m')
    expect(parsed['developer_instructions']).toBe('HOST\n\nUSER')
    expect(res.preservedUserInstructions).toBe(true)
  })

  it('无效 JSON 与冲突类型明确失败', () => {
    expect(mergeCodexConfigJson({ existingRaw: '{bad', hostBlock: 'H' })).toEqual({
      ok: false,
      reason: 'invalid-json',
    })
    expect(mergeCodexConfigJson({ existingRaw: '[1]', hostBlock: 'H' })).toEqual({
      ok: false,
      reason: 'invalid-json',
    })
    expect(
      mergeCodexConfigJson({ existingRaw: '{"developer_instructions":{}}', hostBlock: 'H' }),
    ).toEqual({ ok: false, reason: 'conflicting-value' })
    expect(mergeCodexConfigJson({ hostBlock: '  ' })).toEqual({ ok: false, reason: 'empty-block' })
  })
})

describe('config.toml 手术合并', () => {
  it('用户内容保留，只替换管理键与整节', () => {
    const existing = [
      '# keep me',
      'model = "user-model"',
      'developer_instructions = "Be brief."',
      '',
      '[model_providers.other]',
      'model = "other-model"',
      '',
      '[model_providers.inkdown-custom]',
      'name = "stale"',
    ].join('\n')
    const merged = mergeConfigTomlPreserving({
      existingText: existing,
      managedTopKeys: ['model', 'model_provider'],
      managedTables: ['model_providers.inkdown-custom'],
      replacementBlock: 'model_provider = "inkdown-custom"\nmodel = "prov-model"\n\n[model_providers.inkdown-custom]\nname = "fresh"\n',
    })
    expect(merged).toContain('# keep me')
    expect(merged).toContain('developer_instructions = "Be brief."')
    expect(merged).toContain('model = "other-model"')
    expect(merged).toContain('name = "fresh"')
    expect(merged).not.toContain('name = "stale"')
    expect(merged).not.toContain('model = "user-model"')
    expect(merged.match(/^model = /gm)).toHaveLength(2)
  })

  it('空原文直接落块', () => {
    expect(
      mergeConfigTomlPreserving({ existingText: null, managedTopKeys: [], managedTables: [], replacementBlock: 'a = "1"\n' }),
    ).toBe('a = "1"\n')
  })
})

describe('运行时资格与版本门', () => {
  it('已核对的运行时才候选', () => {
    expect(resolveRuntimeEligibility('codex-acp')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('opencode')).toEqual({ eligible: true })
    expect(resolveRuntimeEligibility('')).toEqual({ eligible: false, reason: 'runtime-not-verified' })
  })

  it('版本门：未知回退，白名单放行', () => {
    expect(isSupportedBridgeVersion('codex-acp', '2.2.2')).toEqual({ eligible: true })
    expect(isSupportedBridgeVersion('codex-acp', 'v2.0.0')).toEqual({ eligible: false, reason: 'unsupported-bridge-version' })
    expect(isSupportedBridgeVersion('codex-acp', undefined)).toEqual({ eligible: false, reason: 'unknown-bridge-version' })
    expect(isSupportedBridgeVersion('codex-acp', '3.0.0')).toEqual({ eligible: false, reason: 'unsupported-bridge-version' })
    expect(isSupportedBridgeVersion('opencode', '2.0.6')).toEqual({ eligible: false, reason: 'unsupported-bridge-version' })
  })
})
