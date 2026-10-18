/**
 * DeepSeek 账户与额度探针。
 *
 * ACP 没有 quota/账户概念，DSH 的 ACP 面也只发标准 `usage_update`
 * （上下文 token / 成本），不会带账户余额。这里补两条官方来源：
 *
 * 1. **平台账户**（`dsh` 网页登录，`x-dsh-auth-token` grant）：
 *    `GET {platform}/api/v0/users/get_user_summary` → 钱包余额；
 *    `GET {platform}/auth-api/v0/users/current` → 邮箱/昵称。
 *    凭据由 DSH 自己维护在 `$DSH_HOME/.credentials.yaml`，这里只读、不写、不记日志。
 * 2. **API Key 计费**（`DEEPSEEK_API_KEY`）：
 *    `GET {api}/user/balance`（公开文档接口）→ 法币余额与可用性。
 *
 * 边界：
 * - 平台 grant 有生命周期；过期返回 `unauthorized`，本 SDK 不会替它刷新。
 * - DeepSeek 没有公开的「速率窗口」查询接口，故不伪造 primary/secondary window。
 * - 任何失败都返回 null（或不带额度的 unauthorized），绝不抛异常打断连接。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpAccountInfo, AcpAgentQuota, AcpQuotaCredits } from '../../contracts/quota'

const DEFAULT_API_ORIGIN = 'https://api.deepseek.com'
const DEFAULT_PLATFORM_ORIGIN = 'https://platform.deepseek.com'
const BALANCE_PATH = '/user/balance'
const SUMMARY_PATH = '/api/v0/users/get_user_summary'
const PROFILE_PATH = '/auth-api/v0/users/current'
const CACHE_TTL_MS = 30_000
const TIMEOUT_MS = 1_800

type FetchLike = typeof fetch

interface PlatformGrant {
  token: string
  issuer?: string
}

interface BalanceInfo {
  currency?: unknown
  total_balance?: unknown
}

let cached: { key: string; at: number; quota: AcpAgentQuota } | null = null

/** 测试与手动刷新用：丢弃 30s 缓存。 */
export function resetDeepseekQuotaCache(): void {
  cached = null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 十进制字符串 → number；非十进制原样返回字符串；无法识别返回 undefined。 */
function decimal(value: unknown): number | string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : trimmed
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function upperCurrency(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : undefined
}

function unauthorizedQuota(message: string, now: number): AcpAgentQuota {
  return {
    runtimeId: 'deepseek',
    provider: 'DeepSeek',
    status: 'unauthorized',
    message,
    updatedAt: now,
  }
}

/**
 * 官方 `/user/balance` 响应 → `AcpAgentQuota`（API Key 计费口径）。
 * 多币种时优先 CNY；不伪造速率窗口。
 */
export function parseDeepseekBalance(payload: unknown, runtimeId = 'deepseek'): AcpAgentQuota | null {
  if (!isRecord(payload)) return null
  const infos = Array.isArray(payload.balance_infos)
    ? (payload.balance_infos.filter(isRecord) as BalanceInfo[])
    : []
  if (infos.length === 0) return null

  const pick = infos.find(info => upperCurrency(info.currency) === 'CNY') ?? infos[0]!
  const balance = decimal(pick.total_balance)
  if (balance === undefined) return null

  const currency = upperCurrency(pick.currency)
  const available = payload.is_available !== false && payload.is_available !== 'false'

  return {
    runtimeId,
    provider: 'DeepSeek',
    account: { plan: '按量计费 (Pay-as-you-go)', type: 'apiKey' },
    credits: { balance, ...(currency ? { currency } : {}) },
    status: available ? 'ok' : 'exhausted',
    ...(available ? {} : { message: 'DeepSeek 余额不可用 (is_available=false)' }),
    updatedAt: Date.now(),
  }
}

/** 平台 envelope：`{code:0,data:{biz_code:0,biz_data:...}}` → biz_data。 */
function businessData(payload: unknown): unknown {
  if (!isRecord(payload)) return undefined
  if (payload.code !== 0) return undefined
  const data = payload.data
  if (!isRecord(data) || data.biz_code !== 0) return undefined
  return data.biz_data
}

/** 钱包摘要 → credits（优先 CNY，其余币种不折叠）。 */
export function parsePlatformWallet(value: unknown): AcpQuotaCredits | undefined {
  if (!isRecord(value)) return undefined
  const wallets = Array.isArray(value.normal_wallets)
    ? value.normal_wallets.filter(isRecord)
    : []
  const pick = wallets.find(wallet => upperCurrency(wallet.currency) === 'CNY') ?? wallets[0]
  if (!pick) return undefined
  const balance = decimal(pick.balance)
  if (balance === undefined) return undefined
  const currency = upperCurrency(pick.currency)
  return { balance, ...(currency ? { currency } : {}) }
}

/** 平台用户资料 → 账户信息（邮箱/昵称）。 */
export function parsePlatformAccount(value: unknown): AcpAccountInfo | undefined {
  if (!isRecord(value)) return undefined
  const email = typeof value.email === 'string' && value.email.trim() ? value.email.trim() : undefined
  const identity = isRecord(value.id_profile) ? value.id_profile : undefined
  const name = identity && typeof identity.name === 'string' && identity.name.trim() ? identity.name.trim() : undefined
  if (!email && !name) return undefined
  return { email, name, plan: 'DeepSeek Account', type: 'account' }
}

/**
 * 解析 DSH 的 `.credentials.yaml`（仅取 account grant）。
 *
 * 文件由 harness 生成，结构固定：`records: → <name>: → kind/payload → token/issuer`。
 * 这里只做单遍扫描，不引入 YAML 依赖；任何异常都退化为空列表。
 */
export function parseDshCredentialGrants(text: string): PlatformGrant[] {
  const grants: PlatformGrant[] = []
  let inRecords = false
  let current: PlatformGrant | null = null
  const scalar = (raw: string): string => raw.trim().replace(/^['"]|['"]$/g, '')

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^records:\s*$/.test(rawLine)) {
      inRecords = true
      continue
    }
    if (!inRecords) continue
    if (/^\S/.test(rawLine)) {
      // 离开 records 段
      inRecords = false
      if (current?.token) grants.push(current)
      current = null
      continue
    }
    const recordStart = /^ {2}([^\s:][^:]*):\s*$/.exec(rawLine)
    if (recordStart) {
      if (current?.token) grants.push(current)
      current = { token: '' }
      continue
    }
    if (!current) continue
    const token = /^ {6}token:\s*(.+)$/.exec(rawLine)
    if (token) {
      current.token = scalar(token[1]!)
      continue
    }
    const issuer = /^ {6}issuer:\s*(.+)$/.exec(rawLine)
    if (issuer) {
      current.issuer = scalar(issuer[1]!)
    }
  }
  if (current?.token) grants.push(current)
  return grants.filter(grant => grant.token.length > 0)
}

function grantsFile(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return override
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

function pickPlatformGrant(grants: PlatformGrant[], platformOrigin: string): PlatformGrant | undefined {
  return grants.find(grant => grant.issuer?.startsWith(platformOrigin))
}

function resolveOrigin(raw: string | undefined, fallback: string, allowLoopbackHttp: boolean): string | null {
  try {
    const url = new URL(raw?.trim() || fallback)
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopback)) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

interface PlatformRead {
  status: number
  payload: unknown
}

async function platformGet(
  origin: string,
  path: string,
  token: string,
  doFetch: FetchLike,
  signal: AbortSignal,
): Promise<PlatformRead | null> {
  try {
    const res = await doFetch(`${origin}${path}`, {
      method: 'GET',
      headers: { 'x-dsh-auth-token': token, Accept: 'application/json' },
      signal,
    })
    if (res.status === 401 || res.status === 403) return { status: res.status, payload: null }
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    if (isRecord(payload) && payload.code === 40003) return { status: 401, payload: null }
    return { status: res.status, payload }
  } catch {
    return null
  }
}

async function probePlatformAccount(
  grant: PlatformGrant,
  platformOrigin: string,
  doFetch: FetchLike,
  now: () => number,
): Promise<AcpAgentQuota | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const [summary, profile] = await Promise.all([
      platformGet(platformOrigin, SUMMARY_PATH, grant.token, doFetch, controller.signal),
      platformGet(platformOrigin, PROFILE_PATH, grant.token, doFetch, controller.signal),
    ])
    if (!summary) return null
    if (summary.status === 401) {
      return unauthorizedQuota('DeepSeek 账户登录已过期，请在 DSH 中重新登录', now())
    }
    const credits = parsePlatformWallet(businessData(summary.payload))
    if (!credits) return null
    const account = profile ? parsePlatformAccount(businessData(profile.payload)) : undefined
    return {
      runtimeId: 'deepseek',
      provider: 'DeepSeek',
      ...(account ? { account } : { account: { plan: 'DeepSeek Account', type: 'account' } }),
      credits,
      status: 'ok',
      updatedAt: now(),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeApiKeyBalance(
  key: string,
  apiOrigin: string,
  doFetch: FetchLike,
  now: () => number,
): Promise<AcpAgentQuota | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch(`${apiOrigin}${BALANCE_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      return unauthorizedQuota('DEEPSEEK_API_KEY 无效或已失效 (401/403)', now())
    }
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    return parseDeepseekBalance(payload)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface DeepseekQuotaProbeOptions {
  /** 覆盖进程环境，便于测试与宿主注入。 */
  env?: NodeJS.ProcessEnv
  fetchImpl?: FetchLike
  now?: () => number
  /** 覆盖 DSH 凭据文件（测试用）；缺省 `$DSH_HOME/.credentials.yaml`。 */
  credentialsFile?: string
  /** 覆盖平台 origin（测试/私有部署用）。 */
  platformOrigin?: string
}

/**
 * 查询 DeepSeek 账户额度。
 *
 * 优先平台账户（余额 + 邮箱/昵称），其次 API Key（公开余额接口）。
 * 两者都没有时返回 null —— 界面继续显示“无额度数据”，而不是编造状态。
 */
export async function probeDeepseekQuota(
  options: DeepseekQuotaProbeOptions = {},
): Promise<AcpAgentQuota | null> {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const doFetch = options.fetchImpl ?? fetch

  const platformOrigin = resolveOrigin(
    options.platformOrigin || env.DSH_PLATFORM_ORIGIN,
    DEFAULT_PLATFORM_ORIGIN,
    false,
  )
  const apiOrigin = resolveOrigin(env.DEEPSEEK_BASE_URL, DEFAULT_API_ORIGIN, true)
  const key = env.DEEPSEEK_API_KEY?.trim()

  let grant: PlatformGrant | undefined
  if (platformOrigin) {
    try {
      const file = grantsFile(env, options.credentialsFile)
      if (existsSync(file)) {
        grant = pickPlatformGrant(parseDshCredentialGrants(readFileSync(file, 'utf8')), platformOrigin)
      }
    } catch {
      grant = undefined
    }
  }

  const cacheKey = grant ? `platform:${fingerprint(grant.token)}` : key ? `api:${fingerprint(key)}` : null
  if (cacheKey && cached && cached.key === cacheKey && now() - cached.at < CACHE_TTL_MS) {
    return cached.quota
  }

  let expired: AcpAgentQuota | null = null
  if (grant && platformOrigin) {
    const quota = await probePlatformAccount(grant, platformOrigin, doFetch, now)
    if (quota && quota.status !== 'unauthorized') {
      if (cacheKey) cached = { key: cacheKey, at: now(), quota }
      return quota
    }
    expired = quota
  }

  if (key && apiOrigin) {
    const quota = await probeApiKeyBalance(key, apiOrigin, doFetch, now)
    if (quota) {
      if (cacheKey && quota.status !== 'unauthorized') cached = { key: cacheKey, at: now(), quota }
      return quota
    }
  }

  return expired
}
