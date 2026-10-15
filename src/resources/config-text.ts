/**
 * 宿主配置文本合并（通用算法，不含宿主品牌与业务内容）：
 * - CODEX_CONFIG JSON 合并：保留全部已有键，已有 developer_instructions
 *   （字符串）予以保留并接在宿主规则块之后；无效 JSON / 冲突类型明确失败，
 *   不静默覆盖。
 * - config.toml 手术合并（无 TOML 解析依赖）：保留调用方未知内容，
 *   只替换指定的顶层键与整节表。
 */

export type ConfigMergeFailure =
  | 'invalid-json'
  | 'conflicting-value'
  | 'empty-block'

export type ConfigMergeResult =
  | { ok: true; json: string; preservedUserInstructions: boolean }
  | { ok: false; reason: ConfigMergeFailure }

/**
 * 合并 CODEX_CONFIG：宿主规则块在前、用户已有 developer_instructions 在后
 * （与既往每轮前缀在用户消息之前的生效顺序一致）。
 */
export function mergeCodexConfigJson(input: {
  existingRaw?: string
  hostBlock: string
}): ConfigMergeResult {
  const block = (input.hostBlock ?? '').trim()
  if (!block) return { ok: false, reason: 'empty-block' }
  const raw = (input.existingRaw ?? '').trim()
  if (!raw) {
    return { ok: true, json: JSON.stringify({ developer_instructions: block }), preservedUserInstructions: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' }
  }
  const merged = { ...(parsed as Record<string, unknown>) }
  const existing = merged['developer_instructions']
  if (existing === undefined) {
    merged['developer_instructions'] = block
    return { ok: true, json: JSON.stringify(merged), preservedUserInstructions: false }
  }
  if (typeof existing !== 'string') {
    return { ok: false, reason: 'conflicting-value' }
  }
  const kept = existing.trim()
  merged['developer_instructions'] = kept ? `${block}\n\n${kept}` : block
  return { ok: true, json: JSON.stringify(merged), preservedUserInstructions: kept !== '' }
}

/**
 * config.toml 手术合并：保留未知文本（注释、空行、其他表），只替换
 * managedTopKeys 指定的顶层键与 managedTables 指定的整节。
 * 行级状态机，无需 TOML 解析器；未知形状宁可保留原文，不猜测改写。
 */
export function mergeConfigTomlPreserving(input: {
  existingText: string | null
  managedTopKeys: string[]
  managedTables: string[]
  replacementBlock: string
}): string {
  const block = (input.replacementBlock ?? '').trim() ? `${input.replacementBlock.trim()}\n` : ''
  if (!input.existingText || !input.existingText.trim()) return block
  // 没有 TOML 解析器时，复杂结构保留原文，不能猜测表头或多行字符串。
  if (/"""|'''/.test(input.existingText) || /^\s*\[.*["'].*\]|^\s*\[\[|^\s*["'](?:model|model_provider)["']\s*=/m.test(input.existingText)) {
    throw new Error('复杂 TOML 配置需要结构化合并，已保留原文件')
  }
  const topKeys = new Set(input.managedTopKeys)
  const tables = new Set(input.managedTables)
  const out: string[] = []
  let inManagedTable = false
  let inAnyTable = false
  for (const line of input.existingText.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1]?.trim() ?? null
    if (header !== null) {
      inAnyTable = true
      inManagedTable = tables.has(header)
      if (!inManagedTable) out.push(line)
      continue
    }
    if (inManagedTable) continue
    if (!inAnyTable) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
      if (key && topKeys.has(key)) continue
    }
    out.push(line)
  }
  const kept = out.join('\n').trim()
  if (!kept) return block
  const tableAt = block.search(/^\s*\[/m)
  if (tableAt < 0) return block + '\n' + kept + '\n'
  // 顶层 replacement 键必须位于用户第一张表之前。
  return block.slice(0, tableAt).trimEnd() + '\n\n' + kept + '\n\n' + block.slice(tableAt)
}
