import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpAuthMethod, AcpAuthPreflight } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { isWindowsPlatform } from '../_shared/platform'

export function resolveCopilotHome(): string {
  const fromEnv = process.env.COPILOT_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.copilot')
}

function hasCopilotLogin(home: string): boolean {
  try {
    const raw = readFileSync(join(home, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw) as { loggedInUsers?: unknown }
    return Array.isArray(parsed.loggedInUsers) && parsed.loggedInUsers.length > 0
  } catch {
    return false
  }
}

export function probeCopilotAuth(): AcpAuthPreflight {
  const copilotHome = resolveCopilotHome()
  const hasHomeDir = existsSync(copilotHome)
  const hasAuthFile = hasCopilotLogin(copilotHome)
  const hasApiKeyEnv = Boolean(
    process.env.COPILOT_GITHUB_TOKEN?.trim() ||
      process.env.GH_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim(),
  )

  return {
    homeDir: copilotHome,
    hasHomeDir,
    hasAuthFile,
    hasApiKeyEnv,
    looksLoggedIn: hasAuthFile || hasApiKeyEnv,
  }
}

export const copilotRuntimePlugin: AcpRuntimePlugin = {
  id: 'copilot',
  manifest: {
    id: 'copilot',
    name: 'Copilot',
    description: '启动本机 Copilot CLI（--acp --stdio）；复用 Copilot CLI 的 GitHub 登录态',
    authHint:
      '复用本机 Copilot CLI 的 GitHub 登录（~/.copilot/config.json 或 COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN）；未登录先跑 copilot login',
    command: isWindowsPlatform() ? 'copilot.cmd' : 'copilot',
    args: ['--acp', '--stdio'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => probeCopilotAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
  },
  resources: {
    capability: {
      entry: null,
      strategy: 'compatibility',
      configHome: 'COPILOT_HOME',
      candidateEntry: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
    },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'native-entry-not-verified'),
    sessionConfigLayout: {
      kind: 'simple-config',
      rulesFileName: 'copilot-instructions.md',
      extraRulesFileNames: ['AGENTS.md'],
      nativeRules: true,
      buildEnv: ({ configDir, skillsDir }) => ({
        COPILOT_HOME: configDir,
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: configDir,
        COPILOT_SKILLS_DIRS: skillsDir,
      }),
    },
  },
}
