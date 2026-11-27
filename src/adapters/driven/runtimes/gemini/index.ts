import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpAuthMethod, AcpAuthPreflight } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { isWindowsPlatform } from '../_shared/platform'

export function resolveGeminiHome(): string {
  return join(homedir(), '.gemini')
}

export function probeGeminiAuth(): AcpAuthPreflight {
  const geminiHome = resolveGeminiHome()
  const hasHomeDir = existsSync(geminiHome)
  const hasAuthFile =
    existsSync(join(geminiHome, 'oauth_creds.json')) ||
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim())
  const hasApiKeyEnv = Boolean(
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
  )

  return {
    homeDir: geminiHome,
    hasHomeDir,
    hasAuthFile,
    hasApiKeyEnv,
    looksLoggedIn: hasAuthFile || hasApiKeyEnv,
  }
}

export const geminiRuntimePlugin: AcpRuntimePlugin = {
  id: 'gemini',
  manifest: {
    id: 'gemini',
    name: 'Gemini',
    description: '启动本机 Gemini CLI（--acp）；复用 Gemini CLI 登录态（~/.gemini/）',
    authHint:
      '复用本机 Gemini CLI 登录（~/.gemini/oauth_creds.json 或 GEMINI_API_KEY / GOOGLE_API_KEY）；未登录先在本机终端跑 gemini 完成登录',
    command: isWindowsPlatform() ? 'gemini.cmd' : 'gemini',
    args: ['--acp'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => probeGeminiAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
  },
  resources: {
    capability: { entry: null, strategy: 'compatibility', configHome: 'GEMINI_CLI_HOME' },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'config-home-would-isolate-auth'),
    sessionConfigLayout: {
      kind: 'nested-home',
      homeSubdir: 'home',
      configSubdir: '.gemini',
      rulesFileName: 'GEMINI.md',
      nativeRules: true,
      buildEnv: ({ homeDir }) => ({ GEMINI_CLI_HOME: homeDir }),
    },
  },
}
