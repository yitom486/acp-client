import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AcpAuthMethod } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { readAppRulesText } from '../../resources/app-resources'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import {
  isValidOpencodeAuthFile,
  probeOpencodeAuth,
  resolveOpencodeAuthCandidates,
  resolveOpencodeAuthFile,
  type OpencodePathOverrides,
} from '../_shared/opencode-auth'
import { isWindowsPlatform } from '../_shared/platform'
import { probeOpencodeQuota } from './quota'

export * from './quota'
export {
  isValidOpencodeAuthFile,
  probeOpencodeAuth,
  resolveOpencodeAuthCandidates,
  resolveOpencodeAuthFile,
  type OpencodePathOverrides,
}

export function mergeOpenCodeAppConfig(raw: string | undefined, directory: string): string {
  const value: unknown = raw?.trim() ? JSON.parse(raw) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-opencode-config')
  const config = value as Record<string, unknown>
  if (
    config.instructions !== undefined &&
    (!Array.isArray(config.instructions) || config.instructions.some((v) => typeof v !== 'string'))
  ) {
    throw new Error('invalid-opencode-instructions')
  }
  if (
    config.skills !== undefined &&
    (!config.skills || typeof config.skills !== 'object' || Array.isArray(config.skills))
  ) {
    throw new Error('invalid-opencode-skills')
  }
  const skills = (config.skills ?? {}) as Record<string, unknown>
  if (
    skills.paths !== undefined &&
    (!Array.isArray(skills.paths) || skills.paths.some((v) => typeof v !== 'string'))
  ) {
    throw new Error('invalid-opencode-skill-paths')
  }
  return JSON.stringify({
    ...config,
    instructions: [...new Set([...((config.instructions as string[]) ?? []), join(directory, 'AGENTS.md')])],
    skills: {
      ...skills,
      paths: [...new Set([...((skills.paths as string[]) ?? []), join(directory, 'skills')])],
    },
  })
}

export const opencodeRuntimePlugin: AcpRuntimePlugin = {
  id: 'opencode',
  manifest: {
    id: 'opencode',
    name: 'OpenCode',
    description:
      '启动本机 opencode（acp）；复用 `opencode auth login` 写入 auth.json（~/.local/share/opencode/auth.json）的各 provider 凭证',
    authHint:
      '已登录（%LOCALAPPDATA%\\opencode\\auth.json 或 ~/.local/share/opencode/auth.json）则直接连接；否则先跑 opencode auth login',
    command: isWindowsPlatform() ? 'opencode.exe' : 'opencode',
    args: ['acp'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => probeOpencodeAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
    tryDirectSessionFirst: true,
  },
  resources: {
    capability: {
      entry: 'OPENCODE_CONFIG_CONTENT',
      strategy: 'native-overlay',
      configHome: 'OPENCODE_CONFIG_DIR',
    },
    supportedBridgeVersions: ['1.18.35'],
    prepareOverlay: async ({ directory, env, command }) => {
      const prep = prepareCompatibilityResources(directory, 'native-entry-not-verified')
      if (!command || !readAppRulesText(directory)) return prep
      try {
        const { stdout } = await promisify(execFile)(command, ['--version'], {
          env: env as NodeJS.ProcessEnv | undefined,
          timeout: 8000,
          windowsHide: true,
        })
        if (stdout.trim() !== '1.18.35') return prep
        const json = mergeOpenCodeAppConfig(env?.OPENCODE_CONFIG_CONTENT, directory)
        return {
          env: { OPENCODE_CONFIG_CONTENT: json },
          report: { ...prep.report, rulesPrepared: true, reason: undefined },
        }
      } catch {
        return { ...prep, report: { ...prep.report, reason: 'native-config-prepare-failed' } }
      }
    },
    sessionConfigLayout: {
      kind: 'opencode-xdg',
      includeConfigDirEnv: true,
      skillsShape: 'object',
      nativeRules: true,
    },
  },
  quota: {
    probeQuota: () => probeOpencodeQuota('opencode'),
  },
}
