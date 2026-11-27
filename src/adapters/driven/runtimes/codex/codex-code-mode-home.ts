/**
 * Isolated CODEX_HOME for code mode.
 *
 * Codex resolves its whole configuration and login from `CODEX_HOME` (default
 * `~/.codex`). Pointing a spawned `codex-acp` at an app-owned directory lets a
 * host enable `features.code_mode` without touching the user's global config.
 *
 * The app directory is seeded from the user's home first (the preferred path):
 * `auth.json` and `config.toml` are copied once, then `code_mode = true` is
 * merged into `[features]`. Later runs keep the app copy; the user's home is
 * never written.
 */

import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCodexHome } from './codex-auth-preflight'

export interface CodexCodeModeHomeOptions {
  /** App-owned directory; defaults to `~/.acp-client/codex-home`. */
  home?: string
  /** Source to seed from; defaults to `CODEX_HOME` or `~/.codex`. */
  sourceHome?: string
  /** Re-copy auth.json/config.toml even when the app copy already exists. */
  force?: boolean
  /** Environment used for the default resolution (tests). */
  env?: NodeJS.ProcessEnv
}

export interface CodexCodeModeHomeResult {
  home: string
  sourceHome: string
  authCopied: boolean
  configCopied: boolean
  codeModeEnabled: boolean
  warnings: string[]
}

/** App data directory name used when no base is supplied. */
const APP_HOME_DIR = '.acp-client'
/** Subdirectory holding the isolated Codex home. */
const APP_CODEX_HOME_DIR = 'codex-home'

/**
 * The app-owned Codex home.
 *
 * Resolution order (no machine-specific path is hardcoded):
 * 1. `ACP_CODEX_HOME` — a full target directory;
 * 2. `<base>/codex-home`, where base is the argument or `ACP_STUDIO_HOME`;
 * 3. `<user home>/.acp-client/codex-home`.
 */
export function resolveAppCodexHome(
  baseDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.ACP_CODEX_HOME?.trim()
  if (explicit) return explicit
  const base = baseDir?.trim() || env.ACP_STUDIO_HOME?.trim()
  if (base) return join(base, APP_CODEX_HOME_DIR)
  return join(homedir(), APP_HOME_DIR, APP_CODEX_HOME_DIR)
}

/**
 * Merge `code_mode = true` into the `[features]` table of a TOML document.
 *
 * Text-level on purpose: the user's config may carry comments, ordering and
 * provider tables a TOML round-trip would rewrite. Existing keys are preserved;
 * only the one line is replaced (or inserted) and a missing table is appended.
 */
export function withCodeModeEnabled(toml: string): string {
  const eol = toml.includes('\r\n') ? '\r\n' : '\n'
  const lines = toml.split(/\r?\n/)
  const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(header)
    if (!match) continue
    if (start >= 0) {
      end = i
      break
    }
    if (match[1].trim() === 'features') start = i
  }
  if (start < 0) {
    const body = toml.replace(/\s+$/, '')
    return `${body}${body ? `${eol}${eol}` : ''}[features]${eol}code_mode = true${eol}`
  }
  const key = /^(\s*)code_mode\s*=/
  for (let i = start + 1; i < end; i += 1) {
    const match = lines[i].match(key)
    if (match) {
      lines[i] = `${match[1]}code_mode = true`
      return lines.join(eol)
    }
  }
  lines.splice(start + 1, 0, 'code_mode = true')
  return lines.join(eol)
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  await chmod(path, 0o600).catch(() => undefined)
}

/**
 * Seed an isolated Codex home from the user's home and enable code mode.
 *
 * @param options - target directory, source home and force-copy flag.
 * @returns what was copied and any non-fatal warning worth logging.
 */
export async function provisionCodexCodeModeHome(
  options: CodexCodeModeHomeOptions = {},
): Promise<CodexCodeModeHomeResult> {
  const env = options.env ?? process.env
  const home = options.home?.trim() || resolveAppCodexHome(undefined, env)
  const sourceHome = options.sourceHome?.trim() || resolveCodexHome(env)
  const warnings: string[] = []
  await mkdir(home, { recursive: true })

  const sourceAuth = join(sourceHome, 'auth.json')
  const targetAuth = join(home, 'auth.json')
  let authCopied = false
  if (existsSync(sourceAuth) && (options.force || !existsSync(targetAuth))) {
    await copyFile(sourceAuth, targetAuth)
    await chmod(targetAuth, 0o600).catch(() => undefined)
    authCopied = true
  } else if (!existsSync(targetAuth)) {
    warnings.push(
      `no auth.json in ${sourceHome}; run "CODEX_HOME=${home} codex login" or copy it manually`,
    )
  }

  const sourceConfig = join(sourceHome, 'config.toml')
  const targetConfig = join(home, 'config.toml')
  let configCopied = false
  if (existsSync(sourceConfig) && (options.force || !existsSync(targetConfig))) {
    await copyFile(sourceConfig, targetConfig)
    configCopied = true
  } else if (!existsSync(targetConfig) && !existsSync(sourceConfig)) {
    warnings.push(`no config.toml in ${sourceHome}; starting from an empty one`)
  }

  const current = existsSync(targetConfig) ? await readFile(targetConfig, 'utf8') : ''
  const next = withCodeModeEnabled(current)
  if (next !== current) await writeAtomic(targetConfig, next)

  return {
    home,
    sourceHome,
    authCopied,
    configCopied,
    codeModeEnabled: true,
    warnings,
  }
}
