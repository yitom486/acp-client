/**
 * 应用技能 MCP stdio 服务入口（随包构建产物，无源码依赖）：
 *   node app-skills-mcp.cjs <directory>
 * 只读：app_list_skills / app_read_skill；无写入、无执行。
 * 协议子集与库内既有 MCP 分发一致（initialize/tools/list/tools/call/ping）。
 * 读取证据打到 stderr（JSON 行），stdout 只走 JSON-RPC。
 */
import { createInterface } from 'node:readline'
import { APP_SKILLS_TOOLS, callAppSkillsTool } from './app-skills-mcp'

const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function logRead(skill: string, version: string | null): void {
  process.stderr.write(`${JSON.stringify({ 'app-skills-read': { skill, version } })}\n`)
}

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (!directory) {
    process.stderr.write('用法: app-skills-mcp.cjs <directory>\n')
    process.exitCode = 2
    return
  }
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    void handleLine(line).catch((error: unknown) => {
      process.stderr.write(`handler failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  })

  async function handleLine(line: string): Promise<void> {
    let msg: Msg
    try {
      msg = JSON.parse(line) as Msg
    } catch {
      return
    }
    if (msg.id === undefined || msg.id === null) return
    const { id, method, params } = msg
    if (method === 'initialize') {
      const requested = params?.['protocolVersion']
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'app-skills', version: '1' },
        },
      })
      return
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: APP_SKILLS_TOOLS } })
      return
    }
    if (method === 'tools/call') {
      const name = params?.['name']
      if (typeof name !== 'string') {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call 需要 name' } })
        return
      }
      const rawArgs = params?.['arguments']
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : undefined
      const result = await callAppSkillsTool(directory, name, args)
      if (name === 'app_read_skill' && !result.isError && typeof args?.['name'] === 'string') {
        try {
          const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { version?: unknown }
          logRead(args['name'] as string, typeof parsed.version === 'string' ? parsed.version : null)
        } catch {
          // 日志失败不影响协议返回
        }
      }
      send({ jsonrpc: '2.0', id, result })
      return
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } })
  }
}

void main()
