import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import type { AcpRuntimeInfo } from "../contracts"

export interface SpawnedAcpProcess {
  runtimeId: string
  /** 宿主作用域键（如窗口/租户隔离；缺席=单宿主默认） */
  scopeKey?: string
  /** 执行环境标记（如 native / wsl:<distro>；宿主计算后传入） */
  executionContext?: string
  /** 应用资源绑定标签（内容摘要+运行时；缺席=未绑定，按旧语义复用） */
  profileTag?: string | null
  /** 握手后记录的桥版本（同进程内不变） */
  bridgeVersion?: string
  child: ChildProcessWithoutNullStreams
  kill: () => void
  /** spawn 时间戳（保留供诊断/排序，stderr 归因已去窗口化，不再参与判定） */
  spawnedAt: number
  /** stderr 最后 N 行活引用（连接失败自诊断用，上限见 ACP_EARLY_EXIT_STDERR_TAIL_LINES） */
  stderrTail: string[]
}

function processKey(runtimeId: string, scopeKey?: string): string {
  return scopeKey ? `${scopeKey}:${runtimeId}` : runtimeId
}

const active = new Map<string, SpawnedAcpProcess>()

/**
 * @deprecated 早退判定窗口已去窗口化（dsh 依赖解析慢退漏归因教训）：
 * 保留导出仅防旧引用，`getAcpEarlyExitStderrDetail` 不再读取它。
 */
export const ACP_EARLY_EXIT_WINDOW_MS = 3_000
/** 连接失败时拼进错误的 stderr 尾部行数上限。单处常量。 */
export const ACP_EARLY_EXIT_STDERR_TAIL_LINES = 20

export interface SpawnAcpOptions {
  runtime: AcpRuntimeInfo
  cwd: string
  env?: NodeJS.ProcessEnv
  /** 需要从继承环境里剔除的变量名（如关闭代理时清理 HTTP(S)_PROXY） */
  envRemove?: string[]
  /** 宿主作用域键（窗口/租户隔离；缺席=单宿主默认，与旧键完全一致） */
  scopeKey?: string
  /** 执行环境标记（宿主计算后传入；复用时必须一致） */
  executionContext?: string
  /** 应用资源绑定标签（要求时不一致即视为无温进程） */
  profileTag?: string | null
  onStderrLine?: (line: string) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

/**
 * 进程是否仍存活。exitCode 非 null 表示已退出；killed 仅表示收到过 kill 信号，
 * 必须两者结合判断，避免对已退出（PID 可能已被系统复用）的进程再下手。
 */
export function isSpawnedAcpProcessAlive(handle: SpawnedAcpProcess): boolean {
  const child = handle.child
  return !child.killed && child.exitCode === null && child.signalCode === null
}

/**
 * 按 PID 树级联杀（Windows）：趁父进程（PyInstaller 引导器）还活着时沿父子链
 * 把外层引导器 / 内层 Python / harness 一并击杀，避免只杀外层留下孤儿。
 * 仅对确认存活的进程执行，防止误伤已被系统回收复用的 PID。
 */
function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') return
  try {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      timeout: 8000,
    })
  } catch {
    // taskkill 失败时上层仍有 child.kill() 兜底
  }
}
function resolveCommand(runtime: AcpRuntimeInfo): { file: string; shell: boolean } {
  // Windows 上 .exe（如 node.exe, bun.exe 等）以及 node/bun runtime 绝对不能使用 shell: true，
  // 否则当路径含有空格（如 C:\Program Files\...）时 cmd.exe 会发生截断并报 'C:\Program' 不是内部或外部命令。
  if (process.platform === 'win32') {
    const cmd = runtime.command.toLowerCase()
    if (/\.exe$/i.test(cmd) || cmd === 'bun' || cmd === 'node') {
      return { file: runtime.command, shell: false }
    }
    return { file: runtime.command, shell: true }
  }
  return { file: runtime.command, shell: false }
}

/**
 * 多运行时温进程隔离：`active` 按作用域+runtime.id 分键，绝不跨作用域或
 * runtime 串用（无作用域时键即 runtime.id，与旧行为一致）。
 * connect 前经 `getLiveAcpProcess` / `tryReuseLiveAcpProcess` 取温进程；
 * 不同 runtime 即使 command 相同也各持独立句柄。
 */
