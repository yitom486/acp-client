import type { AcpAgentQuota } from '../../../../domain/contracts'

/**
 * Antigravity (`agy acp` / `agy`) quota probe placeholder.
 *
 * Neither standard ACP v1 nor Google's official `agy acp` CLI currently exposes
 * a documented public quota/usage endpoint. We intentionally do NOT inspect
 * Antigravity IDE logs/process command lines, extract internal CSRF tokens, call
 * undocumented local RPC endpoints, or fabricate placeholder 100% limits.
 *
 * Returning `null` preserves the `probeQuota` contract for future official ACP
 * quota support while allowing `AcpClient`'s passive `QuotaCache` to continue
 * surfacing official `RESOURCE_EXHAUSTED` / rate-limit signals from session updates.
 */
export async function probeAgyQuota(_options?: {
  sessionId?: string
  runtimeId?: string
}): Promise<AcpAgentQuota | null> {
  return null
}
