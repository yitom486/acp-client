/**
 * U2/U3.3/U3.4 技能 MCP 服务（真实 stdio 子进程 + 真实资源文件）：
 * mock 边界——无 Agent/模型参与，对端是本文件内最小 JSON-RPC 客户端；
 * 断言正文与磁盘实时字节一致（非硬编码），修改文件后版本跟随变化。
 * Runner 解析优先构建产物（随包可用证据见 scripts/smoke-dist-resources.mjs）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { buildAppSkillsMcpServer, resolveAppSkillsRunnerPath } from './app-skills-mcp'

const dirs: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const c of children.splice(0)) {
    try { c.kill() } catch { /* ignore */ }
  }
  for (const d of dirs.splice(0)) {
    for (let i = 0; i < 10; i += 1) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }
})

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-skills-mcp-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'AGENTS.md'), '# host\n', 'utf8')
  mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true })
  writeFileSync(
    join(dir, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: Alpha skill.\n---\nALPHA_BODY_V1\n',
    'utf8',
  )
  mkdirSync(join(dir, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), 'BETA_NO_FRONTMATTER_BODY\n', 'utf8')
  return dir
}

interface RpcClient {
  call: (method: string, params?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>
  close: () => void
}

function startRunner(dir: string): RpcClient {
  const runner = resolveAppSkillsRunnerPath()
  const child = spawn(runner.endsWith('.ts') ? 'bun' : process.execPath, [runner, dir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  children.push(child)
  let seq = 0
  const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)?.(msg)
        pending.delete(msg.id)
      }
    } catch { /* 非 JSON 行忽略 */ }
  })
  return {
    call: (method, params) =>
      new Promise((resolve) => {
        const id = ++seq
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ error: { message: 'timeout' } })
        }, 10000)
        pending.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
    close: () => {
      try { child.kill() } catch { /* ignore */ }
    },
  }
}

describe('技能 MCP 服务（真实 stdio）', () => {
  it('initialize + tools/list 公布两个只读工具', async () => {
    const rpc = startRunner(fixtureDir())
    try {
      const init = await rpc.call('initialize', { protocolVersion: '2025-06-18' })
      expect((init.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe('app-skills')
      const list = await rpc.call('tools/list', {})
      const names = ((list.result as { tools?: { name?: string }[] })?.tools ?? []).map((t) => t.name)
      expect(names).toEqual(['app_list_skills', 'app_read_skill'])
    } finally {
      rpc.close()
    }
  })

  it('list→read 闭环：目录、描述、正文均来自磁盘实时字节', async () => {
    const dir = fixtureDir()
    const rpc = startRunner(dir)
    try {
      const listed = await rpc.call('tools/call', { name: 'app_list_skills', arguments: {} })
      const body = JSON.parse(
        ((listed.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? '{}'),
      ) as { skills?: { name?: string; description?: string; version?: string }[] }
      expect(body.skills?.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
      expect(body.skills?.find((s) => s.name === 'alpha')?.description).toBe('Alpha skill.')
      // 无 frontmatter 回退目录名，描述为空
      expect(body.skills?.find((s) => s.name === 'beta')?.description).toBe('')

      const read = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'alpha' } })
      const doc = JSON.parse(
        ((read.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? '{}'),
      ) as { name?: string; text?: string; version?: string }
      expect(doc.name).toBe('alpha')
      // 与磁盘实时字节一致（非测试内硬编码）
      expect(doc.text).toBe(readFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), 'utf8'))
      expect(doc.version).toBe(body.skills?.find((s) => s.name === 'alpha')?.version)
    } finally {
      rpc.close()
    }
  })

  it('修改文件后版本与正文跟随变化', async () => {
    const dir = fixtureDir()
    const rpc = startRunner(dir)
    try {
      const first = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'alpha' } })
      const v1 = (JSON.parse(
        ((first.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? '{}'),
      ) as { version?: string }).version
      writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha skill.\n---\nALPHA_BODY_V2\n', 'utf8')
      const second = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'alpha' } })
      const doc = JSON.parse(
        ((second.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? '{}'),
      ) as { text?: string; version?: string }
      expect(doc.text).toContain('ALPHA_BODY_V2')
      expect(doc.version).not.toBe(v1)
    } finally {
      rpc.close()
    }
  })

  it('未知技能、越界引用、非 md 引用一律拒绝且可区分', async () => {
    const rpc = startRunner(fixtureDir())
    try {
      const unknown = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'nope' } })
      expect(unknown.result).toMatchObject({ isError: true })
      expect(JSON.stringify(unknown.result)).toContain('unknown-skill')

      for (const ref of ['../AGENTS.md', '/etc/hosts', 'C:\\Windows\\x.md', 'notes.txt']) {
        const bad = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'alpha', ref } })
        expect(bad.result, ref).toMatchObject({ isError: true })
      }

      const unknownTool = await rpc.call('tools/call', { name: 'app_write_file', arguments: {} })
      expect(unknownTool.result).toMatchObject({ isError: true })
    } finally {
      rpc.close()
    }
  })

  it('同目录合法引用可读', async () => {
    const dir = fixtureDir()
    writeFileSync(join(dir, 'skills', 'alpha', 'extra.md'), 'EXTRA_NOTE\n', 'utf8')
    const rpc = startRunner(dir)
    try {
      const read = await rpc.call('tools/call', { name: 'app_read_skill', arguments: { name: 'alpha', ref: 'extra.md' } })
      expect(JSON.stringify(read.result)).toContain('EXTRA_NOTE')
    } finally {
      rpc.close()
    }
  })

  it('调用者自有服务可并存（两进程互不干扰）', async () => {
    const dirA = fixtureDir()
    const dirB = fixtureDir()
    const rpcA = startRunner(dirA)
    const rpcB = startRunner(dirB)
    try {
      const [a, b] = await Promise.all([
        rpcA.call('tools/call', { name: 'app_list_skills', arguments: {} }),
        rpcB.call('tools/call', { name: 'app_list_skills', arguments: {} }),
      ])
      expect(JSON.stringify(a.result)).toContain('alpha')
      expect(JSON.stringify(b.result)).toContain('alpha')
    } finally {
      rpcA.close()
      rpcB.close()
    }
  })
})

describe('ACP skill MCP descriptor', () => {
  it('includes required stdio env array for strict ACP agents', () => {
    const descriptor = buildAppSkillsMcpServer(fixtureDir());
    expect(descriptor.env).toEqual([]);
    expect(descriptor.command).toBe(process.execPath);
  });
});

it('runs the skill service as Node when the SDK is hosted in Electron',()=>{
  const before=Object.getOwnPropertyDescriptor(process.versions,'electron');
  Object.defineProperty(process.versions,'electron',{value:'test-electron',configurable:true});
  try {expect(buildAppSkillsMcpServer(fixtureDir()).env).toEqual([{name:'ELECTRON_RUN_AS_NODE',value:'1'}])}
  finally {if(before)Object.defineProperty(process.versions,'electron',before);else delete (process.versions as any).electron}
});
