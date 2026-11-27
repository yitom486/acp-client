import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeResourceSessionMeta } from '../runtimes/claude'
import { mergeOpenCodeAppConfig } from '../runtimes/opencode'
import { APP_RESOURCE_CAPABILITIES, getRuntimePlugin } from '../runtimes/registry'

describe('runtime resource configuration', () => {
  it('merges OpenCode instructions and skills without replacing model or auth environment', () => {
    const dir = join(tmpdir(), 'resource root with spaces')
    const config = JSON.parse(
      mergeOpenCodeAppConfig(
        JSON.stringify({
          model: 'user/model',
          instructions: ['USER.md'],
          skills: { paths: ['user-skills'], urls: ['https://example.com'] },
          mcp: { user: { enabled: true } },
        }),
        dir,
      ),
    )
    expect(config.model).toBe('user/model')
    expect(config.instructions).toEqual(['USER.md', join(dir, 'AGENTS.md')])
    expect(config.skills).toEqual({
      paths: ['user-skills', join(dir, 'skills')],
      urls: ['https://example.com'],
    })
    expect(config.mcp.user.enabled).toBe(true)
    expect(JSON.parse(mergeOpenCodeAppConfig(JSON.stringify(config), dir))).toEqual(config)
    for (const bad of ['null', '[]', '{broken', '{"instructions":"not-array"}', '{"skills":{"paths":42}}']) {
      expect(() => mergeOpenCodeAppConfig(bad, dir)).toThrow()
    }
  })

  it('every registered runtime declares native entry or diagnostic compatibility, without redirecting auth homes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-resources-'))
    writeFileSync(join(dir, 'AGENTS.md'), 'APP_RULES')
    mkdirSync(join(dir, 'skills'))
    try {
      for (const id of Object.keys(APP_RESOURCE_CAPABILITIES)) {
        const plugin = getRuntimePlugin(id)
        expect(plugin.resources?.prepareOverlay).toBeDefined()
        const prep = await plugin.resources!.prepareOverlay!({ directory: dir, workspaceRoot: dir, env: {} })
        expect(prep.report.rulesChars).toBe(9)
        expect(prep.report.rulesApplied).toBe(false)
        for (const name of [
          'HOME',
          'USERPROFILE',
          'CODEX_HOME',
          'CLAUDE_CONFIG_DIR',
          'GEMINI_CLI_HOME',
          'CURSOR_CONFIG_DIR',
          'COPILOT_HOME',
          'DSH_HOME',
        ]) {
          expect(prep.env?.[name]).toBeUndefined()
        }
      }
      const meta = claudeResourceSessionMeta(dir) as Record<string, unknown>
      expect(meta.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'APP_RULES' })
      expect(meta.claudeCode).toEqual({ options: { plugins: [{ type: 'local', path: dir }] } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
