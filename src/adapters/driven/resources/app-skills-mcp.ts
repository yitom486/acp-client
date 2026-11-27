import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  APP_SKILL_FILE,
  APP_SKILLS_DIR,
  APP_SKILLS_MCP_SERVER_NAME,
  APP_SKILLS_TOOLS,
  parseSkillFrontmatter,
  type AppSkillsCallResult,
  type AppSkillsMcpServerDescriptor,
  type AppSkillsToolDefinition,
} from '../../../domain/contracts'
import { readAppResourcesDir } from './app-resources'

export {
  APP_SKILLS_MCP_SERVER_NAME,
  APP_SKILLS_TOOLS,
  type AppSkillsCallResult,
  type AppSkillsMcpServerDescriptor,
  type AppSkillsToolDefinition,
}

function skillDirOf(directory: string, skillName: string): string | null {
  const load = readAppResourcesDir(directory)
  const found = load.skills.find((s) => s.name === skillName)
  if (!found) return null
  return join(directory, APP_SKILLS_DIR, found.path.split('/')[1] as string)
}

function readSkillFile(skillDir: string, ref: unknown): { text: string } | { error: string } {
  let rel = APP_SKILL_FILE
  if (ref !== undefined) {
    if (typeof ref !== 'string' || !ref.trim()) return { error: 'invalid-ref: ref 必须是非空相对路径' }
    const normalized = normalize(ref.trim())
    if (normalized.startsWith('..') || normalized.startsWith(sep) || /^[A-Za-z]:/.test(normalized)) {
      return { error: 'invalid-ref: 只允许技能目录内的相对路径' }
    }
    if (!normalized.toLowerCase().endsWith('.md')) {
      return { error: 'invalid-ref: 只允许同目录 .md 文件' }
    }
    const resolved = resolve(skillDir, normalized)
    const root = resolve(skillDir) + sep
    if (resolved !== resolve(skillDir) && !resolved.startsWith(root)) {
      return { error: 'invalid-ref: 越界引用被拒绝' }
    }
    rel = normalized
  }
  const full = join(skillDir, rel)
  try {
    if (!statSync(full).isFile()) return { error: 'unreadable-skill-file' }
    const text = readFileSync(full, 'utf8')
    if (!text.trim()) return { error: 'unreadable-skill-file' }
    return { text }
  } catch {
    return { error: 'unreadable-skill-file' }
  }
}

export async function callAppSkillsTool(
  directory: string,
  name: string,
  args?: Record<string, unknown>,
): Promise<AppSkillsCallResult> {
  const text = (value: string): AppSkillsCallResult => ({ content: [{ type: 'text', text: value }] })
  const fail = (message: string): AppSkillsCallResult => ({
    content: [{ type: 'text', text: message }],
    isError: true,
  })

  if (name === 'app_list_skills') {
    const load = readAppResourcesDir(directory)
    if (!load.directoryReadable) return fail('resource-directory-unreadable')
    const items = load.skills.map((s) => ({ name: s.name, description: s.description, version: s.digest.slice(0, 16) }))
    return text(JSON.stringify({ skills: items }, null, 2))
  }

  if (name === 'app_read_skill') {
    const skillName = args?.['name']
    if (typeof skillName !== 'string' || !skillName) return fail('unknown-skill: 需要 exact name')
    const skillDir = skillDirOf(directory, skillName)
    if (!skillDir) return fail(`unknown-skill: ${skillName}`)
    const load = readAppResourcesDir(directory)
    const record = load.skills.find((s) => s.name === skillName)
    const got = readSkillFile(skillDir, args?.['ref'])
    if ('error' in got) return fail(got.error)
    const body: Record<string, unknown> = {
      name: skillName,
      description: record?.description ?? parseSkillFrontmatter(got.text).description ?? '',
      version: record ? record.digest.slice(0, 16) : null,
      text: got.text,
    }
    return text(JSON.stringify(body, null, 2))
  }

  return fail(`unknown-tool: ${name}`)
}

export function buildAppSkillsMcpServer(
  directory: string,
  opts?: { name?: string; runnerPath?: string },
): AppSkillsMcpServerDescriptor {
  return {
    name: opts?.name ?? APP_SKILLS_MCP_SERVER_NAME,
    command: process.execPath,
    env: process.versions.electron ? [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] : [],
    args: [opts?.runnerPath ?? resolveAppSkillsRunnerPath(), directory],
  }
}

export function resolveAppSkillsRunnerPath(fromFile?: string): string {
  const base = fromFile ?? fileURLToPath(import.meta.url)
  const candidates = [
    join(dirname(base), 'app-skills-mcp-serve.cjs'),
    join(dirname(base), 'app-skills-mcp-serve.ts'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`技能 MCP 入口缺失（dist 未构建？）: ${candidates[0]}`)
}
