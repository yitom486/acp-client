import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AcpAuthPreflight } from '../../../../domain/contracts'

export interface OpencodePathOverrides {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

function pickEnv(env: NodeJS.ProcessEnv | undefined, key: string): string {
  return env?.[key]?.trim() ?? ''
}

export function resolveOpencodeAuthCandidates(overrides?: OpencodePathOverrides): string[] {
  const platform = overrides?.platform ?? process.platform
  const env = overrides?.env ?? process.env
  const home = overrides?.home ?? homedir()
  const seen = new Set<string>()
  const out: string[] = []
  const push = (p: string) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push(p)
  }

  const xdg = pickEnv(env, 'XDG_DATA_HOME')
  if (xdg) push(join(xdg, 'opencode', 'auth.json'))

  if (platform === 'win32') {
    const localAppData =
      pickEnv(env, 'LOCALAPPDATA') ||
      (pickEnv(env, 'USERPROFILE') ? join(pickEnv(env, 'USERPROFILE'), 'AppData', 'Local') : '')
    if (localAppData) push(join(localAppData, 'opencode', 'auth.json'))
    const userProfile = pickEnv(env, 'USERPROFILE') || home
    if (userProfile) push(join(userProfile, '.local', 'share', 'opencode', 'auth.json'))
  } else if (home) {
    push(join(home, '.local', 'share', 'opencode', 'auth.json'))
  }
  return out
}

export function resolveOpencodeAuthFile(): string {
  return resolveOpencodeAuthCandidates()[0] ?? join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

export function isValidOpencodeAuthFile(authFile: string): boolean {
  try {
    if (!authFile || !existsSync(authFile)) return false
    const raw = readFileSync(authFile, 'utf8').trim()
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return false
    return Object.keys(parsed).length > 0
  } catch {
    return false
  }
}

export function probeOpencodeAuth(overrides?: OpencodePathOverrides): AcpAuthPreflight {
  const candidates = resolveOpencodeAuthCandidates(overrides)
  let firstExisting: string | null = null
  let validFile: string | null = null
  for (const candidate of candidates) {
    let exists = false
    try {
      exists = existsSync(candidate)
    } catch {
      exists = false
    }
    if (!exists) continue
    firstExisting ??= candidate
    if (validFile) continue
    if (isValidOpencodeAuthFile(candidate)) validFile = candidate
  }

  const authFile = validFile ?? firstExisting ?? candidates[0] ?? resolveOpencodeAuthFile()
  const authDir = dirname(authFile)
  let hasHomeDir = false
  try {
    hasHomeDir = existsSync(authDir)
  } catch {
    hasHomeDir = false
  }

  return {
    homeDir: authDir,
    hasHomeDir,
    hasAuthFile: firstExisting !== null,
    hasApiKeyEnv: false,
    looksLoggedIn: validFile !== null,
  }
}
