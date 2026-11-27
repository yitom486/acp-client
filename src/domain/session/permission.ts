import type { AcpPermissionOutcome } from '../contracts'

function permissionOptionId(option: Record<string, unknown>): string | null {
  if (typeof option.optionId === 'string') return option.optionId
  if (typeof option.id === 'string') return option.id
  return null
}

function permissionOptions(params: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(params.options)
    ? params.options.filter(
        (option): option is Record<string, unknown> => !!option && typeof option === 'object',
      )
    : []
}

/** Accept cancellation or a selection explicitly advertised for this request. */
export function isAcpPermissionOutcome(
  outcome: unknown,
  params: Record<string, unknown>,
): outcome is AcpPermissionOutcome {
  if (!outcome || typeof outcome !== 'object') return false
  const value = outcome as Record<string, unknown>
  if (value.outcome === 'cancelled') return true
  return (
    value.outcome === 'selected' &&
    typeof value.optionId === 'string' &&
    value.optionId.length > 0 &&
    permissionOptions(params).some((option) => permissionOptionId(option) === value.optionId)
  )
}

/** Find an allow option after user approval, preferring a one-time grant. */
export function pickAllowOptionId(params: Record<string, unknown>): string | null {
  const options = permissionOptions(params)
  for (const kind of ['allow_once', 'allow', 'allow_always']) {
    const option = options.find((entry) => entry.kind === kind && permissionOptionId(entry))
    if (option) return permissionOptionId(option)
  }
  return null
}
