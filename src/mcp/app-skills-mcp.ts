import { normalize, resolve, sep } from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  APP_SKILL_FILE,
  APP_SKILLS_DIR,
  parseSkillFrontmatter,
  readAppResourcesDir,
} from '../resources/app-resources'

/**
 * SDK 管理的通用只读技能 MCP 服务（纯文档技能）：
 * - `app_list_skills`：技能目录（名称+描述），供模型发现；
 * - `app_read_skill`：指定技能正文按需读取（含版本摘要）。
 * 只读：无写入、无执行；目录穿越/越界引用一律拒绝并报可诊断错误码。
 * 不包含任何宿主业务内容；工具描述只讲发现与加载方法。
 */

export const APP_SKILLS_MCP_SERVER_NAME = 'app-skills'

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

export type AppSkillsCallResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function skillDirOf(directory: string, skillName: string): string | null {
  // 每次调用重新发现：文件增删改名即时生效，不依赖启动快照。
  const load = readAppResourcesDir(directory)
  const found = load.skills.find((s) => s.name === skillName)
  if (!found) return null
  // 路径取自发现记录（目录名），不拼接用户输入，天然防穿越。
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

/**
 * 分发技能工具调用（纯函数式逻辑，可单测；stdio Runner 与单测共用）。
 * 返回文本均为磁盘实时读取；修改文件后新版本即时可见。
 */
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

export interface AppSkillsMcpServerDescriptor {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

/**
 * 技能 MCP 服务描述符（供宿主并入 createSession 的 mcpServers）：
 * command/args 指向随包构建产物，无源码路径、无私有缓存引用。
 */
export function buildAppSkillsMcpServer(
  directory: string,
  opts?: { name?: string; runnerPath?: string },
): AppSkillsMcpServerDescriptor {
  return {
    name: opts?.name ?? APP_SKILLS_MCP_SERVER_NAME,
    command: process.execPath,
    env: process.versions.electron ? [{name:'ELECTRON_RUN_AS_NODE',value:'1'}] : [],
    args: [opts?.runnerPath ?? resolveAppSkillsRunnerPath(), directory],
  }
}

/**
 * Runner 入口解析：优先构建产物（发版/消费路径），回落源码（开发期）。
 * 两者皆无时抛错（调用方明确降级，不静默挂一个坏服务）。
 */
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
