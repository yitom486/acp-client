import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * DeepSeek（dsh）ACP 的可迁移引导层。
 *
 * 目标：换一台机器只靠「装依赖 + 登录」就能跑通，不依赖任何本机手工改动。
 *
 * 两个会阻断迁移的点，都在这里解决：
 * 1. `dsh-acp-app` 自带补丁把会话默认模型写死成 `deepseek-v4-flash`，而该 id
 *    不在 provider catalog 里（catalog 只有 `deepseek-flash` = V4.1-Flash 与
 *    `deepseek-v4-pro`）。以前靠改 `$DSH_HOME/profiles/acp/cordis.patch.yml`，
 *    换机即失效；这里改为在 spawn 时用启动器自带的 `--patch <file>` 覆盖层，
 *    补丁文件由 SDK 写到系统临时目录，随代码走、不碰用户 profile。
 * 2. bunx 把包装进临时目录，harness 的 `$DSH_HOME/profiles/node_modules` 会软链
 *    过去，临时目录被清理后 profile 断链。这里约定一个按平台取的用户级稳定
 *    安装目录（`scripts/setup-dsh-acp.mjs` 负责装进去），存在即优先使用，
 *    于是同一份代码在 Windows / macOS / Linux 上都能自解析到稳定入口。
 */

/** 与桌面端对齐的默认 dsh 版本；`DSH_RUNTIME_VERSION` 可覆盖。 */
export const DSH_ACP_PINNED_VERSION = '0.2.1-rc.2'

/** V4.1-Flash 在官方 provider catalog 中的 id（1017 只是桌面端 UI 徽标）。 */
export const DSH_ACP_DEFAULT_MODEL = 'deepseek-flash'

/** 默认 provider；account 路线可用 `DSH_PROVIDER=deepseek-account`。 */
export const DSH_ACP_DEFAULT_PROVIDER = 'deepseek-official'

/**
 * 用户级稳定安装根目录（跨平台）：
 * - Windows：`%LOCALAPPDATA%\acp-dsh`
 * - macOS：`~/Library/Application Support/acp-dsh`
 * - Linux/其它：`$XDG_DATA_HOME/acp-dsh`（缺省 `~/.local/share/acp-dsh`）
 * `DSH_RUNTIME_DIR` 可整体覆盖（便携安装、CI 或测试用）。
 */
export function resolveDshRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_RUNTIME_DIR?.trim()
  if (override) return override
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'acp-dsh')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'acp-dsh')
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'acp-dsh')
}

/** 稳定安装内 dsh 入口的绝对路径。 */
export function resolveManagedDshEntry(
  env: NodeJS.ProcessEnv = process.env,
  version: string = resolveManagedDshVersion(env),
): string {
  return join(
    resolveDshRuntimeRoot(env),
    version,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
}

function parseVersion(value: string): { nums: number[]; pre: string[] } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return null
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * 版本比较（够用的 semver 语义）：数字段逐个比；同号时正式版 > 预发布版；
 * 预发布段按数字/字典序。用于「用户装了多个版本时自动取最高」。
 */
export function compareDshVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return a.localeCompare(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i]
  }
  if (left.pre.length === 0 && right.pre.length > 0) return 1
  if (left.pre.length > 0 && right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && nx !== ny) return nx - ny
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function hasManagedEntry(root: string, version: string): boolean {
  return existsSync(
    join(root, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  )
}

/**
 * 实际使用的稳定安装版本：
 * 1. `DSH_RUNTIME_VERSION` 显式指定；
 * 2. 否则扫描运行时根目录，取**已装版本里最高的一个**——用户用
 *    `setup-dsh-acp.mjs --version X` 升上去后，acp-client 无需改代码即可自动跟上；
 * 3. 一个都没有时回落到内置 pin（此时 `hasManagedDshRuntime` 为 false，走 bunx）。
 */
export function resolveManagedDshVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.DSH_RUNTIME_VERSION?.trim()
  if (explicit) return explicit
  const root = resolveDshRuntimeRoot(env)
  let best: string | null = null
  try {
    for (const name of readdirSync(root)) {
      if (!parseVersion(name)) continue
      if (!hasManagedEntry(root, name)) continue
      if (best === null || compareDshVersions(name, best) > 0) best = name
    }
  } catch {
    // 根目录不存在：没有稳定安装
  }
  return best ?? DSH_ACP_PINNED_VERSION
}

/** 稳定安装是否已就位；命中即可免 bunx 冷启动。 */
export function hasManagedDshRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveManagedDshEntry(env))
}

/** YAML 标量只接受安全 id；非法值回落缺省，绝不把用户输入拼进 YAML。 */
function safeId(raw: string | undefined, fallback: string): string {
  const value = raw?.trim()
  return value && /^[A-Za-z0-9._-]+$/.test(value) ? value : fallback
}

export interface AcpModelOverride {
  provider: string
  model: string
}

/**
 * 模型覆盖意图：`DSH_ACP_MODEL_PATCH=off|0|false|none` 关闭；
 * `DSH_PROVIDER` / `DSH_MODEL` 可改目标（默认 deepseek-official / deepseek-flash）。
 */
export function resolveAcpModelOverride(
  env: NodeJS.ProcessEnv = process.env,
): AcpModelOverride | null {
  const flag = env.DSH_ACP_MODEL_PATCH?.trim().toLowerCase()
  if (flag === 'off' || flag === '0' || flag === 'false' || flag === 'none') return null
  return {
    provider: safeId(env.DSH_PROVIDER, DSH_ACP_DEFAULT_PROVIDER),
    model: safeId(env.DSH_MODEL, DSH_ACP_DEFAULT_MODEL),
  }
}

/** 生成启动器 `--patch` 用的覆盖层（与 profile 的 cordis.patch.yml 同格式）。 */
export function buildAcpModelPatch(override: AcpModelOverride): string {
  return [
    '# 由 @yitom/acp-client 生成：修正 ACP 会话默认模型。',
    '# dsh-acp-app 自带补丁把 model 写死为 deepseek-v4-flash，该 id 不在 provider catalog 中；',
    '# V4.1-Flash 的 catalog id 是 deepseek-flash（桌面端 1017 只是 UI 徽标）。',
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${override.provider}`,
    `    model: ${override.model}`,
    '',
  ].join('\n')
}

const patchFileCache = new Map<string, string | null>()

/**
 * 把模型覆盖层写到系统临时目录并返回路径；写失败返回 null（spawn 不带 --patch）。
 * 按 provider/model 缓存，重复 connect 不重复写盘。
 */
export function ensureAcpModelPatchFile(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = resolveAcpModelOverride(env)
  if (!override) return null
  const key = `${override.provider}/${override.model}`
  const cached = patchFileCache.get(key)
  if (cached !== undefined) return cached
  try {
    const dir = join(tmpdir(), 'acp-dsh-runtime')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `acp-model-${override.provider}--${override.model}.patch.yml`)
    const body = buildAcpModelPatch(override)
    // 内容不同才写，避免多进程同时启动时的无谓写放大。
    if (!existsSync(file) || readFileSync(file, 'utf8') !== body) {
      writeFileSync(file, body, 'utf8')
    }
    patchFileCache.set(key, file)
    return file
  } catch {
    patchFileCache.set(key, null)
    return null
  }
}

/** 测试/长驻进程切换环境时清缓存。 */
export function resetAcpModelPatchCache(): void {
  patchFileCache.clear()
}
