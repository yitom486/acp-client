/**
 * Agent 额度与速率限制契约 (Agent Quota & Rate Limits Contract)
 *
 * 跨 Agent 通用抽象：
 * - primaryWindow: 核心短期限制（如 Codex / Claude / OpenCode 5小时限额）
 * - secondaryWindow: 周期限制（如 每周限额 / 每月限额）
 * - credits: 账户余额 / 积分
 * - extraWindows: 额外限制（如 单个请求上限 / 日调用上限 / 模型专属上限）
 */

export interface AcpQuotaLimitWindow {
  /** 限制窗口标识或名称，如 '5h limit', 'Weekly limit', 'Monthly limit' */
  label: string
  /** 分组标识，如 'Gemini Models', 'Claude and GPT models' */
  group?: string
  /** 剩余百分比 (0 - 100) */
  percentLeft: number
  /** 已用百分比 (0 - 100) */
  usedPercent?: number
  /** 已用绝对量 (例如已用 token、金额或请求次数) */
  used?: number | string
  /** 总额度 (例如总 token、限值) */
  total?: number | string
  /** 窗口时长（分钟），例如 5h = 300, 7d = 10080 */
  windowDurationMins?: number
  /** 重置时间提示，如 '18:05', '10月20日 13:05' 或 ISO 时间串 */
  resetsAt?: string | number
}

export interface AcpQuotaCredits {
  /** 余额数值或字符串，例如 126.19 或 'unlimited' */
  balance?: number | string
  /** 货币单位，如 USD, CNY, CREDITS */
  currency?: string
  /** 是否无限制 */
  unlimited?: boolean
}

export interface AcpAccountInfo {
  name?: string
  email?: string
  plan?: string // 如 'ChatGPT Plus', 'ChatGPT Team', 'Claude Pro', 'OpenCode Free'
  type?: string // 如 'apiKey', 'chatgpt', 'oauth'
}

export type AcpQuotaStatus =
  | 'ok'
  | 'warning'
  | 'exhausted'
  | 'banned'
  | 'unauthorized'
  | 'unknown'

export interface AcpAgentQuota {
  runtimeId: string
  provider?: string
  account?: AcpAccountInfo
  /** 核心短期窗口，如 5 小时限额 */
  primaryWindow?: AcpQuotaLimitWindow
  /** 周期窗口，如 每周限额 / 每月限额 */
  secondaryWindow?: AcpQuotaLimitWindow
  /** 账户积分 / 余额 */
  credits?: AcpQuotaCredits
  /** 其他窗口（如模型专属调用上限） */
  extraWindows?: AcpQuotaLimitWindow[]
  /** 账户/额度整体状态 */
  status?: AcpQuotaStatus
  /** 人类可读说明或异常警告（例如 'Account banned', '429 Too Many Requests'） */
  message?: string
  /** 原始文本（若由 /status 或 CLI 文本解析而来） */
  rawText?: string
  /** 更新时间戳 (ms) */
  updatedAt: number
}
