/**
 * U3.1/U3.2 兼容交付链路（真实 AcpClient + 真实 stdio peer + 真实资源文件）：
 * mock 边界——Agent 进程是确定性 JSON-RPC 夹具（fixtures/compat-agent.mjs，
 * 无模型、无网络）；spawn 环境、会话生命周期、prompt 内容、MCP 列表、
 * 版本门与记账均为真实链路。以下断言只描述 SDK 行为，不代表模型遵从。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../client/acp-client'
import { getActiveAcpProcess } from '../process/process-manager'

const PEER = join(import.meta.dir, 'fixtures/compat-agent.mjs')
const HOST_RULES = '# host rules\nHOST_RULES_MARKER: reply orders.\n'

const dirs: string[] = []
const clients: AcpClient[] = []
async function rmRetry(dir: string, tries = 10): Promise<void> {
  // Windows 锁定存活进程的 cwd：disconnect 已下发 kill，但 taskkill 落定异步；
  // 有界重试等锁释放，仍失败则抛错（不静默吞，避免掩盖孤儿进程）。
  let last: unknown = null
  for (let i = 0; i < tries; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      last = error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw last
}
afterEach(async () => {
  // 并行清理：串行 disconnect 在 taskkill 抖动下会撞 hook 时限；
  // rm 成功即 Windows cwd 锁释放，可作进程已亡证据。
  await Promise.all(clients.splice(0).map((c) => c.disconnect().catch(() => {})))
  await Promise.all(dirs.splice(0).map((d) => rmRetry(d)))
  delete process.env['MONTREE_COMPAT_PROBE_ENV']
})

function resourceDir(extra: Record<string, string> = {}, rulesText: string = HOST_RULES): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-compat-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'AGENTS.md'), rulesText, 'utf8')
  // 空 .git 截断 codex 适配器的向上配置查找：模拟真实项目工作区，
  // 使测试不受运行机 ambient 用户配置（~/.codex）影响，确定性隔离。
  mkdirSync(join(dir, '.git'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\nDEMO_BODY\n', 'utf8')
  for (const [rel, text] of Object.entries(extra)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  return dir
}

function peerRuntime(id: string) {
  return {
    id,
    name: 'Compat Probe Peer',
    description: 'mock ACP peer, no model',
    command: process.execPath,
    args: [PEER],
    requiredEnvKeys: [],
  }
}

function mockClient(dir: string, runtimeId = `compat-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, env: NodeJS.ProcessEnv = {}) {
  const c = new AcpClient({
    runtime: peerRuntime(runtimeId),
    workspaceRoot: dir,
    dataDir: dir,
    env,
    resources: { directory: dir },
  })
  clients.push(c)
  return c
}

async function promptFlags(client: AcpClient, sessionId: string, text: string) {
  const res = await client.promptSession(sessionId, text)
  if (!res.ok) throw new Error(`prompt failed: ${res.error.message}`)
  return res.value as { hasCompatMarker?: boolean; userTextIntact?: boolean; totalChars?: number; pid?: number; markerProfile?: string | null }
}

describe('SDK 兼容引导自动交付（mock peer，真链路）', () => {
  it('首轮附带同源规则、第二轮不重复、原文完整', async () => {
    const dir = resourceDir()
    const c = mockClient(dir)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.value.resourceReport?.rulesApplied).toBe(false)

    const first = await promptFlags(c, s.value.sessionId, 'PING-KEEP first turn')
    expect(first.hasCompatMarker).toBe(true)
    expect(first.userTextIntact).toBe(true)
    // 会话级 MCP 列表含 SDK 技能服务（调用者列表保留，自动并入）
    const desc = await c.promptSession(s.value.sessionId, '__describe__')
    expect(desc.ok).toBe(true)
    if (desc.ok) {
      expect(
        ((desc.value as { describe?: { news?: { mcpNames?: string[] }[] } }).describe?.news?.[0]?.mcpNames ?? []),
      ).toContain('app-skills')
    }
    const second = await promptFlags(c, s.value.sessionId, 'PING-KEEP second turn')
    expect(second.hasCompatMarker).toBe(false)
    expect(second.userTextIntact).toBe(true)
  })

  it('原生已交付不双发（peer env 见注入，prompt 无标记）', async () => {
    const dir = resourceDir()
    const home = mkdtempSync(join(tmpdir(), 'acp-compat-home-'))
    dirs.push(home)
    const c = new AcpClient({
      runtime: { ...peerRuntime('codex-acp'), id: 'codex-acp' },
      workspaceRoot: dir,
      dataDir: dir,
      env: { CODEX_HOME: home, MOCK_BRIDGE_VERSION: '2.2.2' },
      resources: { directory: dir },
    })
    clients.push(c)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.value.resourceReport?.rulesApplied).toBe(true)
    const only = await promptFlags(c, s.value.sessionId, 'PING-KEEP native turn')
    expect(only.hasCompatMarker).toBe(false)
    const desc = await c.promptSession(s.value.sessionId, '__describe__')
    expect(desc.ok).toBe(true)
    if (desc.ok) {
      expect((desc.value as { describe?: { codexConfigHasHost?: boolean } }).describe?.codexConfigHasHost).toBe(true)
    }
  })

  it('恢复同会话不重复（已知已送达）；新客户端恢复则附带一次', async () => {
    const dir = resourceDir()
    const c = mockClient(dir)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect((await promptFlags(c, s.value.sessionId, 'PING-KEEP new'))?.hasCompatMarker).toBe(true)
    // 同一客户端恢复同一会话：已知已送达，不重复
    const resumed = await c.createSession({ resumeSessionId: s.value.sessionId })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.value.resourceReport?.rulesApplied).toBe(false)
    expect((await promptFlags(c, resumed.value.sessionId, 'PING-KEEP resumed'))?.hasCompatMarker).toBe(false)
    // 新客户端恢复旧会话：送达状态未知，按新代次有界附带一次，之后不再重复
    const c2 = mockClient(dir)
    expect((await c2.connect()).ok).toBe(true)
    const r2 = await c2.createSession({ resumeSessionId: s.value.sessionId })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect((await promptFlags(c2, r2.value.sessionId, 'PING-KEEP fresh-client resume'))?.hasCompatMarker).toBe(true)
    expect((await promptFlags(c2, r2.value.sessionId, 'PING-KEEP after resume'))?.hasCompatMarker).toBe(false)
  })

  it('失败后可重试：传输已达，失败不重置记账', async () => {
    const dir = resourceDir()
    const c = mockClient(dir)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    // 首轮（含兼容块）已送达传输层，peer 回错；重试必须成功且不再重复附带
    const failed = await c.promptSession(s.value.sessionId, '__fail_once__ first')
    expect(failed.ok).toBe(false)
    const retry = await promptFlags(c, s.value.sessionId, 'PING-KEEP retry')
    expect(retry.hasCompatMarker).toBe(false)
    expect(retry.userTextIntact).toBe(true)
  })

  it('未知桥版本走兼容前置，不会无规则运行', async () => {
    const dir = resourceDir()
    const c = mockClient(dir, `compat-unknownver-${Date.now()}`, { MOCK_BRIDGE_VERSION: '9.9.9' })
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.value.resourceReport?.rulesApplied).toBe(false)
    expect((await promptFlags(c, s.value.sessionId, 'PING-KEEP unknown version'))?.hasCompatMarker).toBe(true)
  })

  it('最终 options.env 生效（透传进 spawn 环境）', async () => {
    const dir = resourceDir()
    process.env['MONTREE_COMPAT_PROBE_ENV'] = 'probe-env-value'
    const c = mockClient(dir)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    const desc = await c.promptSession(s.value.sessionId, '__describe__')
    expect(desc.ok).toBe(true)
    if (desc.ok) {
      expect((desc.value as { describe?: { extraEnvSeen?: string | null } }).describe?.extraEnvSeen).toBe('probe-env-value')
    }
  })

  it('磁盘已有用户配置：原文件不动，自动兼容照常交付', async () => {
    const dir = resourceDir()
    const home = mkdtempSync(join(tmpdir(), 'acp-compat-home-disk-'))
    dirs.push(home)
    const diskConfig = 'developer_instructions = "DISK_USER"\n'
    writeFileSync(join(home, 'config.toml'), diskConfig, 'utf8')
    const c = new AcpClient({
      runtime: { ...peerRuntime('codex-acp'), id: 'codex-acp' },
      workspaceRoot: dir,
      dataDir: dir,
      env: { CODEX_HOME: home, MOCK_BRIDGE_VERSION: '2.2.2' },
      resources: { directory: dir },
    })
    clients.push(c)
    expect((await c.connect()).ok).toBe(true)
    // 用户文件一字未动
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(diskConfig)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.value.resourceReport?.rulesApplied).toBe(false)
    // 兼容兜底仍然交付规则（不断规则运行）
    expect((await promptFlags(c, s.value.sessionId, 'PING-KEEP disk-config'))?.hasCompatMarker).toBe(true)
  })

  it('资源更新后按新摘要重新附带一次（有界，不打断在途）', async () => {
    const dir = resourceDir()
    const c = mockClient(dir)
    expect((await c.connect()).ok).toBe(true)
    const s = await c.createSession()
    expect(s.ok).toBe(true)
    if (!s.ok) return
    const first = await promptFlags(c, s.value.sessionId, 'PING-KEEP v1')
    expect(first.hasCompatMarker).toBe(true)
    expect(first.markerProfile).toBeTruthy()
    expect((await promptFlags(c, s.value.sessionId, 'PING-KEEP v1 again'))?.hasCompatMarker).toBe(false)
    // 修改规则文件 → 新摘要触发有界重附带（一次），标记内摘要必须变化
    writeFileSync(join(dir, 'AGENTS.md'), '# host rules\nHOST_RULES_MARKER_V2: new orders.\n', 'utf8')
    const updated = await promptFlags(c, s.value.sessionId, 'PING-KEEP v2')
    expect(updated.hasCompatMarker).toBe(true)
    expect(updated.markerProfile).toBeTruthy()
    expect(updated.markerProfile).not.toBe(first.markerProfile)
    expect((await promptFlags(c, s.value.sessionId, 'PING-KEEP v2 again'))?.hasCompatMarker).toBe(false)
  })

  it('两客户端不串资源，断开后清理无残留', async () => {
    const dirA = resourceDir()
    const dirB = resourceDir({}, '# host rules B\nHOST_RULES_MARKER_B: other.\n')
    const ridA = `compat-iso-a-${Date.now()}`
    const ridB = `compat-iso-b-${Date.now()}`
    const cA = mockClient(dirA, ridA)
    const cB = mockClient(dirB, ridB)
    expect((await cA.connect()).ok).toBe(true)
    expect((await cB.connect()).ok).toBe(true)
    const sA = await cA.createSession()
    const sB = await cB.createSession()
    expect(sA.ok && sB.ok).toBe(true)
    if (!sA.ok || !sB.ok) return
    const rA = await promptFlags(cA, sA.value.sessionId, 'PING-KEEP a')
    const rB = await promptFlags(cB, sB.value.sessionId, 'PING-KEEP b')
    expect(rA.pid).not.toBe(rB.pid)
    expect(sA.value.resourceReport?.profileDigest).not.toBe(sB.value.resourceReport?.profileDigest)
    await cA.disconnect()
    await cB.disconnect()
    expect(getActiveAcpProcess(ridA)).toBeUndefined()
    expect(getActiveAcpProcess(ridB)).toBeUndefined()
  })
})

describe('MCP rejection report', () => {
  it('does not claim skills exposed after fallback without MCP', async () => {
    const c = mockClient(resourceDir(), 'mcp-reject-probe', {MOCK_REJECT_MCP:'1'});
    expect((await c.connect()).ok).toBe(true);
    const opened = await c.createSession();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.resourceReport?.skillsExposed).toBe('none');
  });
});

describe('Claude native session configuration via real SDK and mock peer', () => {
  for (const reject of [false,true]) it(reject ? 'native rejection retains MCP and falls back to rule delivery' : 'native system append and plugin directory pass through without repeated user prefix', async () => {
    const c=mockClient(resourceDir(), 'claude', {MOCK_BRIDGE_VERSION:'0.91.0',MOCK_REJECT_NATIVE:reject?'1':'0'});
    expect((await c.connect()).ok).toBe(true);
    const opened=await c.createSession(); expect(opened.ok).toBe(true); if(!opened.ok)return;
    expect(opened.value.resourceReport?.rulesApplied).toBe(!reject);
    expect(opened.value.resourceReport?.skillsExposed).toBe('mcp-exposed');
    const first=await promptFlags(c,opened.value.sessionId,'PING-KEEP first');
    expect(first.hasCompatMarker).toBe(reject);
    const second=await promptFlags(c,opened.value.sessionId,'PING-KEEP second');
    expect(second.hasCompatMarker).toBe(false);
    const desc=await c.promptSession(opened.value.sessionId,'__describe__'); if(desc.ok) {
      const news=(desc.value as any).describe.news;
      expect(news[0].mcpNames).toContain('app-skills');
      expect(Boolean(news[0].nativeMeta?.systemPrompt)).toBe(!reject);
    }
  });
});


it.each(['0.1.24', '0.1.25', '0.1.26'])('agy %s native resources are delivered on session creation', async (bridgeVersion) => {
  const dir=resourceDir();
  const client=mockClient(dir,'agy',{MOCK_BRIDGE_VERSION:bridgeVersion});
  expect((await client.connect()).ok).toBe(true);
  const created=await client.createSession();expect(created.ok).toBe(true);if(!created.ok)throw Error('session');
  await client.promptSession(created.value.sessionId,'PING-KEEP');
  const describe=await client.promptSession(created.value.sessionId,'__describe__');expect(describe.ok).toBe(true);
  if(describe.ok){const d=(describe.value as any).describe;expect(d.news[0].nativeMeta.appResources.directory).toBe(dir);expect(d.prompts[0].hasCompatMarker).toBe(false);}
});
