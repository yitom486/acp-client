import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEEPSEEK_DSH_NPM_PACKAGE,
  type AcpAuthMethod,
  type AcpAuthPreflight,
} from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { probeDeepseekQuota } from './quota'

export * from './quota'

export function buildDeepseekMissingKeyMessage(): string {
  return '未检测到 DEEPSEEK_API_KEY，也未找到 DSH 本地登录（~/.dsh/.credentials.yaml）：请先在终端导出该变量，或先完成 DeepSeek Harness 自身登录后再连接'
}

export function resolveDeepseekHarnessHome(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env
  const configured = source.DSH_HOME?.trim()
  return configured || join(homedir(), '.dsh')
}

export function hasDeepseekHarnessCredentials(env?: NodeJS.ProcessEnv): boolean {
  const file = join(resolveDeepseekHarnessHome(env), '.credentials.yaml')
  try {
    return existsSync(file) && statSync(file).size > 0
  } catch {
    return false
  }
}

export function resolveDeepseekSpawnBlocker(env?: NodeJS.ProcessEnv): string | null {
  const source = env ?? process.env
  if (source.DEEPSEEK_API_KEY?.trim()) return null
  if (hasDeepseekHarnessCredentials(source)) return null
  return buildDeepseekMissingKeyMessage()
}

export function resolveDeepseekPackage(env?: NodeJS.ProcessEnv): string {
  const source = env ?? process.env
  const raw = source.DSH_PACKAGE?.trim()
  if (!raw) return DEEPSEEK_DSH_NPM_PACKAGE
  if (/[\s;&|$()`"'\\<>*?~#!]/.test(raw)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[acp:deepseek] 非法 DSH_PACKAGE 回落缺省: ${raw}`)
    }
    return DEEPSEEK_DSH_NPM_PACKAGE
  }
  return raw
}

export function resolveDeepseekSpawnCommand(env?: NodeJS.ProcessEnv): {
  command: string
  args: string[]
} {
  const pkg = resolveDeepseekPackage(env)
  const spec = pkg === DEEPSEEK_DSH_NPM_PACKAGE ? `${pkg}@latest` : pkg
  return { command: 'bunx', args: ['-y', spec, '--profile', 'acp'] }
}

export function probeDeepseekAuth(): AcpAuthPreflight {
  const hasApiKeyEnv = Boolean(process.env.DEEPSEEK_API_KEY?.trim())
  const harnessHome = resolveDeepseekHarnessHome()
  const hasAuthFile = hasDeepseekHarnessCredentials()

  return {
    homeDir: harnessHome,
    hasHomeDir: existsSync(harnessHome),
    hasAuthFile,
    hasApiKeyEnv,
    looksLoggedIn: hasApiKeyEnv || hasAuthFile,
  }
}

export const deepseekRuntimePlugin: AcpRuntimePlugin = {
  id: 'deepseek',
  manifest: {
    id: 'deepseek',
    name: 'DeepSeek',
    description:
      '通过 bunx 启动 @deepseek-ai/dsh（--profile acp）；无 ACP 登录，靠 harness 自身凭证（DEEPSEEK_API_KEY / harness 配置）；模型经 session 到达，无需额外动作',
    authHint:
      '无 ACP 登录，靠 harness 自身凭证（DEEPSEEK_API_KEY / harness 配置）；未配置先导出 DEEPSEEK_API_KEY；模型经 session 到达，无需额外动作；若官方最新 dsh 存在坏依赖（如 rc.3 缺失），可设 DSH_PACKAGE pin 旧版',
    command: 'bunx',
    args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
    requiredEnvKeys: ['DEEPSEEK_API_KEY'],
  },
  auth: {
    probeAuth: () => probeDeepseekAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
  },
  spawn: {
    resolveCommand: () => resolveDeepseekSpawnCommand(),
    resolveBlocker: () => resolveDeepseekSpawnBlocker(),
  },
  resources: {
    capability: { entry: null, strategy: 'compatibility', configHome: null },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'native-config-entry-not-verified'),
  },
  quota: {
    probeQuota: () => probeDeepseekQuota(),
  },
}