// TODO(下游 contracts 未就绪): 8 模板落地后各 runtime 独立 command/args 在此自然分键，无需再改。
export function spawnAcpProcess(options: SpawnAcpOptions): SpawnedAcpProcess {
  // 防御性：模板缺 command/args 时早失败，避免 spawn 空命令污染温进程表。
  if (!options.runtime?.id || !options.runtime.command || !Array.isArray(options.runtime.args)) {
    throw new Error(`ACP 运行时模板缺失 command/args: ${options.runtime?.id ?? '(empty)'}`)
  }
  // 同作用域旧句柄先杀（换命令/参数后不复用）；其他作用域/runtime 不受影响。
  const key = processKey(options.runtime.id, options.scopeKey)
  const existing = active.get(key)
  if (existing) {
    existing.kill()
  }

  const { file, shell } = resolveCommand(options.runtime)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  }
  for (const key of options.envRemove ?? []) {
    delete env[key]
  }

  // 过滤 Python/PyInstaller 临时环境变量，避免嵌入式运行时校验中断
  for (const key of Object.keys(env)) {
    if (key.startsWith('_PYI') || key.startsWith('_MEI')) {
      delete env[key]
    }
  }

  // 默认允许本机浏览器 OAuth（对齐 VS Code/Zed）；无头/CI 才禁用
  const forceNoBrowser =
    process.env.INKDOWN_ACP_NO_BROWSER === '1' ||
    process.env.CI === 'true' ||
    process.env.CI === '1'
  if (forceNoBrowser) {
    env.NO_BROWSER = '1'
  } else {
    delete env.NO_BROWSER
  }

  const child = spawn(file, options.runtime.args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams

  let stderrBuffer = ''
  const stderrTail: string[] = []
  const pushStderrTailLine = (line: string) => {
    if (!line.trim()) return
    stderrTail.push(line)
    if (stderrTail.length > ACP_EARLY_EXIT_STDERR_TAIL_LINES) {
      stderrTail.splice(0, stderrTail.length - ACP_EARLY_EXIT_STDERR_TAIL_LINES)
    }
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk
    while (true) {
      const idx = stderrBuffer.indexOf('\n')
      if (idx < 0) break
      const line = stderrBuffer.slice(0, idx).replace(/\r$/, '')
      stderrBuffer = stderrBuffer.slice(idx + 1)
      if (line.trim()) {
        pushStderrTailLine(line)
        if (process.env.NODE_ENV !== 'production') {
          console.error(`[acp:${options.runtime.id}]`, line)
        }
        options.onStderrLine?.(line)
      }
    }
  })

  const handle: SpawnedAcpProcess = {
    runtimeId: options.runtime.id,
    scopeKey: options.scopeKey,
    executionContext: options.executionContext,
    profileTag: options.profileTag ?? null,
    child,
    spawnedAt: Date.now(),
    stderrTail,
    kill: () => {
      // 已退出的进程不再下手：其 PID 可能已被系统回收复用，误杀后果严重。
      if (isSpawnedAcpProcessAlive(handle)) {
        // 先递 EOF，让官方服务端走 stdin 优雅退出（PyInstaller 退出钩子会自删 _MEI）。
        try {
          child.stdin.end()
        } catch {
          // stdin 已坏时忽略，走下面的强制路径
        }
        // 树杀整棵进程树（外层引导器/内层 Python/harness），杜绝孤儿残留。
        // 注意：必须趁父子关系还在内核登记时执行，父死后 /T 即失效。
        if (typeof child.pid === 'number') {
          killProcessTree(child.pid)
        }
        if (!child.killed) {
          try {
            child.kill()
          } catch {
            // 忽略竞态关闭
          }
        }
      }
      active.delete(key)
    },
  }

  child.on('exit', (code, signal) => {
    // 无换行结尾的 stderr 残行落尾（harness 缺 key 秒退常为单行无换行输出，不丢）。
    const rest = stderrBuffer.trim()
    if (rest) pushStderrTailLine(rest)
    stderrBuffer = ''
    if (active.get(key) === handle) active.delete(key)
    options.onExit?.(code, signal)
  })

  active.set(key, handle)
  return handle
}

/**
 * 连接失败自诊断（去窗口化）：进程已死且连接失败时，一律取 stderr 尾部
 * 供连接层拼进失败错误，替代裸 `ACP connection closed`。
 * 背景：dsh 自解析依赖耗时远超旧 3s 窗口，慢退漏归因；故不再限早退窗口，
 * 慢退/长会话失败同样受益；正常成功路径不调用此处，零变化。
 * 无 stderr 尾返回 null，调用方保持原错误不变；
 * killProcess/温复用路径不经此处，不受影响。
 * `now` 参数保留仅防旧调用（已忽略）。
 */
