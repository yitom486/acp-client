import { existsSync, readFileSync } from 'node:fs'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import type { AcpAuthMethod, CodexAuthPreflight } from "../../contracts"
import { DEEPSEEK_DSH_NPM_PACKAGE } from "../../contracts"
import type { GenericRuntimeAdapter } from '../index'
import { resolveDshCredentialsFile } from './deepseek-provider'
import {
  ensureAcpModelPatchFile,
  hasManagedDshRuntime,
  resolveManagedDshEntry,
} from './dsh-acp-bootstrap'
import {
  buildDeepseekProviderEnv,
  readStoredDeepseekProvider,
  resolveDshHome,
} from './deepseek-provider'
import { probeDeepseekQuota } from './quota'

export * from './dsh-acp-bootstrap'
export * from './deepseek-provider'
export * from './quota'

/**
 * DeepSeek 运行时适配器（`dsh --profile acp`）。
 *
 * 启动目标按优先级：
 * 1. `DSH_BIN`：显式 dsh 入口（`.js` 走当前 node，其余按可执行文件）；
 * 2. 用户级稳定安装（`scripts/setup-dsh-acp.mjs` 装到 `resolveDshRuntimeRoot()`，
 *    命中即用当前 node 直跑，见 `dsh-acp-bootstrap.ts`）；
 * 3. `DSH_PACKAGE`：npm 包定位符覆盖（如 pin `@deepseek-ai/dsh@0.2.1-rc.2`）；
 * 4. 缺省 `bunx -y @deepseek-ai/dsh@latest --profile acp`。
 *
 * 不依赖本机手工改动：dsh 的 ACP 应用把默认模型写死成不存在的
 * `deepseek-v4-flash`，这里统一追加启动器自带的 `--patch <临时文件>` 覆盖层
 * （`DSH_ACP_MODEL_PATCH=off` 可关；`DSH_PROVIDER` / `DSH_MODEL` 可改目标）。
 * 换机后只需「装依赖 + 登录（或导出 DEEPSEEK_API_KEY）」即可复现，不需要改
 * `$DSH_HOME/profiles/acp/cordis.patch.yml`。
 *
 * 用稳定安装的原因：bunx 把包装进临时目录，harness 的
 * `$DSH_HOME/profiles/node_modules` 会把这些包软链到该临时目录；临时目录被系统
 * 清理后 profile 立刻断链（实测 `bunx-<id>@deepseek-ai/dsh@latest` 已消失）。
 *
 * 凭证：harness 自身凭证（`DEEPSEEK_API_KEY` 或 `$DSH_HOME/.credentials.yaml`
 * 里的登录记录，全部留在官方位置，我方不存）。harness 的 ACP `authMethods`
 * 为空，连接门闩天然走 `skip_auth`；此处探测仅供诊断与预检。
 *
 * 缺凭证预检（仿 cursor `resolveSpawnCommand` 为 null 即拦的 precedent）：
 * 本机既无 key 也无 harness 登录记录时 harness 极可能直接退出（stdio 关闭→
 * 传输层报 connection closed），故经 `resolveSpawnBlocker` 在 spawn 前判停，
 * 回带中文动作指引。只认文档明确的变量：`DEEPSEEK_API_KEY`（预检）、
 * `DSH_HOME`（凭证库位置）、`DSH_PACKAGE` / `DSH_BIN` / `DSH_RUNTIME_DIR`
 * （启动目标覆盖）。
 *
 * 上游坏包逃生（实锤：dsh 0.1.5-rc.2 内依赖 `…-documentpreview@^0.1.5-rc.3`，
 * 而该包最高仅 0.1.6-alpha.1，上游缺 rc.3，自解析依赖失败退出）：
 * 设 `DSH_PACKAGE` pin 旧版（如 `@deepseek-ai/dsh@0.1.4`）即可绕过。
 *
 * 模型口径：ACP `session/new` 的 model 选项值是 `["provider","model"]` 的 JSON
 * 串；官方 catalog 里 V4.1-Flash 的 id 是 `deepseek-flash`（桌面端 1017 徽标
 * 只是 UI 标签，不是模型版本）。ACP 应用自带的补丁把默认模型写成了
 * `deepseek-v4-flash`，需要 profile 层覆盖，见 docs/api-reference.md。
 */
export function buildDeepseekMissingKeyMessage(): string {
  return '未检测到 DEEPSEEK_API_KEY，也未在 harness 凭证库中找到登录记录：请先在终端导出该变量，或先在该 harness（dsh）里完成登录后再连接'
}

/** harness 家目录：`DSH_HOME` 优先，缺省 `~/.dsh`（与 dsh 自身口径一致）。 */
export { resolveDshCredentialsFile, resolveDshHome } from './deepseek-provider'

/**
 * harness 凭证库是否至少有一条记录。
 * `records:` 为空集合或缺文件即视为未登录；只有记录块内的缩进行才算数，
 * 遇到下一个顶层键立即停止，避免把别的顶层字段误判成凭证。
 */
export function hasDshCredentials(env?: NodeJS.ProcessEnv): boolean {
  try {
    const text = readFileSync(resolveDshCredentialsFile(env), 'utf8')
    const match = /^records\s*:(.*)$/m.exec(text)
    if (!match) return false
    if (/^\s*(\[\]|\{\}|null|~)\s*$/.test(match[1])) return false
    for (const line of text.slice(match.index + match[0].length).split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue
      if (/^\s+\S/.test(line)) return true
      return false
    }
    return false
  } catch {
    return false
  }
}

/**
 * 预检判停：显式 env 有 key、宿主表单已落库、或 harness 自己已登录，三者其一即放行。
 * `dataDir` 用于读 URL+Token 表单落库；不传则只看 env 与 harness 凭证库。
 */
