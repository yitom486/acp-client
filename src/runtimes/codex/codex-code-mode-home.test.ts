import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  provisionCodexCodeModeHome,
  resolveAppCodexHome,
  withCodeModeEnabled,
} from './codex-code-mode-home'

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

describe('withCodeModeEnabled', () => {
  it('appends a features table when none exists', () => {
    const out = withCodeModeEnabled('model = "gpt-5"\n')
    expect(out).toContain('model = "gpt-5"')
    expect(out).toContain('[features]')
    expect(out).toMatch(/\[features\]\r?\ncode_mode = true/)
  })

  it('keeps sibling keys and comments inside [features]', () => {
    const input = ['[features]', '# keep me', 'web_search = true', '', '[model_providers.x]', 'name = "x"', ''].join('\n')
    const out = withCodeModeEnabled(input)
    expect(out).toContain('# keep me')
    expect(out).toContain('web_search = true')
    expect(out).toContain('code_mode = true')
    expect(out.indexOf('code_mode')).toBeLessThan(out.indexOf('[model_providers.x]'))
  })

  it('overwrites an existing code_mode value instead of duplicating it', () => {
    const input = ['[features]', 'code_mode = false', 'web_search = true', ''].join('\n')
    const out = withCodeModeEnabled(input)
    expect(out.match(/code_mode\s*=/g)).toHaveLength(1)
    expect(out).toContain('code_mode = true')
    expect(out).toContain('web_search = true')
  })

  it('is idempotent', () => {
    const once = withCodeModeEnabled('[features]\ncode_mode = true\n')
    expect(withCodeModeEnabled(once)).toBe(once)
  })
})

describe('provisionCodexCodeModeHome', () => {
  it('seeds auth.json and config.toml from the user home and enables code mode', async () => {
    const source = await tempDir('codex-src-')
    const target = await tempDir('codex-dst-')
    await writeFile(join(source, 'auth.json'), '{"token":"secret"}')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"\n[features]\nweb_search = true\n')

    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source })
    expect(result.authCopied).toBe(true)
    expect(result.configCopied).toBe(true)
    expect(result.warnings).toEqual([])
    expect(await readFile(join(target, 'auth.json'), 'utf8')).toBe('{"token":"secret"}')
    const config = await readFile(join(target, 'config.toml'), 'utf8')
    expect(config).toContain('model = "gpt-5"')
    expect(config).toContain('web_search = true')
    expect(config).toContain('code_mode = true')
    // Source must never be modified.
    expect(await readFile(join(source, 'config.toml'), 'utf8')).not.toContain('code_mode')
  })

  it('keeps the app copy on a second run and only fixes the feature flag', async () => {
    const source = await tempDir('codex-src-')
    const target = await tempDir('codex-dst-')
    await writeFile(join(source, 'auth.json'), '{"token":"old"}')
    await writeFile(join(source, 'config.toml'), '[features]\ncode_mode = true\n')
    await writeFile(join(target, 'auth.json'), '{"token":"app"}')
    await writeFile(join(target, 'config.toml'), '[features]\ncode_mode = false\n')

    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source })
    expect(result.authCopied).toBe(false)
    expect(await readFile(join(target, 'auth.json'), 'utf8')).toBe('{"token":"app"}')
    expect(await readFile(join(target, 'config.toml'), 'utf8')).toContain('code_mode = true')
  })

  it('creates the app home and warns when the user home has no login', async () => {
    const source = await tempDir('codex-empty-')
    const target = join(await tempDir('codex-dst-'), 'nested', 'home')
    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source })
    expect(result.authCopied).toBe(false)
    expect(result.warnings.join(' ')).toContain('codex login')
    expect(await readFile(join(target, 'config.toml'), 'utf8')).toContain('code_mode = true')
  })

  it('derives the default app home from a base directory', () => {
    expect(resolveAppCodexHome('C:/app-data')).toMatch(/codex-home$/)
  })

  it('honors ACP_CODEX_HOME and ACP_STUDIO_HOME instead of a fixed path', () => {
    expect(resolveAppCodexHome(undefined, { ACP_CODEX_HOME: 'X:/custom-home' })).toBe('X:/custom-home')
    expect(resolveAppCodexHome(undefined, { ACP_STUDIO_HOME: 'X:/studio' })).toBe(join('X:/studio', 'codex-home'))
    // ACP_CODEX_HOME wins over a base argument as the explicit override
    expect(resolveAppCodexHome('X:/base', { ACP_CODEX_HOME: 'X:/custom-home' })).toBe('X:/custom-home')
  })

  it('reads CODEX_HOME from the supplied environment', async () => {
    const source = await tempDir('codex-src-')
    const target = await tempDir('codex-dst-')
    await writeFile(join(source, 'auth.json'), '{"token":"env"}')
    const result = await provisionCodexCodeModeHome({
      home: target,
      env: { CODEX_HOME: source },
    })
    expect(result.sourceHome).toBe(source)
    expect(await readFile(join(target, 'auth.json'), 'utf8')).toBe('{"token":"env"}')
  })
})
