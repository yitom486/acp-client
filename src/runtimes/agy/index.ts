import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import type { AcpAuthMethod, CodexAuthPreflight } from '../../contracts'
import type { GenericRuntimeAdapter } from '../index'
import { probeAgyQuota } from './quota'

export {
  probeAgyQuota,
  resolveAntigravityAccount,
  resolveAntigravityLanguageServer,
} from './quota'

export interface AntigravityCliPathOverrides {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

function isExecutableOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (!pathValue.trim()) return false
  const sep = platform === 'win32' ? ';' : delimiter
  for (const dir of pathValue.split(sep)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (!trimmed) continue
    try {
      if (existsSync(join(trimmed, command))) return true
    } catch {
      // skip unreadable PATH entry
    }
  }
  return false
}

/**
 * Resolve `agy acp` spawn command from PATH or standard per-user install locations.
 * Returns `null` when `agy` is not installed anywhere so connect() surfaces a clear ACP_SPAWN_ERROR.
 */
export function resolveAntigravityCliCommand(
  overrides?: AntigravityCliPathOverrides,
): { command: string; args: string[] } | null {
  const args = ['acp']
  const platform = overrides?.platform ?? process.platform
  const env = overrides?.env ?? process.env
  const home = overrides?.home ?? homedir()

  const binaries = platform === 'win32' ? ['agy.exe', 'agy.cmd'] : ['agy']
  for (const binary of binaries) {
    if (isExecutableOnPath(binary, env, platform)) {
      return { command: binary, args }
    }
  }

  const candidates: string[] = []
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || (env.USERPROFILE?.trim() ? join(env.USERPROFILE.trim(), 'AppData', 'Local') : '')
    const userProfile = env.USERPROFILE?.trim() || home
    if (localAppData) candidates.push(join(localAppData, 'antigravity', 'agy.exe'))
    if (userProfile) candidates.push(join(userProfile, '.local', 'bin', 'agy.exe'))
  } else if (home) {
    candidates.push(join(home, '.local', 'bin', 'agy'))
  }

  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) {
        return { command: candidate, args }
      }
    } catch {
      // ignore unreadable path
    }
  }
  return null
}

export function probeAgyAuth(): CodexAuthPreflight {
  return {
    codexHome: '',
    hasCodexHome: false,
    hasAuthFile: false,
    hasApiKeyEnv: false,
    looksLoggedIn: false,
  }
}

export const agyAdapter: GenericRuntimeAdapter = {
  id: 'agy',
  prepareAppResources: async ({directory}) => {
    const prep = prepareCompatibilityResources(directory, 'native-session-version-not-verified')
    return {...prep, env:{AGY_ACP_RESOURCES_DIR:directory}, report:{...prep.report, rulesPrepared:prep.report.rulesChars > 0}}
  },
  appResourceSessionMeta: directory => ({appResources:{directory}}),
  supportedBridgeVersions: ['0.1.24', '0.1.25', '0.1.26'],
  probeAuth: () => probeAgyAuth(),
  probeQuota: (options) => probeAgyQuota(options),
  orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
  canSkipInteractiveAuth: () => false,
  tryDirectSessionFirst: true,
}

export const antigravityCliAdapter: GenericRuntimeAdapter = {
  id: 'antigravity-cli',
  prepareAppResources: async ({ directory }) => prepareCompatibilityResources(directory, 'runtime-not-supported'),
  probeAuth: () => probeAgyAuth(),
  probeQuota: (options) => probeAgyQuota({ ...options, runtimeId: 'antigravity-cli' }),
  resolveSpawnCommand: () => resolveAntigravityCliCommand(),
  orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
  canSkipInteractiveAuth: () => false,
  tryDirectSessionFirst: true,
}
