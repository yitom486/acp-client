import { fileURLToPath } from 'node:url'
/**
 * 构建产物冒烟：从 dist 的 ESM + CJS 双入口消费单目录接口，
 * 并拉起随包 MCP 子进程入口完成 list→read。
 * 不碰源码、不启动 Agent、不访问网络；任一步失败即非零退出。
 * 运行前确保 `bun run build` 已执行。
 */
import { spawnSync, spawn } from 'node:child_process'
import readline from 'node:readline'

const DIST = new URL('../dist/', import.meta.url)
const FIXTURE = new URL('../examples/fixtures/app-config/', import.meta.url)

let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra}`)
  if (!cond) failures += 1
}

// 1. ESM 入口
const esm = await import(new URL('index.js', DIST).href)
const load = esm.readAppResourcesDir(fileURLToPath(FIXTURE))
check('esm readAppResourcesDir', load.directoryReadable === true)
check('esm skills found', JSON.stringify(load.skills.map((s) => s.name)) === '["demo-render"]')

// 2. CJS 入口（独立进程，避免 import/require 互相污染）
const cjsProbe = spawnSync(process.execPath, ['-e', `
const sdk = require(${JSON.stringify(fileURLToPath(new URL('index.cjs', DIST)))});
const load = sdk.readAppResourcesDir(${JSON.stringify(fileURLToPath(FIXTURE))});
console.log(JSON.stringify({ readable: load.directoryReadable, skills: load.skills.map((s) => s.name), digestLen: (sdk.digestAppResources(load) || '').length }));
`], { encoding: 'utf8' })
let cjsOut = null
try { cjsOut = JSON.parse((cjsProbe.stdout || '').trim().split('\n').pop()) } catch { /* ignore */ }
check('cjs entry works', cjsOut?.readable === true && cjsOut?.digestLen === 64, ` ${JSON.stringify(cjsOut)}`)

// 3. 随包 MCP 子进程入口（dist cjs + 真实 fixture）
const runner = new URL('app-skills-mcp-serve.cjs', DIST)
const child = spawn(process.execPath, [fileURLToPath(runner), fileURLToPath(FIXTURE)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
let seq = 0
const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line)
    if (typeof msg.id === 'number' && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  } catch { /* ignore */ }
})
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: 'timeout' } }) }, 10000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const tools = await rpc('tools/list', {})
const toolNames = (tools.result?.tools ?? []).map((t) => t.name)
check('dist mcp tools/list', JSON.stringify(toolNames) === '["app_list_skills","app_read_skill"]')
const read = await rpc('tools/call', { name: 'app_read_skill', arguments: { name: 'demo-render' } })
const doc = JSON.parse(read.result?.content?.[0]?.text ?? '{}')
const { readFileSync } = await import('node:fs')
const { join } = await import('node:path')
const skillPath = join(fileURLToPath(FIXTURE), 'skills', 'demo-render', 'SKILL.md')
check('dist mcp read bytes', doc.text === readFileSync(skillPath, 'utf8'))
check('dist mcp read version', typeof doc.version === 'string' && doc.version.length === 16)
child.kill()

// 4. 包文件清单：无源码路径、无私有缓存引用
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'))
check('package files allow dist', Array.isArray(pkg.files) && pkg.files.includes('dist'))

if (failures > 0) {
  console.error(`SMOKE FAILED: ${failures} 项`)
  process.exitCode = 1
} else {
  console.log('SMOKE OK: dist ESM/CJS/MCP 均可用')
}
