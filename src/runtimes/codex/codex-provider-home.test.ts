import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCustomProviderConfigToml,
  buildCustomProviderSpawnEnv,
  INKDOWN_PROVIDER_API_KEY_ENV,
  INKDOWN_PROVIDER_ID,
} from './codex-provider-home'
import { codexAdapter, provisionCustomProviderCodexHome } from './index'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('codex prepareAppResources（单目录接口）', () => {
  function makeResources(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'acp-codex-res-'))
    dirs.push(dir)
    for (const [rel, text] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, text, 'utf8')
    }
    return dir
  }

  it('规则与技能被读取并进入 CODEX_CONFIG，不写用户文件', async () => {
    const dir = makeResources({
      'AGENTS.md': '# host rules\nBe brief.\n',
      'skills/demo/SKILL.md': '---\nname: demo\n---\nbody\n',
    })
    const prep = await codexAdapter.prepareAppResources!({ directory: dir, workspaceRoot: process.cwd(), env: { CODEX_HOME: dir } })
    expect(prep.report.rulesApplied).toBe(false)
    expect(prep.report.rulesPrepared).toBe(true)
    expect(prep.report.skillsFound).toEqual(['demo'])
    expect(prep.report.profileDigest).toHaveLength(64)
    const parsed = JSON.parse(prep.env!['CODEX_CONFIG'] as string) as Record<string, unknown>
    expect(parsed['developer_instructions']).toContain('Be brief.')
    // 目录内无任何写痕迹（无 manifest、无合并文件）
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# host rules\nBe brief.\n')
  })

  it('缺 AGENTS.md 明确未应用（目录存在≠成功）', async () => {
    const dir = makeResources({ 'skills/demo/SKILL.md': 'body\n' })
    const prep = await codexAdapter.prepareAppResources!({ directory: dir, workspaceRoot: process.cwd(), env: { CODEX_HOME: dir } })
    expect(prep.report.rulesApplied).toBe(false)
    expect(prep.report.reason).toBe('rules-missing')
    expect(prep.report.skillsFound).toEqual(['demo'])
    expect(prep.env).toBeUndefined()
  })

  it('保留用户已有 CODEX_CONFIG 与 instructions', async () => {
    const dir = makeResources({ 'AGENTS.md': 'HOST\n' })
    process.env['CODEX_CONFIG'] = JSON.stringify({ model: 'm', developer_instructions: 'USER' })
    try {
      const prep = await codexAdapter.prepareAppResources!({ directory: dir, workspaceRoot: process.cwd(), env: { CODEX_HOME: dir } })
      const parsed = JSON.parse(prep.env!['CODEX_CONFIG'] as string) as Record<string, unknown>
      expect(parsed['model']).toBe('m')
      expect(parsed['developer_instructions']).toContain('HOST')
      expect(parsed['developer_instructions']).toContain('USER')
    } finally {
      delete process.env['CODEX_CONFIG']
    }
  })
})

describe('provisionCustomProviderCodexHome 手术合并', () => {
  it('保留隔离目录已有用户规则，只替换供应商键', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-codex-home-'))
    dirs.push(home)
    writeFileSync(
      join(home, 'config.toml'),
      '# user\ndeveloper_instructions = "Be brief."\nmodel = "user-model"\n',
      'utf8',
    )
    const ok = await provisionCustomProviderCodexHome(
      { baseUrl: 'https://example.com', model: 'm', apiKey: 'k', wireApi: 'chat' },
      home,
    )
    expect(ok).toBe(true)
    const text = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(text).toContain('developer_instructions = "Be brief."')
    expect(text).toContain('model = "m"')
    expect(text).not.toContain('model = "user-model"')
  })

  it('空目录直接落块', async () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-codex-home-empty-'))
    dirs.push(home)
    const ok = await provisionCustomProviderCodexHome(
      { baseUrl: 'https://example.com', model: 'm', apiKey: 'k', wireApi: 'chat' },
      home,
    )
    expect(ok).toBe(true)
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('model_provider = "inkdown-custom"')
  })
})

describe('buildCustomProviderConfigToml', () => {
  it('chat 档：生成 provider 段与顶层 model_provider/model', () => {
    const toml = buildCustomProviderConfigToml({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      wireApi: 'chat',
    })
    expect(toml).toContain('model_provider = "inkdown-custom"')
    expect(toml).toContain('model = "deepseek-chat"')
    expect(toml).toContain(`[model_providers.${INKDOWN_PROVIDER_ID}]`)
    expect(toml).toContain('name = "DeepSeek"')
    expect(toml).toContain('base_url = "https://api.deepseek.com"')
    expect(toml).toContain(`env_key = "${INKDOWN_PROVIDER_API_KEY_ENV}"`)
    expect(toml).toContain('wire_api = "chat"')
  })

  it('responses 档与缺省 name 回退', () => {
    const toml = buildCustomProviderConfigToml({
      baseUrl: 'https://example.com/v1',
      model: 'my-model',
      wireApi: 'responses',
    })
    expect(toml).toContain('wire_api = "responses"')
    expect(toml).toContain('name = "自定义 API"')
  })

  it('转义 model/name/baseUrl 中的双引号与反斜杠', () => {
    const toml = buildCustomProviderConfigToml({
      baseUrl: 'https://example.com/"x"\\y',
      model: 'a"b\\c',
      wireApi: 'chat',
    })
    expect(toml).toContain('model = "a\\"b\\\\c"')
    expect(toml).toContain('base_url = "https://example.com/\\"x\\"\\\\y"')
  })
})

describe('buildCustomProviderSpawnEnv', () => {
  it('注入 CODEX_HOME 与专用 Key 环境变量，不触碰 OPENAI_*', () => {
    const env = buildCustomProviderSpawnEnv(
      { baseUrl: 'https://x', model: 'm', wireApi: 'chat' },
      'sk-test',
      'D:/home/codex-isolated',
    )
    expect(env.CODEX_HOME).toBe('D:/home/codex-isolated')
    expect(env[INKDOWN_PROVIDER_API_KEY_ENV]).toBe('sk-test')
    expect('OPENAI_API_KEY' in env).toBe(false)
  })
})
