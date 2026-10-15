/**
 * 运行时原生资格与桥版本门（通用策略，封装在 SDK 内）：
 * 仅验证过的运行时可候选原生加载；未知版本、版本越界一律回退，
 * 不靠 model 名称或 runtime.id 单独判定成功。
 *
 * 注意：白名单记录的是已验证的桥精确版本，不是“永远兼容”承诺；
 * 新精确版本出现时先回退，验证后随 SDK 更新放行。
 */

/** 已核对原生配置接口的运行时与桥版本；模型遵从需要单独实测 */
export const NATIVE_ELIGIBLE_BRIDGE_VERSIONS: Record<string, string[]> = {
  'codex-acp': ['2.2.2'],
  opencode: ['1.18.35'],
  claude: ['0.91.0'],
  agy: ['0.1.24', '0.1.25', '0.1.26'],
}

export type NativeCompatReason =
  | 'runtime-not-verified'
  | 'unknown-bridge-version'
  | 'unsupported-bridge-version'

export interface NativeEligibility {
  eligible: boolean
  reason?: NativeCompatReason
}

/** 运行时原生资格：仅白名单内可候选，其余（含将来新增）全部兼容回退。 */
export function resolveRuntimeEligibility(runtimeId: string): NativeEligibility {
  const id = (runtimeId ?? '').trim()
  if (!id || !(id in NATIVE_ELIGIBLE_BRIDGE_VERSIONS)) {
    return { eligible: false, reason: 'runtime-not-verified' }
  }
  return { eligible: true }
}

/** 桥版本门：空/不可解析 → 未知回退；精确版本命中白名单才放行。 */
export function isSupportedBridgeVersion(runtimeId: string, version?: string): NativeEligibility {
  const versions = NATIVE_ELIGIBLE_BRIDGE_VERSIONS[(runtimeId ?? '').trim()]
  if (!versions) return { eligible: false, reason: 'runtime-not-verified' }
  const normalized = version?.trim().replace(/^v/, '')
  if (!normalized) return { eligible: false, reason: 'unknown-bridge-version' }
  if (!versions.includes(normalized)) return { eligible: false, reason: 'unsupported-bridge-version' }
  return { eligible: true }
}
