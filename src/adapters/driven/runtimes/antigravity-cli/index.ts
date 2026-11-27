import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { emptyAcpAuthPreflight, type AcpAuthMethod } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { isWindowsPlatform } from '../_shared/platform'
import { probeAntigravityCliQuota } from './quota'

export { probeAntigravityCliQuota } from './quota'

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
    const localAppData =
      env.LOCALAPPDATA?.trim() ||
      (env.USERPROFILE?.trim() ? join(env.USERPROFILE.trim(), 'AppData', 'Local') : '')
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

export const antigravityCliRuntimePlugin: AcpRuntimePlugin = {
  id: 'antigravity-cli',
  manifest: {
    id: 'antigravity-cli',
    name: 'Antigravity',
    description: '启动 Google Antigravity CLI 自带的 agy acp 服务',
    authHint: '复用 Antigravity CLI 登录。需要登录时选择 Agent 提供的方式，或在终端运行 agy acp --login',
    command: isWindowsPlatform() ? 'agy.exe' : 'agy',
    args: ['acp'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => emptyAcpAuthPreflight(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
    tryDirectSessionFirst: true,
  },
  spawn: {
    resolveCommand: () => resolveAntigravityCliCommand(),
  },
  resources: {
    capability: { entry: null, strategy: 'compatibility', configHome: null },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'runtime-not-supported'),
  },
  quota: {
    probeQuota: (options) => probeAntigravityCliQuota({ ...options, runtimeId: 'antigravity-cli' }),
  },
}