export function resolveDeepseekSpawnBlocker(
  env?: NodeJS.ProcessEnv,
  dataDir?: string,
): string | null {
  const source = env ?? process.env
  if (source.DEEPSEEK_API_KEY?.trim()) return null
  if (dataDir && readStoredDeepseekProvider(dataDir)) return null
  if (hasDshCredentials(source)) return null
  return buildDeepseekMissingKeyMessage()
}

/**
 * 包定位符覆盖（`DSH_PACKAGE`，缺省 `@deepseek-ai/dsh`，沿 contracts 常量口径）：
 * 最小校验——非空、无空白、无 shell 元字符（`;&|$()` 等），非法回落缺省并 dev warn。
 * 经 `resolveSpawnCommand` 风格返回 spawn 目标覆盖（precedent 照抄 cursor）。
 */
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

/** shell 元字符与控制字符（路径允许空格，故不拦空白）。 */
const UNSAFE_BIN = /[\u0000-\u001f;&|$()`"'<>*?~#!]/

/** 稳定安装的 dsh 入口覆盖（`DSH_BIN`）；非法值回落 null 走包解析。 */
export function resolveDeepseekBin(env?: NodeJS.ProcessEnv): string | null {
  const raw = (env ?? process.env).DSH_BIN?.trim()
  if (!raw) return null
  if (UNSAFE_BIN.test(raw)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[acp:deepseek] 非法 DSH_BIN 回落包解析: ${raw}`)
    }
    return null
  }
  return raw
}

export function resolveDeepseekSpawnCommand(env?: NodeJS.ProcessEnv): {
  command: string
  args: string[]
} {
  const source = env ?? process.env
  // 模型覆盖层随代码走（写系统临时目录），不依赖本机 profile 手工改动。
  const patchFile = ensureAcpModelPatchFile(source)
  const withPatch = (args: string[]): string[] =>
    patchFile ? [...args, '--patch', patchFile] : args

  const bin = resolveDeepseekBin(source)
  if (bin) {
    const args = ['--profile', 'acp']
    // JS 入口直接用当前 node：路径含空格也无需 shell，跨平台一致。
    if (/\.(c|m)?js$/i.test(bin)) return { command: process.execPath, args: withPatch([bin, ...args]) }
    const looksAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(bin)
    // .cmd/.bat 依赖 cmd 解析，路径含空格会被截断；回落包解析避免更难懂的失败。
    if (/\.(cmd|bat)$/i.test(bin) && /\s/.test(bin)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[acp:deepseek] DSH_BIN 为含空格的批处理，回落包解析: ${bin}`)
      }
    } else if (!looksAbsolute || existsSync(bin)) {
      return { command: bin, args: withPatch(args) }
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(`[acp:deepseek] DSH_BIN 不存在，回落包解析: ${bin}`)
    }
  }

  // 用户级稳定安装（scripts/setup-dsh-acp.mjs 装到这里）优先于 bunx 临时目录，
  // 换机后只要跑过初始化脚本即可免网络冷启动，profile 软链也不会指向会被清理的目录。
  if (hasManagedDshRuntime(source)) {
    const entry = resolveManagedDshEntry(source)
    return { command: process.execPath, args: withPatch([entry, '--profile', 'acp']) }
  }

  const pkg = resolveDeepseekPackage(source)
  // 缺省包跟模板一样带 @latest（每次冷启动直取 registry 最新）；用户覆盖值原样使用
  const spec = pkg === DEEPSEEK_DSH_NPM_PACKAGE ? `${pkg}@latest` : pkg
  return { command: 'bunx', args: withPatch(['-y', spec, '--profile', 'acp']) }
}

export function probeDeepseekAuth(
  env?: NodeJS.ProcessEnv,
  dataDir?: string,
): CodexAuthPreflight {
  const source = env ?? process.env
  const hasApiKeyEnv = Boolean(source.DEEPSEEK_API_KEY?.trim())
  const dshHome = resolveDshHome(source)
  const hasCredentialsFile = existsSync(resolveDshCredentialsFile(source))
  const hasCredentialRecords = hasDshCredentials(source)
  // 宿主表单落库等同于“已配好凭证”，UI 不该再催登录。
  const hasStoredProvider = Boolean(dataDir && readStoredDeepseekProvider(dataDir))

  return {
    codexHome: dshHome,
    hasCodexHome: existsSync(dshHome),
    hasAuthFile: hasCredentialsFile,
    hasApiKeyEnv: hasApiKeyEnv || hasStoredProvider,
    looksLoggedIn: hasApiKeyEnv || hasStoredProvider || hasCredentialRecords,
  }
}

export const deepseekAdapter: GenericRuntimeAdapter = {
  id: 'deepseek',
  prepareAppResources: async ({directory}) => prepareCompatibilityResources(directory, 'native-config-entry-not-verified'),
  probeAuth: (context) => probeDeepseekAuth(context?.env, context?.dataDir),
  resolveSpawnCommand: () => resolveDeepseekSpawnCommand(),
  resolveSpawnBlocker: (context) => resolveDeepseekSpawnBlocker(context?.env, context?.dataDir),
  // URL+Token 表单落库 → DEEPSEEK_BASE_URL / DEEPSEEK_API_KEY；显式 env 优先，只补空缺。
  getProviderEnv: ({ dataDir, env }) =>
    buildDeepseekProviderEnv(readStoredDeepseekProvider(dataDir), env),
  // 余额：DeepSeek 官方 /user/balance（ACP 无此能力，只有 usage_update 上下文用量）
  probeQuota: (options) =>
    probeDeepseekQuota({
      runtimeId: 'deepseek',
      dataDir: options?.dataDir,
      env: options?.env,
    }),
  orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
  canSkipInteractiveAuth: () => false,
}
