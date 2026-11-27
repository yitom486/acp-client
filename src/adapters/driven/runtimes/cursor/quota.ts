import type { AcpAgentQuota } from '../../../../domain/contracts'

/**
 * Cursor CLI (`agent acp`) quota probe placeholder.
 *
 * Cursor CLI does not currently expose a documented public quota/usage endpoint.
 * Returning `null` preserves the `probeQuota` contract for future official
 * support without fabricating placeholder plan names or limits.
 */
export async function probeCursorQuota(): Promise<AcpAgentQuota | null> {
  return null
}
