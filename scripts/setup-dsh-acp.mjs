#!/usr/bin/env node
/**
 * DeepSeek（dsh）ACP 环境初始化：跨平台、可迁移。
 *
 * 用法：
 *   node scripts/setup-dsh-acp.mjs                 # 装稳定运行时并自检
 *   node scripts/setup-dsh-acp.mjs --check         # 只报告现状，不改任何东西
 *   node scripts/setup-dsh-acp.mjs --skip-install  # 只自检/只打印路径
 *   node scripts/setup-dsh-acp.mjs --version 0.2.1-rc.2 --runtime-dir D:\tools\acp-dsh
 *
 * 设计要点：
 * - 运行时按「用户级目录 + 版本号」安装，同一份代码在 Win/macOS/Linux 自解析；
 * - 不发指令改用户 profile：模型修正走 `dsh --profile acp --patch <临时文件>`；
 * - 重复执行幂等，已装版本直接复用。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_VERSION = '0.2.1-rc.2'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_PROVIDER = 'deepseek-official'

function parseArgs(argv) {
  const out = { check: false, verify: true, install: true, version: DEFAULT_VERSION }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') out.check = true
    else if (arg === '--no-verify') out.verify = false
    else if (arg === '--skip-install') out.install = false
    else if (arg === '--version') out.version = argv[++i]
    else if (arg === '--runtime-dir') out.runtimeDir = argv[++i]
    else if (arg === '--registry') out.registry = argv[++i]
    else if (arg === '-h' || arg === '--help') out.help = true
    else {
      console.error(`未知参数: ${arg}`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      'node scripts/setup-dsh-acp.mjs [--check] [--skip-install] [--no-verify]',
      '                                [--version <v>] [--runtime-dir <p>] [--registry <url>]',
      '',
      '安装/复用用户级 dsh 运行时时并自检 ACP 握手；不改 $DSH_HOME/profiles。',
    ].join('\n'),
  )
  process.exit(0)
}

function runtimeRoot() {
  if (args.runtimeDir) return args.runtimeDir
  if (process.env.DSH_RUNTIME_DIR?.trim()) return process.env.DSH_RUNTIME_DIR.trim()
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
    return join(base, 'acp-dsh')
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'acp-dsh')
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'acp-dsh')
}

const root = runtimeRoot()

/** 扫描运行时根目录，返回已安装的最高版本（acp-client 也是这个口径）。 */
function pickHighestInstalled() {
  let best = null
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    return match ? { nums: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] } : null
  }
  const compare = (a, b) => {
    const left = parse(a)
    const right = parse(b)
    if (!left || !right) return a.localeCompare(b)
    for (let i = 0; i < 3; i += 1) if (left.nums[i] !== right.nums[i]) return left.nums[i] - right.nums[i]
    if (!left.pre.length && right.pre.length) return 1
    if (left.pre.length && !right.pre.length) return -1
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
      if (left.pre[i] === undefined) return -1
      if (right.pre[i] === undefined) return 1
      if (left.pre[i] !== right.pre[i]) return left.pre[i] < right.pre[i] ? -1 : 1
    }
    return 0
  }
  for (const name of names) {
    if (!parse(name)) continue
    if (!existsSync(join(root, name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) continue
    if (best === null || compare(name, best) > 0) best = name
  }
  return best
}

/** `--version` 接受具体版本，也接受 dist-tag（latest/next/alpha）。 */
function resolveRequestedVersion(input) {
  if (/^\d+\.\d+\.\d+/.test(input)) return input
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm'
  const query = spawnSync(npm, ['view', `@deepseek-ai/dsh@${input}`, 'version'], {
    encoding: 'utf8',
    shell: platform() === 'win32',
  })
  const resolved = (query.stdout ?? '').trim().split(/\s+/).pop() ?? ''
  if (query.status !== 0 || !/^\d+\.\d+\.\d+/.test(resolved)) {
    console.error(`[dsh] 无法把 "${input}" 解析成具体版本（检查网络或改用具体版本号）`)
    process.exit(1)
  }
  console.log(`[dsh] dist-tag ${input} -> ${resolved}`)
  return resolved
}

const requestedVersion = args.check ? args.version : resolveRequestedVersion(args.version)
const prefix = join(root, requestedVersion)
const entry = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const installed = existsSync(entry)

console.log(`[dsh] 运行时目录: ${root}`)
console.log(`[dsh] 目标版本:   ${requestedVersion}`)
console.log(`[dsh] 入口:       ${entry}`)
console.log(`[dsh] 状态:       ${installed ? '已安装（复用）' : '未安装'}`)
const highest = pickHighestInstalled()
if (highest) console.log(`[dsh] acp-client 会自动选用已装最高版本: ${highest}`)

if (args.check) {
  const entryForClient = highest
    ? join(root, highest, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : entry
  console.log(`\nDSH_BIN=${entryForClient}`)
  process.exit(highest ? 0 : 1)
}

if (!installed) {
  if (!args.install) {
    console.error('[dsh] 运行时缺失且指定了 --skip-install，退出')
    process.exit(1)
  }
  mkdirSync(prefix, { recursive: true })
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm'
  const useShell = platform() === 'win32'
  // Windows 走 shell 时参数是拼接的：含空格的路径必须自己加引号，否则 cmd 会在空格处截断。
  const prefixArg = useShell && /\s/.test(prefix) ? `"${prefix}"` : prefix
  const npmArgs = [
    'install',
    '--prefix',
    prefixArg,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...(args.registry ? ['--registry', args.registry] : []),
    `@deepseek-ai/dsh@${requestedVersion}`,
  ]
  console.log(`[dsh] 执行: ${npm} ${npmArgs.join(' ')}`)
  const result = spawnSync(npm, npmArgs, { stdio: 'inherit', shell: useShell })
  if (result.status !== 0) {
    console.error(`[dsh] 安装失败（exit ${result.status}）；可换 --registry 或检查网络后重试`)
    process.exit(result.status ?? 1)
  }
  if (!existsSync(entry)) {
    console.error(`[dsh] 安装完成但入口不存在: ${entry}`)
    process.exit(1)
  }
}

// 模型覆盖层：与 src/runtimes/deepseek/dsh-acp-bootstrap.ts 保持同一内容。
const patchFile = join(tmpdir(), 'acp-dsh-runtime', `acp-model-${DEFAULT_PROVIDER}--${DEFAULT_MODEL}.patch.yml`)
mkdirSync(join(tmpdir(), 'acp-dsh-runtime'), { recursive: true })
writeFileSync(
  patchFile,
  [
    '# 由 @yitom/acp-client 生成：修正 ACP 会话默认模型。',
    '# dsh-acp-app 自带补丁把 model 写死为 deepseek-v4-flash，该 id 不在 provider catalog 中；',
    '# V4.1-Flash 的 catalog id 是 deepseek-flash（桌面端 1017 只是 UI 徽标）。',
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  config:',
    `    provider: ${DEFAULT_PROVIDER}`,
    `    model: ${DEFAULT_MODEL}`,
    '',
  ].join('\n'),
  'utf8',
)
console.log(`[dsh] 模型覆盖层: ${patchFile}`)

/**
 * 最小 ACP 握手：initialize + session/new，打印 model 选项，供自检。
 * 与 SDK 走同一条命令（含 --patch），所以验证结果就是真实链路的结果。
 */
function verifyHandshake() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, '--profile', 'acp', '--patch', patchFile], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })
    let buffer = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      try {
        child.stdin.end()
      } catch {}
      setTimeout(() => child.kill(), 500).unref()
      resolve(code)
    }
    const send = (id, method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const timer = setTimeout(() => {
      console.error('[dsh] 自检超时（120s）')
      finish(1)
    }, 120_000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) break
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === undefined) continue
        if (msg.method) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })}\n`)
          continue
        }
        if (msg.error) {
          console.error(`[dsh] 握手失败: ${JSON.stringify(msg.error)}`)
          clearTimeout(timer)
          finish(1)
          return
        }
        if (msg.id === 1) {
          send(2, 'session/new', { cwd: tmpdir(), mcpServers: [] })
          continue
        }
        if (msg.id === 2) {
          const model = (msg.result?.configOptions ?? []).find(
            (option) => option.category === 'model' || option.id === 'model',
          )
          const rows = []
          const walk = (options) => {
            for (const option of options ?? []) {
              if (Array.isArray(option.options)) walk(option.options)
              else if (option.name) rows.push(option.name)
            }
          }
          walk(model?.options)
          console.log(`[dsh] 当前模型: ${model?.currentValue ?? '(none)'}`)
          console.log(`[dsh] 可选模型: ${rows.length ? rows.join(', ') : '(空)'}`)
          const ok = rows.some((name) => /v4\.1-flash/i.test(name)) || /deepseek-flash/.test(model?.currentValue ?? '')
          console.log(ok ? '[dsh] 自检通过：V4.1-Flash 可用' : '[dsh] 自检未通过：未看到 V4.1-Flash（检查登录/网络）')
          clearTimeout(timer)
          finish(ok ? 0 : 1)
          return
        }
      }
    })
    child.on('error', (error) => {
      console.error(`[dsh] 启动失败: ${error.message}`)
      clearTimeout(timer)
      finish(1)
    })
    child.on('exit', (code) => {
      if (!settled) {
        console.error(`[dsh] 子进程提前退出（code ${code}）`)
        clearTimeout(timer)
        finish(1)
      }
    })
    send(1, 'initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'setup-dsh-acp', version: '0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
  })
}

console.log(`\nDSH_BIN=${entry}`)
if (args.verify) {
  console.log('[dsh] 开始 ACP 自检…')
  const code = await verifyHandshake()
  process.exit(code)
}
