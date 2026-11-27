import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  APP_RULES_FILE,
  APP_SKILL_FILE,
  APP_SKILLS_DIR,
  parseSkillFrontmatter,
  type AppDiscoveredSkill,
  type AppResourceLoad,
} from '../../../domain/contracts'

export {
  APP_RULES_FILE,
  APP_SKILL_FILE,
  APP_SKILLS_DIR,
  parseSkillFrontmatter,
  type AppDiscoveredSkill,
  type AppResourceLoad,
  type AppResourcePrep,
  type AppResourceReport,
} from '../../../domain/contracts'

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

export function readAppResourcesDir(directory: string): AppResourceLoad {
  const warnings: string[] = []
  if (!isAbsolute(directory)) {
    return { directoryReadable: false, rules: null, skills: [], warnings: ['资源目录必须是本机绝对路径'] }
  }
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

export function digestAppResources(load: AppResourceLoad): string | null {
  if (!load.rules) return null
  const skillPart = load.skills.map((s) => `${s.name}:${s.digest}`).join('\n')
  return sha256Hex(`app-resources-v1\n${load.rules.digest}\n${skillPart}`)
}

export function readAppRulesText(directory: string): string | null {
  return readTextFile(join(directory, APP_RULES_FILE))
}

export function isAbsolutePathLike(path: string): boolean {
  return isAbsolute(path)
}
