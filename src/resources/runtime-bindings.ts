import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { digestAppResources, readAppResourcesDir, readAppRulesText, type AppResourcePrep } from './app-resources'

/** Configuration-home discovery is NOT an ACP guarantee. Keep authentication homes intact. */
export const APP_RESOURCE_CAPABILITIES = {
  'codex-acp': { entry: 'CODEX_CONFIG', strategy: 'native-overlay', configHome: 'CODEX_HOME' },
  opencode: { entry: 'OPENCODE_CONFIG_CONTENT', strategy: 'native-overlay', configHome: 'OPENCODE_CONFIG_DIR' },
  'opencode-v2': { entry: null, strategy: 'compatibility', configHome: null },
  claude: { entry: '_meta.systemPrompt + _meta.claudeCode.options.plugins', strategy: 'native-session', configHome: 'CLAUDE_CONFIG_DIR' },
  gemini: { entry: null, strategy: 'compatibility', configHome: 'GEMINI_CLI_HOME' },
  copilot: { entry: null, strategy: 'compatibility', configHome: 'COPILOT_HOME', candidateEntry: 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS' },
  'cursor-cli': { entry: null, strategy: 'compatibility', configHome: 'CURSOR_CONFIG_DIR' },
  agy: { entry: '_meta.appResources.directory', strategy: 'native-session', configHome: null },
  deepseek: { entry: null, strategy: 'compatibility', configHome: null },
} as const

export function prepareCompatibilityResources(directory: string, reason: string): AppResourcePrep {
  const load = readAppResourcesDir(directory)
  return { report: { rulesApplied: false, rulesPrepared: false, skillsApplied: false,
    rulesChars: load.rules?.chars ?? 0, profileDigest: digestAppResources(load),
    skillsFound: load.skills.map(s => s.name), reason } }
}

export function mergeOpenCodeAppConfig(raw: string | undefined, directory: string): string {
  const value: unknown = raw?.trim() ? JSON.parse(raw) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-opencode-config')
  const config = value as Record<string, unknown>
  if (config.instructions !== undefined && (!Array.isArray(config.instructions) || config.instructions.some(v => typeof v !== 'string'))) throw new Error('invalid-opencode-instructions')
  if (config.skills !== undefined && (!config.skills || typeof config.skills !== 'object' || Array.isArray(config.skills))) throw new Error('invalid-opencode-skills')
  const skills = (config.skills ?? {}) as Record<string, unknown>
  if (skills.paths !== undefined && (!Array.isArray(skills.paths) || skills.paths.some(v => typeof v !== 'string'))) throw new Error('invalid-opencode-skill-paths')
  return JSON.stringify({ ...config,
    instructions: [...new Set([...(config.instructions as string[] ?? []), join(directory, 'AGENTS.md')])],
    skills: { ...skills, paths: [...new Set([...(skills.paths as string[] ?? []), join(directory, 'skills')])] },
  })
}

/** Exact release checked against anomalyco/opencode v1.18.35 acp/event.ts.
 * Permissions do not imply question support; unknown releases stay unchanged. */
export function resolveOpenCodeQuestionMode(version: string): 'fallback' | 'unverified' {
  return version.trim() === '1.18.35' ? 'fallback' : 'unverified'
}

/** Child-only overlay; preserve unrelated permissions, providers and authentication. */
export function mergeOpenCodeQuestionConfig(raw: string | undefined): string {
  const value: unknown = raw?.trim() ? JSON.parse(raw) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-opencode-config')
  const config = value as Record<string, unknown>
  const permission = config.permission
  if (permission !== undefined && (typeof permission !== 'string' || !['allow','ask','deny'].includes(permission)) &&
      (!permission || typeof permission !== 'object' || Array.isArray(permission))) throw new Error('invalid-opencode-permission')
  const rules = typeof permission === 'string' ? { '*': permission } : permission ?? {}
  return JSON.stringify({ ...config, permission: { ...rules as Record<string, unknown>, question: 'deny' } })
}

export async function prepareOpenCodeResources(input: { directory: string; env?: NodeJS.ProcessEnv; command?: string }): Promise<AppResourcePrep> {
  const prep = prepareCompatibilityResources(input.directory, 'native-entry-not-verified')
  prep.report.openCodeQuestions = { mode: 'unverified', configuration: 'unchanged', reason: 'version-not-verified' }
  if (!input.command) return prep
  try {
    const { stdout } = await promisify(execFile)(input.command, ['--version'], { env: input.env, timeout: 8000, windowsHide: true })
    const version = stdout.trim()
    if (resolveOpenCodeQuestionMode(version) !== 'fallback') {
      prep.report.openCodeQuestions!.version = version
      return prep
    }
    let json = mergeOpenCodeQuestionConfig(input.env?.OPENCODE_CONFIG_CONTENT)
    const hasRules = !!readAppRulesText(input.directory)
    if (hasRules) json = mergeOpenCodeAppConfig(json, input.directory)
    return { env: { OPENCODE_CONFIG_CONTENT: json }, report: { ...prep.report,
      rulesPrepared: hasRules, reason: hasRules ? undefined : 'missing-app-rules',
      openCodeQuestions: { version, mode: 'fallback', configuration: 'prepared', reason: 'acp-question-not-forwarded' },
    } }
  } catch {
    return { ...prep, report: { ...prep.report, reason: 'native-config-prepare-failed',
      openCodeQuestions: { mode: 'unverified', configuration: 'unchanged', reason: 'prepare-failed' },
    } }
  }
}

export function prepareClaudeResources(directory: string): AppResourcePrep {
  const prep = prepareCompatibilityResources(directory, 'native-session-version-not-verified')
  return { ...prep, report: { ...prep.report, rulesPrepared: !!readAppRulesText(directory) } }
}

export function claudeResourceSessionMeta(directory: string): Record<string, unknown> | undefined {
  const text = readAppRulesText(directory)
  if (!text) return undefined
  return { systemPrompt: { type: 'preset', preset: 'claude_code', append: text },
    claudeCode: { options: { plugins: [{ type: 'local', path: directory }] } } }
}

