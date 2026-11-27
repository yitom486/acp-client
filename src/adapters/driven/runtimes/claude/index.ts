import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_ACP_NPM_PACKAGE, type AcpAuthMethod, type AcpAuthPreflight } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { readAppRulesText } from '../../resources/app-resources'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { probeClaudeQuota } from './quota'

export * from './quota'

export function resolveClaudeHome(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.claude')
}

export function probeClaudeAuth(): AcpAuthPreflight {
  const claudeHome = resolveClaudeHome()
  const hasHomeDir = existsSync(claudeHome)
  const hasAuthFile =
    existsSync(join(homedir(), '.claude.json')) ||
    existsSync(join(claudeHome, '.credentials.json'))
  const hasApiKeyEnv = Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
  )

  return {
    homeDir: claudeHome,
    hasHomeDir,
    hasAuthFile,
    hasApiKeyEnv,
    looksLoggedIn: hasAuthFile || hasApiKeyEnv,
  }
}

export function claudeResourceSessionMeta(directory: string): Record<string, unknown> | undefined {
  const text = readAppRulesText(directory)
  if (!text) return undefined
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: text },
    claudeCode: { options: { plugins: [{ type: 'local', path: directory }] } },
  }
}

export const claudeRuntimePlugin: AcpRuntimePlugin = {
  id: 'claude',
  manifest: {
    id: 'claude',
    name: 'Claude',
    description:
      '通过 bunx 启动官方 @agentclientprotocol/claude-agent-acp；可复用本机 Claude Code 登录态（~/.claude.json）或 ANTHROPIC_API_KEY',
    authHint:
      '复用本机 Claude Code 登录（~/.claude.json / ~/.claude/.credentials.json 或 ANTHROPIC_API_KEY）；未登录先跑 claude login',
    command: 'bunx',
    args: ['-y', `${CLAUDE_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: ['ANTHROPIC_API_KEY'],
  },
  auth: {
    probeAuth: () => probeClaudeAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
  },
  resources: {
    capability: {
      entry: '_meta.systemPrompt + _meta.claudeCode.options.plugins',
      strategy: 'native-session',
      configHome: 'CLAUDE_CONFIG_DIR',
    },
    supportedBridgeVersions: ['0.91.0'],
    prepareOverlay: async ({ directory }) => {
      const prep = prepareCompatibilityResources(directory, 'native-session-version-not-verified')
      return { ...prep, report: { ...prep.report, rulesPrepared: !!readAppRulesText(directory) } }
    },
    sessionMeta: claudeResourceSessionMeta,
    sessionConfigLayout: {
      kind: 'simple-config',
      rulesFileName: 'CLAUDE.md',
      nativeRules: true,
      buildEnv: ({ configDir }) => ({ CLAUDE_CONFIG_DIR: configDir }),
    },
  },
  quota: {
    probeQuota: (options) => probeClaudeQuota(options),
  },
}
