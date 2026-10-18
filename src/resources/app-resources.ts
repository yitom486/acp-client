import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * 应用资源目录契约（单目录接口的宿主侧输入）：
 *
 * <directory>/
 *   AGENTS.md                  宿主常驻规则（主动读取，不等待模型找文件）
 *   skills/<name>/SKILL.md     按需加载的技能（发现与正文分别记录）
 *
 * 本模块只做读取、校验与摘要，不解释业务语义，不依赖 Electron，
 * 不包含任何宿主品牌、工具名称或 UI 逻辑。
 */

export const APP_RULES_FILE = 'AGENTS.md'
export const APP_SKILLS_DIR = 'skills'
export const APP_SKILL_FILE = 'SKILL.md'

export interface AppDiscoveredSkill {
  /** 技能名（frontmatter 无 name 时取目录名） */
  name: string
  /** frontmatter description（缺席为空字符串，非正文） */
  description: string
  /** 相对目录的 SKILL.md 路径（`skills/<name>/SKILL.md`） */
  path: string
  /** 正文字符数（脱敏统计用，不含正文） */
  chars: number
  /** 正文 sha256（变更检测用；含名称与描述，任一变化即变） */
  digest: string
}

/**
 * 最小 frontmatter 解析（无依赖）：首行 `---` 起至下一个 `---` 行，
 * `key: value` 按首个冒号切分，仅取 name/description，值去首尾引号。
 * 形状非法一律回退空对象，不抛错。
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const out: { name?: string; description?: string } = {}
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    const key = line.slice(0, cut).trim().toLowerCase()
    if (key !== 'name' && key !== 'description') continue
    const value = line.slice(cut + 1).trim().replace(/^['"]|['"]$/g, '')
    if (value) out[key] = value
  }
  return out
}

export interface AppResourceLoad {
  /** 目录本身可读 */
  directoryReadable: boolean
  /** 常驻规则：缺席为 null（调用方明确回退，不静默） */
  rules: { chars: number; digest: string } | null
  /** 发现到的技能（仅目录 + SKILL.md  both present 才算发现） */
  skills: AppDiscoveredSkill[]
  /** 非致命问题（缺文件、不可读项），供诊断记录 */
  warnings: string[]
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function readTextFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

/**
 * 读取并校验应用资源目录。纯同步 fs，只抛错于调用方无法处理的场景之外——
 * 本函数不抛错：目录不可读/文件缺席一律体现在返回值中，由调用方裁决回退。
 */
export function readAppResourcesDir(directory: string): AppResourceLoad {
  const warnings: string[] = []
  if (!isAbsolute(directory)) return { directoryReadable: false, rules: null, skills: [], warnings: ['资源目录必须是本机绝对路径'] }
  let directoryReadable = false
  try {
    directoryReadable = statSync(directory).isDirectory()
  } catch {
    directoryReadable = false
  }
  if (!directoryReadable) {
    return { directoryReadable: false, rules: null, skills: [], warnings: [`资源目录不可读: ${directory}`] }
  }

  let rules: AppResourceLoad['rules'] = null
  const rulesText = readTextFile(join(directory, APP_RULES_FILE))
  if (rulesText === null) {
    warnings.push(`缺常驻规则: ${APP_RULES_FILE}`)
  } else {
    rules = { chars: rulesText.length, digest: sha256Hex(`app-rules-v1\n${rulesText}`) }
  }

  const skills: AppDiscoveredSkill[] = []
  const skillsRoot = join(directory, APP_SKILLS_DIR)
  let skillNames: string[] = []
  try {
    if (statSync(skillsRoot).isDirectory()) {
      skillNames = readdirSync(skillsRoot).filter((name) => {
        try {
          return statSync(join(skillsRoot, name)).isDirectory()
        } catch {
          return false
        }
      })
    }
  } catch {
    skillNames = []
  }
  for (const name of skillNames.sort()) {
    const rel = `${APP_SKILLS_DIR}/${name}/${APP_SKILL_FILE}`
    const text = readTextFile(join(directory, rel))
    if (text === null) {
      warnings.push(`技能缺正文已跳过: ${rel}`)
      continue
    }
    const front = parseSkillFrontmatter(text)
    const skillName = front.name || name
    if (skills.some((s) => s.name === skillName)) {
      warnings.push(`技能重名已跳过（保留首个）: ${skillName}`)
      continue
    }
    const description = front.description || ''
    skills.push({
      name: skillName,
      description,
      path: rel,
      chars: text.length,
      digest: sha256Hex(`app-skill-v1\n${skillName}\n${description}\n${text}`),
    })
  }

  return { directoryReadable: true, rules, skills, warnings }
}

/** 资源内容摘要（规则 + 有序技能）：温复用与变更检测只比摘要，不比目录名。 */
export function digestAppResources(load: AppResourceLoad): string | null {
  if (!load.rules) return null
  const skillPart = load.skills.map((s) => `${s.name}:${s.digest}`).join('\n')
  return sha256Hex(`app-resources-v1\n${load.rules.digest}\n${skillPart}`)
}

/** 读取常驻规则正文（适配器合并配置用；正文不出本作用域，只传摘要与长度）。 */
export function readAppRulesText(directory: string): string | null {
  return readTextFile(join(directory, APP_RULES_FILE))
}

export interface AppResourceReport {
  /** Prepared process overlay, not proof of runtime loading or UI MCP availability. */
  openCodeQuestions?: {
    version?: string
    mode: 'fallback' | 'unverified'
    configuration: 'prepared' | 'unchanged'
    reason: string
  }
  /** Child-only isolated config roots; existence is not proof the runtime loaded rules. */
  configurationScope?: 'session'
  configurationDirectory?: string
  configurationRulesFile?: string
  /** 规则是否已进入本次连接的原生通道（目录存在≠已应用） */
  rulesApplied: boolean
  /** 仅表示已准备原生环境，不等同于会话已应用。 */
  rulesPrepared?: boolean
  /** 原生技能入口未实现时为 false；skillsFound 只是 SDK 文件扫描结果。 */
  skillsApplied?: boolean
  /**
   * 技能向 Agent 的暴露方式（会话级）：
   * mcp-exposed = 已随会话 MCP 列表挂载通用只读技能服务；
   * none = 未挂载（无 resources / 显式关闭 / 构建失败）。
   * 原生运行时扫描生效时才可能为其他值，当前不虚构。
   */
  skillsExposed?: 'mcp-exposed' | 'none'
  rulesChars: number
  profileDigest: string | null
  /** SDK 已发现并读取正文的技能名（运行时是否加载另行确认，不冒充） */
  skillsFound: string[]
  /** 未应用/降级原因（脱敏短码） */
  reason?: string
  /** 握手后记录的桥版本（同进程内不变） */
  bridgeVersion?: string
  /** 桥版本是否在白名单内（未知/越界即 false） */
  bridgeSupported?: boolean
}

export interface AppResourcePrep {
  /** 待并入 spawn 环境的变量（缺席=不注入） */
  env?: NodeJS.ProcessEnv
  report: AppResourceReport
}

export function isAbsolutePathLike(path: string): boolean {
  return isAbsolute(path)
}
