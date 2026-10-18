import type {
  AcpAgentQuota,
  AcpAccountInfo,
  AcpQuotaCredits,
  AcpQuotaLimitWindow,
  AcpQuotaStatus,
} from '../contracts/quota'

/**
 * 从文本输出（如 Codex /status 输出、Claude /cost、OpenCode status）中提取结构化配额
 */
export function parseRateLimitsFromStatusText(
  text: string,
  runtimeId = 'unknown',
): AcpAgentQuota | null {
  if (!text || typeof text !== 'string') return null

  const lines = text.split(/\r?\n/)
  let account: AcpAccountInfo | undefined
  const windows: AcpQuotaLimitWindow[] = []
  let credits: AcpQuotaCredits | undefined
  let status: AcpQuotaStatus = 'ok'
  let message: string | undefined

  if (/account (?:disabled|banned|suspended)|suspended|banned/i.test(text)) {
    status = 'banned'
    message = '账号已封禁或暂停使用 (Account banned / suspended)'
  } else if (/RESOURCE_EXHAUSTED|quota reached|rate limit exceeded|429/i.test(text)) {
    status = 'exhausted'
    message = '额度已用尽 (Quota / Rate limit reached)'
  } else if (/unauthorized|authentication failed|invalid api key/i.test(text)) {
    status = 'unauthorized'
    message = '认证失效 (Unauthorized / Invalid credentials)'
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\*\*/g, '').trim()
    if (!line) continue

    // Account: ChatGPT plus (user@example.com)
    const accMatch = line.match(/^Account\s*[:：]\s*([^()]+?)(?:\s*\(([^)]+)\))?$/i)
    if (accMatch) {
      account = {
        plan: accMatch[1].trim(),
        email: accMatch[2]?.trim(),
      }
      continue
    }

    // Credits: unlimited or number
    const credMatch = line.match(/(?:\b|^)(?:[\w\s-]*?credits?)\s*[:：]\s*(unlimited|[\d.]+)/i)
    if (credMatch) {
      const val = credMatch[1].trim()
      credits =
        val.toLowerCase() === 'unlimited'
          ? { unlimited: true, balance: 'unlimited' }
          : { balance: Number(val) || val, unlimited: false }
      continue
    }

    // Window line: e.g. "codex 5h limit: 99% left (resets 18:05)" or "5-hour limit: 80% remaining"
    const winMatch = line.match(
      /(?:(?:[\w-]+\s+)?([\w\s-]+?(?:limit|spend limit|window)))\s*[:：]\s*(\d+(?:\.\d+)?)%\s*(?:left|remaining)(?:\s*\((?:resets\s*(?:at\s*)?([^)]+)|([^)]+))\))?/i,
    )
    if (winMatch) {
      const label = winMatch[1].trim()
      const pct = parseFloat(winMatch[2])
      const resetsAt = (winMatch[3] || winMatch[4] || '').trim() || undefined
      let windowDurationMins: number | undefined
      const lower = label.toLowerCase()
      if (/5h|5-hour/i.test(lower)) windowDurationMins = 300
      else if (/week/i.test(lower)) windowDurationMins = 10080
      else if (/month/i.test(lower)) windowDurationMins = 43200
      else if (/day|24h/i.test(lower)) windowDurationMins = 1440
      else if (/(\d+)\s*h/i.test(lower)) {
        const m = lower.match(/(\d+)\s*h/)
        if (m) windowDurationMins = parseInt(m[1], 10) * 60
      }

      windows.push({
        label,
        percentLeft: pct,
        usedPercent: Math.max(0, 100 - pct),
        resetsAt,
        windowDurationMins,
      })
      continue
    }

    // Fast requests e.g. "Fast requests: 450/500 left"
    const fastMatch = line.match(/(?:fast requests?|requests?)\s*[:：]\s*(\d+)\s*\/\s*(\d+)/i)
    if (fastMatch) {
      const used = parseInt(fastMatch[1], 10)
      const total = parseInt(fastMatch[2], 10)
      const left = Math.max(0, total - used)
      const pct = total > 0 ? Math.round((left / total) * 100) : 0
      windows.push({
        label: 'Fast requests',
        percentLeft: pct,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        used,
        total,
      })
      continue
    }
  }

  if (!windows.length && !credits && !account && status === 'ok') {
    return null
  }

  const primary = windows.find((w) => /5h|5-hour|hour|primary|fast/i.test(w.label)) || windows[0]
  const secondary =
    windows.find((w) => w !== primary && /week|month|secondary/i.test(w.label)) ||
    windows.find((w) => w !== primary)
  const extraWindows = windows.filter((w) => w !== primary && w !== secondary)

  if (primary && primary.percentLeft <= 10 && status === 'ok') {
    status = 'warning'
  }

  return {
    runtimeId,
    account,
    primaryWindow: primary,
    secondaryWindow: secondary,
    extraWindows: extraWindows.length ? extraWindows : undefined,
    credits,
    status,
    message,
    rawText: text,
    updatedAt: Date.now(),
  }
}

