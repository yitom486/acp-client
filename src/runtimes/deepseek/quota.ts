import type { AcpAgentQuota } from '../../contracts/quota'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  readHarnessCredential,
  readStoredDeepseekProvider,
} from './deepseek-provider'

/**
 * DeepSeek 账户余额探针。
 *
 * ACP 协议本身**没有**余额接口（只有 `usage_update` 的上下文用量事件，见
 * `QuotaCache`），所以余额走 DeepSeek 官方 `GET /user/balance`（Bearer API Key）。
 * 这与 harness 无关：用户既可以通过 URL+Token 表单、环境变量，也可以只登录
 * harness（凭证库 `refs.DEEPSEEK_API_KEY`）——三者都能查到同一份余额。
 *
 * 余额接口挂在 API 根上，不在 harness 的 `/anthropic` 兼容端点下，所以这里会把
 * 配置的 base URL 归一化掉 `/anthropic` 后缀。
 */
export interface DeepseekQuotaOptions {
  runtimeId?: string
  env?: NodeJS.ProcessEnv
  dataDir?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 4000

/** 解析可用于查余额的 Key：显式 env > 表单落库 > harness 凭证库。 */
export function resolveDeepseekQuotaKey(options: DeepseekQuotaOptions = {}): string | null {
  const env = options.env ?? process.env
  const envKey = env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return envKey
  if (options.dataDir) {
    const stored = readStoredDeepseekProvider(options.dataDir)
    if (stored?.apiKey) return stored.apiKey
  }
  return readHarnessCredential('DEEPSEEK_API_KEY', env)
}

/** 余额接口的 API 根（去掉 harness 的 `/anthropic` 兼容路径）。 */
export function resolveDeepseekApiBase(options: DeepseekQuotaOptions = {}): string {
  const env = options.env ?? process.env
  const raw =
    env.DEEPSEEK_BASE_URL?.trim() ||
    (options.dataDir ? readStoredDeepseekProvider(options.dataDir)?.baseUrl : undefined) ||
    DEEPSEEK_OFFICIAL_BASE_URL
  const trimmed = raw.replace(/\/+$/, '').replace(/\/anthropic$/i, '')
  return trimmed || 'https://api.deepseek.com'
}

interface DeepseekBalanceInfo {
  currency?: string
  total_balance?: string
  granted_balance?: string
  topped_up_balance?: string
}

interface DeepseekBalanceResponse {
  is_available?: boolean
  balance_infos?: DeepseekBalanceInfo[]
}

function unauthorized(runtimeId: string, message: string): AcpAgentQuota {
  return { runtimeId, provider: 'DeepSeek', status: 'unauthorized', message, updatedAt: Date.now() }
}

export async function probeDeepseekQuota(
  options: DeepseekQuotaOptions = {},
): Promise<AcpAgentQuota | null> {
  const runtimeId = options.runtimeId ?? 'deepseek'
  const apiKey = resolveDeepseekQuotaKey(options)
  if (!apiKey) {
    return unauthorized(
      runtimeId,
      '未配置 DEEPSEEK_API_KEY / 表单 Token，无法查询余额',
    )
  }

  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(`${resolveDeepseekApiBase(options)}/user/balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      return unauthorized(runtimeId, `余额查询被拒绝 (HTTP ${response.status})`)
    }
    if (!response.ok) return null

    const data = (await response.json()) as DeepseekBalanceResponse
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
    const first = infos[0]
    const total = first ? Number(first.total_balance) : Number.NaN
    const credits = first
      ? {
          balance: Number.isFinite(total) ? total : (first.total_balance ?? '0'),
          currency: first.currency,
        }
      : undefined
    const balanceText = infos
      .map((info) => `${info.total_balance ?? '0'} ${info.currency ?? ''}`.trim())
      .join(' / ')

    return {
      runtimeId,
      provider: 'DeepSeek',
      account: { type: 'apiKey', plan: 'DeepSeek API' },
      credits,
      status: data.is_available === false ? 'exhausted' : 'ok',
      message:
        data.is_available === false
          ? '账户余额不足，API 暂不可用'
          : `可用余额 ${balanceText || '未知'}`,
      rawText: JSON.stringify(data),
      updatedAt: Date.now(),
    }
  } catch {
    // 网络失败/超时：交给调用方沿用缓存，不谎报额度
    return null
  }
}
