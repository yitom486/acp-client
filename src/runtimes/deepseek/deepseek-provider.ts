import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AcpDeepseekProviderSavePayload,
  AcpDeepseekProviderStatus,
  AppError,
} from "../../contracts"
import { err, ok, type Result } from "../../contracts"
import { getDefaultAgentDataDir } from '../../client/acp-paths'

/**
 * DeepSeek（dsh）端点与凭证的本地落库。
 *
 * 存在的意义：用户本机没有登录 harness、也没有 `DEEPSEEK_API_KEY` 时，
 * 宿主可以弹一个「URL + Token」表单，填完即可连接——不必要求用户先去装/登
 * harness 桌面端。落库只保存我们自己的 JSON，不碰 `$DSH_HOME/.credentials.yaml`；
 * spawn 时再转成 harness 官方认的环境变量（`DEEPSEEK_BASE_URL` /
 * `DEEPSEEK_API_KEY`，见 dsh-llm-deepseek 的 BASE_URL_ENV 与 credentials 优先级）。
 *
 * 优先级（高 → 低）：
 * 1. 调用方显式传入的 `env`（AcpClient options.env）——CI/多租户场景用；
 * 2. 本表单落库（本文件）；
 * 3. 进程环境里的同名变量；
 * 4. harness 自身登录（`$DSH_HOME/.credentials.yaml`）。
 */

/** 官方端点：harness 走 Anthropic 兼容的 Messages API，路径必须带 `/anthropic`。 */
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com/anthropic'

/** harness 家目录：`DSH_HOME` 优先，缺省 `~/.dsh`（与 dsh 自身口径一致）。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME?.trim()
  return override || join(homedir(), '.dsh')
}

export function resolveDshCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), '.credentials.yaml')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从 harness 凭证库的 `refs:` 块读某个名字的明文值（如 `DEEPSEEK_API_KEY`）。
 * 只认顶层 `refs:` 下的缩进行，读到下一个顶层键即停；读不到返回 null。
 * 用于配额探针：用户只登录了 harness、没导出环境变量时也能查余额。
 */
export function readHarnessCredential(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const text = readFileSync(resolveDshCredentialsFile(env), 'utf8')
    const pattern = new RegExp(`^\\s+${escapeRegExp(name)}\\s*:\\s*(.+)$`)
    let inRefs = false
    for (const line of text.split(/\r?\n/)) {
      if (/^refs\s*:/.test(line)) {
        inRefs = true
        continue
      }
      if (!inRefs) continue
      if (/^\S/.test(line)) break
      const match = pattern.exec(line)
      if (match) {
        const value = match[1].trim().replace(/^['"]|['"]$/g, '')
        return value || null
      }
    }
    return null
  } catch {
    return null
  }
}

/** 用户手填官方域名（无路径）时也接受：补成 Anthropic 兼容端点。 */
export function normalizeDeepseekBaseUrl(raw?: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return DEEPSEEK_OFFICIAL_BASE_URL
  const withoutSlash = trimmed.replace(/\/+$/, '')
  try {
    const url = new URL(withoutSlash)
    if (url.host.toLowerCase() === 'api.deepseek.com' && (url.pathname === '' || url.pathname === '/')) {
      return DEEPSEEK_OFFICIAL_BASE_URL
    }
    return withoutSlash
  } catch {
    return withoutSlash
  }
}

export interface StoredDeepseekProvider {
  baseUrl: string
  apiKey: string
}

function providerFilePath(dir: string): string {
  return join(dir, 'agent', 'deepseek-provider.json')
}

/** 读取完整配置（含 Key），仅内部使用；文件缺失/损坏返回 null。 */
export function readStoredDeepseekProvider(
  dir: string = getDefaultAgentDataDir(),
): StoredDeepseekProvider | null {
  const file = providerFilePath(dir)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredDeepseekProvider>
    if (typeof raw.baseUrl !== 'string' || typeof raw.apiKey !== 'string' || !raw.apiKey.trim()) {
      return null
    }
    return { baseUrl: normalizeDeepseekBaseUrl(raw.baseUrl), apiKey: raw.apiKey }
  } catch {
    return null
  }
}

/** 供 UI 的脱敏状态（Key 不回传）。 */
export function getDeepseekProviderStatus(
  dir: string = getDefaultAgentDataDir(),
): AcpDeepseekProviderStatus {
  const stored = readStoredDeepseekProvider(dir)
  if (!stored) return { configured: false, isOfficial: true, hasApiKey: false }
  return {
    configured: true,
    baseUrl: stored.baseUrl,
    isOfficial: stored.baseUrl === DEEPSEEK_OFFICIAL_BASE_URL,
    hasApiKey: Boolean(stored.apiKey),
  }
}

function validateBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'URL 必须是 http(s) 地址'
    if (!url.hostname) return 'URL 缺少主机名'
    return null
  } catch {
    return 'URL 不是合法地址'
  }
}

/**
 * 保存表单：`baseUrl` 留空回落官方端点；`apiKey` 留空保留原 Key
 * （只切端点、不重填 Token 的常见操作）。
 */
export function saveDeepseekProvider(
  payload: AcpDeepseekProviderSavePayload,
  dir: string = getDefaultAgentDataDir(),
): Result<AcpDeepseekProviderStatus, AppError> {
  const baseUrl = normalizeDeepseekBaseUrl(payload.baseUrl)
  const invalid = validateBaseUrl(baseUrl)
  if (invalid) return err({ code: 'INVALID_ARGUMENT', message: invalid })
  const apiKey = payload.apiKey?.trim() || readStoredDeepseekProvider(dir)?.apiKey || ''
  if (!apiKey) return err({ code: 'INVALID_ARGUMENT', message: 'Token/API Key 不能为空' })
  const file = providerFilePath(dir)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ baseUrl, apiKey }, null, 2), 'utf8')
  } catch (error) {
    return err({
      code: 'FILE_WRITE_ERROR',
      message: error instanceof Error ? error.message : '写入 DeepSeek 配置失败',
    })
  }
  return ok(getDeepseekProviderStatus(dir))
}

export function clearDeepseekProvider(
  dir: string = getDefaultAgentDataDir(),
): Result<void, AppError> {
  try {
    rmSync(providerFilePath(dir), { force: true })
    return ok(undefined)
  } catch (error) {
    return err({
      code: 'FILE_WRITE_ERROR',
      message: error instanceof Error ? error.message : '删除 DeepSeek 配置失败',
    })
  }
}

/**
 * 落库配置 → spawn 环境变量。
 * `currentEnv` 已有的同名键不覆盖（显式调用方环境优先）。
 * 返回空对象表示没有可注入的配置。
 */
export function buildDeepseekProviderEnv(
  stored: StoredDeepseekProvider | null,
  currentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!stored) return {}
  const env: NodeJS.ProcessEnv = {}
  if (!currentEnv.DEEPSEEK_BASE_URL?.trim()) env.DEEPSEEK_BASE_URL = stored.baseUrl
  if (!currentEnv.DEEPSEEK_API_KEY?.trim()) env.DEEPSEEK_API_KEY = stored.apiKey
  return env
}
