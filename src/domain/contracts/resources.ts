/**
 * Pure domain value types and parsers for App Resources (AGENTS.md + skills/)
 * and read-only skills MCP descriptors. Zero Node.js I/O imports.
 */

export const APP_RULES_FILE = 'AGENTS.md'
export const APP_SKILLS_DIR = 'skills'
export const APP_SKILL_FILE = 'SKILL.md'
export const APP_SKILLS_MCP_SERVER_NAME = 'app-skills'

export interface AppDiscoveredSkill {
  /** Skill name (frontmatter name, falling back to directory name) */
  name: string
  /** Frontmatter description (empty string if omitted) */
  description: string
  /** Relative path to SKILL.md (`skills/<name>/SKILL.md`) */
  path: string
  /** Character count of the skill body */
  chars: number
  /** SHA-256 digest of name + description + body */
  digest: string
}

/**
 * Minimal dependency-free YAML frontmatter parser (name / description only).
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
  directoryReadable: boolean
  rules: { chars: number; digest: string } | null
  skills: AppDiscoveredSkill[]
  warnings: string[]
}

export interface AppResourceReport {
  configurationScope?: 'session'
  configurationDirectory?: string
  configurationRulesFile?: string
  rulesApplied: boolean
  rulesPrepared?: boolean
  skillsApplied?: boolean
  skillsExposed?: 'mcp-exposed' | 'none'
  rulesChars: number
  profileDigest: string | null
  skillsFound: string[]
  reason?: string
  bridgeVersion?: string
  bridgeSupported?: boolean
}

export interface AppResourcePrep {
  env?: Record<string, string | undefined>
  report: AppResourceReport
}

export type AppResourceStrategy = 'native-overlay' | 'native-session' | 'compatibility'

export interface AppResourceCapability {
  entry: string | null
  strategy: AppResourceStrategy
  configHome: string | null
  candidateEntry?: string
}

export type NativeCompatReason =
  | 'runtime-not-verified'
  | 'unknown-bridge-version'
  | 'unsupported-bridge-version'

export interface NativeEligibility {
  eligible: boolean
  reason?: NativeCompatReason
}

/**
 * Declarative layout for child-only session-scoped isolated configuration roots.
 * Each runtime plugin declares its own layout instead of hardcoding runtime IDs
 * in a central `if / else if` chain.
 */
export type SessionConfigLayoutSpec =
  | {
      kind: 'simple-config'
      rulesFileName: string
      extraRulesFileNames?: readonly string[]
      nativeRules: boolean
      buildEnv: (paths: { configDir: string; skillsDir: string }) => Record<string, string>
    }
  | {
      kind: 'nested-home'
      homeSubdir: string
      configSubdir: string
      rulesFileName: string
      nativeRules: boolean
      buildEnv: (paths: { homeDir: string; configDir: string; skillsDir: string }) => Record<string, string>
    }
  | {
      kind: 'opencode-xdg'
      includeConfigDirEnv: boolean
      skillsShape: 'object' | 'array'
      nativeRules: boolean
    }

export interface AppSkillsToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const APP_SKILLS_TOOLS: AppSkillsToolDefinition[] = [
  {
    name: 'app_list_skills',
    description:
      'List host skill catalog (names and one-line descriptions). ' +
      'Call this first to discover available skills; then read a body with app_read_skill before claiming its content. ' +
      'Skill bodies are never inlined here—always read on demand.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'app_read_skill',
    description:
      'Read one registered skill body by exact name from app_list_skills. ' +
      'Optional ref reads another Markdown file in the same skill directory ' +
      '(same-directory relative .md only; anything else is rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name from app_list_skills' },
        ref: {
          type: 'string',
          description: 'Optional same-directory relative Markdown file (default SKILL.md)',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
]

export interface AppSkillsCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface AppSkillsMcpServerDescriptor {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}
