export * from './quota'
export * from './codex-code-mode-home'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { CodexAuthPreflight, AcpAgentQuota } from "../../contracts"
import type { GenericRuntimeAdapter } from '../index'
import { digestAppResources, readAppResourcesDir, readAppRulesText } from '../../resources/app-resources'
import { mergeCodexConfigJson, mergeConfigTomlPreserving } from '../../resources/config-text'
import { probeCodexQuota } from './quota'
import {
  buildCustomProviderConfigToml,
  buildCustomProviderSpawnEnv,
  INKDOWN_PROVIDER_ID,
} from './codex-provider-home'
import { probeCodexAuth } from './codex-auth-preflight'
import {
  getAcpProviderCodexHome,
  readStoredAcpProvider,
  type StoredAcpProvider,
} from './codex-provider'

export * from './codex-auth-preflight'
export * from './codex-provider'
export * from './codex-provider-home'

export async function provisionCustomProviderCodexHome(
  provider: StoredAcpProvider,
  codexHome: string,
): Promise<boolean> {
  try {
    await mkdir(codexHome, { recursive: true })
    // 手术式合并而非整文件覆写：隔离目录可能已有用户规则
    // （如 developer_instructions），只替换本应用管理的供应商键。
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

export interface CodexRuntimeAdapter extends GenericRuntimeAdapter {
  probeQuota?: (options?: { sessionId?: string }) => Promise<AcpAgentQuota | null>
  id: 'codex-acp'
  probeAuth: () => CodexAuthPreflight
  getCustomProvider: () => Promise<{
    provider: StoredAcpProvider | null
    customEnv: NodeJS.ProcessEnv
    isCustom: boolean
  }>
}

export const codexAdapter: CodexRuntimeAdapter = {
  id: 'codex-acp',
  probeQuota: async (options?: { sessionId?: string }) => probeCodexQuota(options),
  /** 已核对的桥精确版本（codex-acp 2.2.2 实测；新主版本先回退，验证后放行） */
  supportedBridgeVersions: ['2.2.2'],
  /**
   * 应用资源预准备：读取宿主资源目录，合并 CODEX_CONFIG（保留用户配置），
   * 返回注入环境与加载报告。不写用户全局配置，不复制认证。
   */
  prepareAppResources: async ({ directory, workspaceRoot, env: overrideEnv }) => {
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
    const notApplied = (reason: string) => ({ report: {
      rulesApplied: false, rulesPrepared: false, skillsApplied: false,
      rulesChars: rulesText.length, profileDigest: digestAppResources(load), skillsFound, reason,
    } })
    if (!load.directoryReadable) return notApplied('invalid-resource-directory')
    if (env.CODEX_PATH) return notApplied('execution-not-verified')
    const codexHome = env.CODEX_HOME || join(homedir(), '.codex')
    try {
      await readFile(join(codexHome, 'config.toml'))
      // 暂无同一桥的有效配置查询入口，保留用户规则，不盲目覆盖。
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
        profileDigest: createHash('sha256').update(JSON.stringify([digestAppResources(load), codexHome, workspaceRoot, merged.json])).digest('hex'),
        skillsFound,
      },
    }
  },
  probeAuth: () => {
    return probeCodexAuth()
  },
  getCustomProvider: async () => {
    const provider = await readStoredAcpProvider()
    const codexHome = getAcpProviderCodexHome()
    const isCustom =
      provider !== null && (await provisionCustomProviderCodexHome(provider, codexHome))

    const customEnv =
      isCustom && provider
        ? buildCustomProviderSpawnEnv(provider, provider.apiKey, codexHome)
        : {}

    return {
      provider,
      customEnv,
      isCustom,
    }
  },
}