/**
 * 缓存每个会话和运行时的配额状态
 */
export class QuotaCache {
  private bySession = new Map<string, AcpAgentQuota>()
  private byRuntime = new Map<string, AcpAgentQuota>()
  /** ACP `usage_update` 的上下文占用（token 用量），与余额探针分账存放 */
  private usageBySession = new Map<string, { used: number; size: number; updatedAt: number }>()
  private usageByRuntime = new Map<string, { used: number; size: number; updatedAt: number }>()

  observe(params: unknown, defaultRuntimeId = 'unknown'): AcpAgentQuota | null {
    if (!params || typeof params !== 'object') return null
    const p = params as {
      sessionId?: unknown
      update?: {
        sessionUpdate?: unknown
        used?: unknown
        size?: unknown
        content?: { type?: unknown; text?: unknown }
        message?: { content?: Array<{ type?: unknown; text?: unknown }> }
      }
    }
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined

    // ACP `usage_update`：dsh 等 agent 报的上下文占用（used/size），不是账户余额。
    if (p.update?.sessionUpdate === 'usage_update') {
      const used = Number(p.update.used)
      const size = Number(p.update.size)
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
        const usage = { used, size, updatedAt: Date.now() }
        if (sessionId) this.usageBySession.set(sessionId, usage)
        this.usageByRuntime.set(defaultRuntimeId, usage)
      }
      return null
    }

    let textToParse = ''
    if (p.update?.content && p.update.content.type === 'text' && typeof p.update.content.text === 'string') {
      textToParse = p.update.content.text
    } else if (p.update?.message?.content && Array.isArray(p.update.message.content)) {
      textToParse = p.update.message.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
    }

    if (!textToParse) return null

    // 只对可能包含配额关键词的文本进行快速过滤
    if (!/(?:limit|credits?|Account:|5h|resets|banned|suspended|quota)/i.test(textToParse)) {
      return null
    }

    const quota = parseRateLimitsFromStatusText(textToParse, defaultRuntimeId)
    if (quota) {
      if (sessionId) this.bySession.set(sessionId, quota)
      this.byRuntime.set(defaultRuntimeId, quota)
      return quota
    }
    return null
  }

  set(quota: AcpAgentQuota, sessionId?: string): void {
    if (sessionId) this.bySession.set(sessionId, quota)
    this.byRuntime.set(quota.runtimeId, quota)
  }

  get(sessionId?: string, runtimeId?: string): AcpAgentQuota | undefined {
    if (sessionId && this.bySession.has(sessionId)) {
      return this.bySession.get(sessionId)
    }
    if (runtimeId && this.byRuntime.has(runtimeId)) {
      return this.byRuntime.get(runtimeId)
    }
    return undefined
  }

  /**
   * 把 `usage_update` 的上下文占用并入配额对象（读取时合并，不覆盖余额）：
   * 有余额时作为 `extraWindows` 的 `Context` 窗口；没有余额但有用量时，
   * 单独给出一个以 Context 为主窗口的配额，避免 UI 一片空白。
   */
  applyContextUsage(
    quota: AcpAgentQuota | null | undefined,
    sessionId?: string,
    runtimeId = 'unknown',
  ): AcpAgentQuota | null {
    const usage =
      (sessionId ? this.usageBySession.get(sessionId) : undefined) ?? this.usageByRuntime.get(runtimeId)
    if (!usage) return quota ?? null
    const usedPercent =
      usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0
    const window: AcpQuotaLimitWindow = {
      label: 'Context',
      used: usage.used,
      total: usage.size,
      usedPercent,
      percentLeft: Math.max(0, 100 - usedPercent),
    }
    if (!quota) {
      return { runtimeId, primaryWindow: window, status: 'ok', updatedAt: usage.updatedAt }
    }
    const rest = (quota.extraWindows ?? []).filter((item) => item.label !== 'Context')
    return { ...quota, extraWindows: [window, ...rest] }
  }

  clear(): void {
    this.bySession.clear()
    this.byRuntime.clear()
    this.usageBySession.clear()
    this.usageByRuntime.clear()
  }
}
