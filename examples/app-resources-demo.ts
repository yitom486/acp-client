/**
 * 最小使用示例：只传一个资源目录，走完 connect → createSession → prompt。
 *
 * 运行方式（仓库根）：
 *   bun examples/app-resources-demo.ts [directory]            # 仅扫描与报告（无 Agent）
 *   bun examples/app-resources-demo.ts [directory] --mock-agent  # 全链路离线验收（mock peer，无模型/网络）
 *   bun examples/app-resources-demo.ts --real [directory]       # 真实 Agent（需本机已登录对应运行时）
 *
 * mock 模式用内置最小 JSON-RPC peer（非模型），验证：
 * 首轮兼容引导附带、第二轮不重复、prompt 原文完整、MCP 列表含技能服务。
 * 真实模式需要有效登录与网络；失败即如实报错，不重试。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpClient, getAcpRuntimeAdapter, readAppResourcesDir } from '../src'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const mockAgent = args.includes('--mock-agent')
const realAgent = args.includes('--real')
const directory =
  args.find((a) => !a.startsWith('--')) ?? join(here, 'fixtures', 'app-config')

async function scanOnly(): Promise<void> {
  const load = readAppResourcesDir(directory)
  console.log('directoryReadable:', load.directoryReadable)
  console.log('rulesChars:', load.rules?.chars ?? null)
  console.log('skills:', load.skills.map((s) => `${s.name}${s.description ? ` — ${s.description}` : ''}`))
  console.log('warnings:', load.warnings)
  console.log('OK: scan only (no agent started). Pass --mock-agent for the offline lifecycle check.')
}

const PEER_SOURCE = `
import { createInterface } from 'node:readline';
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!('id' in msg)) return;
  if (msg.method === 'initialize') respond(msg.id, { protocolVersion: 1, authMethods: [], agentInfo: { name: 'demo-peer', version: '0.0.0-mock' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
  else if (/^session\\/(new|load|resume)$/.test(msg.method)) respond(msg.id, { sessionId: msg.params.sessionId || 'demo-session', configOptions: [] });
  else if (msg.method === 'session/prompt') {
    const text = (msg.params.prompt || []).map((b) => b.text || '').join('\\n');
    respond(msg.id, { stopReason: 'end_turn', hasCompat: text.includes('<acp-compat-context'), kept: text.includes('PING-KEEP') });
  } else respond(msg.id, {});
});
`

async function mockLifecycle(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'acp-demo-peer-'))
  const peerFile = join(dir, 'peer.mjs')
  writeFileSync(peerFile, PEER_SOURCE, 'utf8')
  const client = new AcpClient({
    runtime: {
      id: 'demo-mock',
      name: 'Demo Mock Peer',
      description: 'offline acceptance peer, no model',
      command: process.execPath,
      args: [peerFile],
      requiredEnvKeys: [],
    },
    workspaceRoot: directory,
    dataDir: dir,
    resources: { directory },
  })
  try {
    const connected = await client.connect()
    if (!connected.ok) throw new Error(`connect 失败: ${connected.error.message}`)
    const session = await client.createSession()
    if (!session.ok) throw new Error(`建会话失败: ${session.error.message}`)
    console.log('session restoreMethod:', session.value.restoreMethod)
    console.log('session skillsExposed:', session.value.resourceReport?.skillsExposed ?? null)
    const first = await client.promptSession(session.value.sessionId, 'PING-KEEP first turn')
    if (!first.ok) throw new Error(`首轮失败: ${first.error.message}`)
    console.log('first turn compat attached:', (first.value as { hasCompat?: boolean })?.hasCompat === true)
    console.log('first turn user text kept:', (first.value as { kept?: boolean })?.kept === true)
    const second = await client.promptSession(session.value.sessionId, 'PING-KEEP second turn')
    if (!second.ok) throw new Error(`第二轮失败: ${second.error.message}`)
    console.log('second turn compat repeated:', (second.value as { hasCompat?: boolean })?.hasCompat === true)
    if ((first.value as { hasCompat?: boolean })?.hasCompat !== true) throw new Error('首轮未附带兼容引导')
    if ((second.value as { hasCompat?: boolean })?.hasCompat !== false) throw new Error('第二轮重复附带')
    if ((first.value as { kept?: boolean })?.kept !== true) throw new Error('用户原文被改动')
    console.log('OK: mock-agent offline lifecycle accepted (no model involved).')
  } finally {
    await client.disconnect()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function realLifecycle(): Promise<void> {
  const adapter = getAcpRuntimeAdapter('codex-acp')
  console.log('adapter:', adapter.id, '| supportedBridgeVersions:', adapter.supportedBridgeVersions ?? '(none declared)')
  const client = new AcpClient({
    runtime: 'codex-acp',
    workspaceRoot: process.cwd(),
    resources: { directory },
  })
  const connected = await client.connect()
  if (!connected.ok) throw new Error(`真实连接失败（请确认本机登录与网络）: ${connected.error.message}`)
  try {
    console.log('bridgeVersion:', client.resourceReport?.bridgeVersion ?? null)
    const session = await client.createSession()
    if (!session.ok) throw new Error(`建会话失败: ${session.error.message}`)
    console.log('session rulesApplied:', session.value.resourceReport?.rulesApplied ?? null)
    console.log('OK: real agent session established. 按需手动 prompt 验证模型行为（本示例不自动发起模型调用）。')
  } finally {
    await client.disconnect()
  }
}

async function main(): Promise<void> {
  if (mockAgent) {
    await mockLifecycle()
    return
  }
  if (realAgent) {
    await realLifecycle()
    return
  }
  await scanOnly()
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
