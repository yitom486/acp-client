/**
 * SDK 自动兼容引导（compat/user-context 通道）：
 * 无安全原生入口时，SDK 在必要会话首轮自动附带本块，不逐轮重复。
 *
 * - 内容与宿主资源同源（规则正文 + 技能目录），SDK 不编写业务提示词；
 * - 明确记为 compatibility/user-context，不宣称 system/developer 优先级；
 * - 稳定标记供宿主回放清洗与诊断；SDK 转发通知原文，不改写不剥离。
 */

export const COMPAT_CONTEXT_TAG = 'acp-compat-context'

export interface CompatSkillEntry {
  name: string
  description: string
}

export interface CompatGuideInput {
  /** 同源规则正文（缺席则只带技能指引） */
  rulesText: string | null
  /** 同源技能目录（名称+描述，不含正文） */
  skills: CompatSkillEntry[]
  /** 技能正文是否可经 MCP 读取（决定指引写法，不虚构可用性） */
  skillsViaMcp: boolean
  /** 本次交付快照摘要（短哈希） */
  digest: string | null
  sessionId: string
  /** 连接代次（重连/恢复后重新附带一次的诊断依据） */
  generation: number
}

function shortDigest(digest: string | null): string {
  return digest ? digest.slice(0, 16) : 'none'
}

/**
 * 构建兼容引导块。纯函数；调用方保证同一次交付使用同一快照
 * （正文与摘要同读，不混用两次读取期间变化的内容）。
 */
export function buildCompatGuideText(input: CompatGuideInput): string | null {
  const hasRules = (input.rulesText ?? '').trim() !== ''
  const hasSkills = input.skills.length > 0
  if (!hasRules && !hasSkills) return null

  const lines: string[] = []
  lines.push(
    `<${COMPAT_CONTEXT_TAG} mode="compatibility" profile="${shortDigest(input.digest)}" session="${input.sessionId}" gen="${input.generation}">`,
    'NOTE FOR THE MODEL: the block below is host-provided context delivered over the user channel',
    '(compatibility mode). It is NOT a system or developer instruction and does not override them.',
    '',
  )
  if (hasRules) {
    lines.push('--- host rules (same source as the host app, delivered once per session) ---', '')
    lines.push((input.rulesText as string).trim(), '')
  }
  if (hasSkills) {
    lines.push('--- host skills catalog (names and descriptions only; read full text on demand) ---', '')
    for (const skill of input.skills) {
      lines.push(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`)
    }
    lines.push(
      '',
      input.skillsViaMcp
        ? 'Read a skill body with the app_read_skill MCP tool before claiming its content.'
        : 'Skill bodies are available on request; ask the host if no skill tool is listed.',
    )
    lines.push('')
  }
  lines.push(`</${COMPAT_CONTEXT_TAG}>`)
  return lines.join('\n')
}

/** 附带记账键：会话 + 连接代次 + 资源摘要；三者任一变化即新交付（有界）。 */
export function compatDeliveryKey(sessionId: string, generation: number, digest: string | null): string {
  return `${generation}:${sessionId}:${digest ?? 'none'}`
}
