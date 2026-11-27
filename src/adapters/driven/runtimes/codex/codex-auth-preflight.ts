import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emptyAcpAuthPreflight, type AcpAuthPreflight } from '../../../../domain/contracts'

export { emptyAcpAuthPreflight, type AcpAuthPreflight }

export function isCodexPreflightRuntime(runtimeId?: string): boolean {
  return !runtimeId || runtimeId === 'codex-acp'
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.codex')
}

export function probeCodexAuth(): AcpAuthPreflight {
  const codexHome = resolveCodexHome()
  const hasHomeDir = existsSync(codexHome)
  const hasAuthFile = existsSync(join(codexHome, 'auth.json'))
  const hasApiKeyEnv = Boolean(
    process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim(),
  )

  return {
    homeDir: codexHome,
    hasHomeDir,
    hasAuthFile,
    hasApiKeyEnv,
    looksLoggedIn: hasAuthFile || hasApiKeyEnv,
  }
}
