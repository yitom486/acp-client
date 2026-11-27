import type { AcpAgentQuota } from '../../../../domain/contracts'

/**
 * Antigravity CLI (`agy acp`) quota probe placeholder.
 *
 * Neither standard ACP v1 nor Google's official `agy acp` CLI currently exposes
 * a documented public quota/usage endpoint. Returning `null` preserves the
 * `probeQuota` contract for future official ACP quota support while allowing
 * `QuotaCache` to capture official `RESOURCE_EXHAUSTED` signals passively.
 */
export async function probeAntigravityCliQuota(_options?: {
  sessionId?: string
  runtimeId?: string
}): Promise<AcpAgentQuota | null> {
  return null
}
