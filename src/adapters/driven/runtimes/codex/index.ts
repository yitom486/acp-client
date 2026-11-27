import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CODEX_ACP_NPM_PACKAGE,
  DEFAULT_ACP_RUNTIME_ID,
} from '../../../../domain/contracts'
import { mergeCodexConfigJson, mergeConfigTomlPreserving } from '../../../../domain/transport/config-text'
import type { AcpRuntimePlugin } from '../../../../ports'
import { digestAppResources, readAppResourcesDir, readAppRulesText } from '../../resources/app-resources'
import { probeCodexAuth } from './codex-auth-preflight'
import {
  getAcpProviderCodexHome,
  readStoredAcpProvider,
  type StoredAcpProvider,
} from './codex-provider'
import {
  buildCustomProviderConfigToml,
  buildCustomProviderSpawnEnv,
  INKDOWN_PROVIDER_ID,
} from './codex-provider-home'
import { probeCodexQuota } from './quota'

export * from './quota'
export * from './codex-code-mode-home'
export * from './codex-auth-preflight'
export * from './codex-provider'
export * from './codex-provider-home'

export async function provisionCustomProviderCodexHome(
  provider: StoredAcpProvider,
  codexHome: string,
): Promise<boolean> {
  try {
    await mkdir(codexHome, { recursive: true })
    let existing: string | null = null
    try {
      existing = await readFile(join(codexHome, 'config.toml'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(
      join(codexHome, 'config.toml'),
      mergeConfigTomlPreserving({
        existingText: existing,
        managedTopKeys: ['model', 'model_provider'],
        managedTables: [`model_providers.${INKDOWN_PROVIDER_ID}`],
        replacementBlock: buildCustomProviderConfigToml(provider),
      }),
      'utf8',
    )
    return true
  } catch (error) {
    console.error('[acp] 自定义供应商 config.toml 写入失败，回落本机登录', error)
    return false
  }
}

export const codexRuntimePlugin: AcpRuntimePlugin = {
  id: DEFAULT_ACP_RUNTIME_ID,
  manifest: {
    id: DEFAULT_ACP_RUNTIME_ID,
    name: 'ChatGPT',
    description:
      '通过 bunx 启动官方 @agentclientprotocol/codex-acp；可复用本机 ~/.codex（ChatGPT / API Key）',
    authHint:
      '复用本机 ~/.codex 登录（auth.json 或 OPENAI_API_KEY / CODEX_API_KEY）；未登录按下方 Agent 认证方式完成登录',
    command: 'bunx',
    args: ['-y', `${CODEX_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  auth: {
    probeAuth: () => probeCodexAuth(),
  },
  resources: {
    capability: { entry: 'CODEX_CONFIG', strategy: 'native-overlay', configHome: 'CODEX_HOME' },
    supportedBridgeVersions: ['2.2.2'],
    sessionConfigLayout: {
      kind: 'simple-config',
      rulesFileName: 'AGENTS.md',
      nativeRules: true,
      buildEnv: ({ configDir }) => ({ CODEX_HOME: configDir }),
    },
    prepareOverlay: async ({ directory, workspaceRoot, env: overrideEnv }) => {
      const load = readAppResourcesDir(directory)
      const skillsFound = load.skills.map((s) => s.name)
      const rulesText = readAppRulesText(directory)
      if (!rulesText) {
        return {
          report: {
            rulesApplied: false,
            rulesChars: 0,
            profileDigest: null,
            skillsFound,
            reason: 'rules-missing',
          },
        }
      }
      const env = { ...process.env, ...overrideEnv }
      const notApplied = (reason: string) => ({
        report: {
          rulesApplied: false,
          rulesPrepared: false,
          skillsApplied: false,
          rulesChars: rulesText.length,
          profileDigest: digestAppResources(load),
          skillsFound,
          reason,
        },
      })
      if (!load.directoryReadable) return notApplied('invalid-resource-directory')
      if (env.CODEX_PATH) return notApplied('execution-not-verified')
      const codexHome = env.CODEX_HOME || join(homedir(), '.codex')
      try {
        await readFile(join(codexHome, 'config.toml'))
        return notApplied('effective-config-not-verified')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return notApplied('effective-config-not-verified')
      }
      for (let dir = workspaceRoot; dir; ) {
        if (existsSync(join(dir, '.codex', 'config.toml'))) return notApplied('effective-config-not-verified')
        if (existsSync(join(dir, '.git'))) break
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      const merged = mergeCodexConfigJson({ existingRaw: env['CODEX_CONFIG'], hostBlock: rulesText })
      if (!merged.ok) {
        return {
          report: {
            rulesApplied: false,
            rulesChars: rulesText.length,
            profileDigest: digestAppResources(load),
            skillsFound,
            reason: merged.reason === 'invalid-json' ? 'invalid-codex-config' : 'conflicting-codex-config',
          },
        }
      }
      return {
        env: { CODEX_CONFIG: merged.json },
        report: {
          rulesApplied: false,
          rulesPrepared: true,
          skillsApplied: false,
          rulesChars: rulesText.length,
          profileDigest: createHash('sha256')
            .update(JSON.stringify([digestAppResources(load), codexHome, workspaceRoot, merged.json]))
            .digest('hex'),
          skillsFound,
        },
      }
    },
  },
  quota: {
    probeQuota: (options) => probeCodexQuota(options),
  },
  getCustomProvider: async () => {
    const provider = await readStoredAcpProvider()
    const codexHome = getAcpProviderCodexHome()
    const isCustom = provider !== null && (await provisionCustomProviderCodexHome(provider, codexHome))
    const customEnv = isCustom && provider ? buildCustomProviderSpawnEnv(provider, provider.apiKey, codexHome) : {}
    return { provider, customEnv, isCustom }
  },
}