export function getAcpEarlyExitStderrDetail(
  handle: Pick<SpawnedAcpProcess, 'spawnedAt' | 'stderrTail'> | null | undefined,
  _now: number = Date.now(),
): string | null {
  if (!handle) return null
  void _now
  const tail = (handle.stderrTail ?? [])
    .filter((line) => line.trim())
    .slice(-ACP_EARLY_EXIT_STDERR_TAIL_LINES)
  if (tail.length === 0) return null
  return tail.join('\n')
}

/** 失败尾部拼进连接失败错误（已含尾部时不重复拼）。函数名保留早退字样仅防旧引用。 */
export function withAcpEarlyExitDetail(message: string, detail: string | null): string {
  if (!detail) return message
  if (message.includes(detail)) return message
  return `${message}\n\n子进程早退 stderr 尾部：\n${detail}`
}

export function disposeAllAcpProcesses(): void {
  for (const handle of [...active.values()]) {
    handle.kill()
  }
  active.clear()
}

export function getActiveAcpProcess(runtimeId: string, scopeKey?: string): SpawnedAcpProcess | undefined {
  return active.get(processKey(runtimeId, scopeKey))
}

/** 当前仍存活的温进程 runtime 清单（调试/测试用，不暴露 child 句柄细节）。 */
export function listLiveAcpRuntimeIds(): string[] {
  const ids = new Set<string>()
  for (const handle of active.values()) {
    if (isSpawnedAcpProcessAlive(handle)) ids.add(handle.runtimeId)
  }
  return [...ids].sort()
}

export interface LiveAcpProcessQuery {
  /** 宿主作用域键（与 spawn 时一致；缺席=单宿主默认） */
  scopeKey?: string
  /** 执行环境标记（宿主计算后传入；不一致不复用） */
  executionContext?: string
  /** 应用资源绑定标签（要求时不一致即视为无温进程） */
  expectedTag?: string | null
}

/**
 * 取仍存活的常驻进程（复用时用）。已退出或被外部杀掉的返回 undefined，
 * 调用方应走冷启动并顺手清扫其残留临时目录。
 * 作用域/执行环境/绑定标签任一不匹配即视为无温进程；不要求标签时沿旧语义
 * 复用（含无标签的老进程）。
 */
export function getLiveAcpProcess(
  runtimeId: string,
  query: LiveAcpProcessQuery = {},
): SpawnedAcpProcess | undefined {
  const key = processKey(runtimeId, query.scopeKey)
  const handle = active.get(key)
  if (!handle) return undefined
  if (!isSpawnedAcpProcessAlive(handle)) {
    active.delete(key)
    return undefined
  }
  if (query.executionContext !== undefined && (handle.executionContext ?? null) !== query.executionContext) {
    return undefined
  }
  if (query.expectedTag !== undefined && (handle.profileTag ?? null) !== query.expectedTag) return undefined
  return handle
}

export type ReuseAcpProcessResult =
  | { status: 'hit'; handle: SpawnedAcpProcess }
  | { status: 'miss' }
  | { status: 'busy'; handle: SpawnedAcpProcess }

/**
 * 标签感知复用裁决（连接层调用，替代裸 get + 自行 kill）：
 * - 无存活进程 → miss（调用方冷启动）；
 * - 标签一致 → hit（直接复用，不杀）；
 * - 标签不一致但旧进程正忙（isBusy 为真）→ busy（沿用旧进程，不杀不断，
 *   调用方降级兼容，新标签下次冷启动生效）；
 * - 标签不一致且空闲 → 杀旧进程后 miss（调用方冷启动）。
 * 不要求标签时等价于旧 getLive 语义。
 */
export function tryReuseLiveAcpProcess(
  runtimeId: string,
  query: LiveAcpProcessQuery & { isBusy?: (handle: SpawnedAcpProcess) => boolean } = {},
): ReuseAcpProcessResult {
  const hit = getLiveAcpProcess(runtimeId, query)
  if (hit) return { status: 'hit', handle: hit }
  if (query.expectedTag === undefined) return { status: 'miss' }
  const stale = getLiveAcpProcess(runtimeId, { scopeKey: query.scopeKey, executionContext: query.executionContext })
  if (!stale) return { status: 'miss' }
  if (query.isBusy?.(stale)) return { status: 'busy', handle: stale }
  stale.kill()
  return { status: 'miss' }
}
