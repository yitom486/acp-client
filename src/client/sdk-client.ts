import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'
import {
  client as createSdkClientApp,
  ndJsonStream,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type Stream,
} from '@agentclientprotocol/sdk'

/** SDK 控制面请求默认超时：120s */
export const ACP_SDK_REQUEST_TIMEOUT_MS = 120_000
/** 长流式 Prompt 默认静默超时：连续 5 分钟无任何事件/FS/终端/权限活动才超时 */
export const ACP_PROMPT_IDLE_TIMEOUT_MS = 300_000
/** 长流式 Prompt 默认最大总时长上限：0 表示不限（仅受静默超时约束） */
export const ACP_PROMPT_MAX_DURATION_MS = 0
const MAX_SAFE_TIMER_MS = 2_147_483_647

export type SdkRequestTimeoutKind = 'timeout' | 'idle' | 'max_duration'

export class SdkRequestTimeoutError extends Error {
  readonly kind: SdkRequestTimeoutKind
  readonly method: string
  readonly durationMs: number

  constructor(kind: SdkRequestTimeoutKind, method: string, durationMs: number) {
    const secs = Math.max(1, Math.round(durationMs / 1000))
    const message =
      kind === 'idle'
        ? `请求超时 (${secs}s 无活动): ${method}`
        : kind === 'max_duration'
          ? `请求超时 (超过最大时长 ${secs}s): ${method}`
          : `请求超时: ${method}`
    super(message)
    this.name = 'SdkRequestTimeoutError'
    this.kind = kind
    this.method = method
    this.durationMs = durationMs
  }
}

export interface SdkRequestActivityController {
  /** 重置静默超时计时器（例如收到 session/update、fs、terminal 输出） */
  touch(): void
  /** 暂停静默超时计时器（如等待用户权限审批），返回幂等恢复函数 */
  pause(): () => void
}

interface ActivitySubscriber {
  onTouch(): void
  onPauseChange(paused: boolean): void
}

const activitySubscribers = new WeakMap<
  SdkRequestActivityController,
  { subscribers: Set<ActivitySubscriber>; isPaused: () => boolean }
>()

export function createSdkRequestActivityController(): SdkRequestActivityController {
  let pauseCount = 0
  const subscribers = new Set<ActivitySubscriber>()

  const controller: SdkRequestActivityController = {
    touch() {
      for (const sub of subscribers) {
        sub.onTouch()
      }
    },
    pause() {
      let released = false
      pauseCount += 1
      if (pauseCount === 1) {
        for (const sub of subscribers) {
          sub.onPauseChange(true)
        }
      }
      return () => {
        if (released) return
        released = true
        pauseCount = Math.max(0, pauseCount - 1)
        if (pauseCount === 0) {
          for (const sub of subscribers) {
            sub.onPauseChange(false)
          }
        }
      }
    },
  }

  activitySubscribers.set(controller, {
    subscribers,
    isPaused: () => pauseCount > 0,
  })

  return controller
}

export interface SdkRequestActivityOptions {
  /** 活动重置的静默超时（毫秒）；0 或未传且 maxDurationMs 存在时禁用 */
  idleTimeoutMs?: number
  /** 硬性最大总时长上限（毫秒）；0 或未传则不限制总时长 */
  maxDurationMs?: number
  /** 关联的活动控制器 */
  activity?: SdkRequestActivityController
}

function clampTimerMs(ms: number): number {
  return Math.max(1, Math.min(MAX_SAFE_TIMER_MS, Math.floor(ms)))
}

export interface SdkStreamHandle {
  stream: Stream
  /** 摘掉桥接（温进程复用时保住子进程 stdio，不关 fd） */
  dispose: () => void
}

/**
 * stdio 桥接：Node 侧先经 PassThrough 再 toWeb，最后 ndJsonStream(output, input)。
 * 注意参数序：output（写往 Agent，即 child.stdin 侧）在前，input（读自 Agent）在后。
 *
 * 垫 PassThrough 的原因：SDK connection.close() 会一路 cancel 到字节流，
 * 直连 child stdio 会把温进程的 fd 一并销毁，下次复用即死；垫层让 close
 * 只吃掉桥，child stdio 原样保留给下次 connect。
 */
export function createSdkStreamHandle(child: ChildProcessWithoutNullStreams): SdkStreamHandle {
  const stdoutBridge = new PassThrough()
  const stdinBridge = new PassThrough()
  child.stdout.pipe(stdoutBridge)
  stdinBridge.pipe(child.stdin, { end: false })
  const output = Writable.toWeb(stdinBridge) as unknown as WritableStream<Uint8Array>
  const input = Readable.toWeb(stdoutBridge) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)
  let disposed = false
  return {
    stream,
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        child.stdout.unpipe(stdoutBridge)
      } catch {
        // 忽略竞态关闭
      }
      try {
        stdinBridge.unpipe(child.stdin)
      } catch {
        // 忽略竞态关闭
      }
      try {
        stdoutBridge.destroy()
      } catch {
        // 忽略竞态关闭
      }
      try {
        stdinBridge.destroy()
      } catch {
        // 忽略竞态关闭
      }
    },
  }
}

/**
 * 长驻连接：client(...).connect()，持有 ClientConnection。
 * 不用 connectWith 作用域式；调用方用返回的 connection.agent 发请求，
 * 断开时 connection.close() 取消在途请求。
 */
export function connectSdkClient(
  child: ChildProcessWithoutNullStreams,
  configure: (app: ClientApp) => void,
  /** 所属运行时 id：仅日志/隔离用，不改变 SDK 建连形态；缺省向后兼容单 codex 路径 */
  runtimeId?: string,
  /** 客户端身份信息（默认 'acp-client'） */
  clientInfo?: { name: string; version?: string },
): { app: ClientApp; connection: ClientConnection; streamHandle: SdkStreamHandle } {
  if (runtimeId && process.env.NODE_ENV !== 'production') {
    console.info(`[acp:sdk] connect runtime=${runtimeId} pid=${child.pid ?? '?'}`)
  }
  const app = createSdkClientApp({
    name: clientInfo?.name || 'acp-client',
    ...(clientInfo?.version ? { version: clientInfo.version } : {}),
  })
  configure(app)
  const streamHandle = createSdkStreamHandle(child)
  const connection = app.connect(streamHandle.stream)
  return { app, connection, streamHandle }
}

/**
 * 支持活动静默重置 + 最大总时长上限的 agent.request：
 * - idleTimeoutMs > 0：每次收到事件（touch）自动重置倒计时；等待人工审批等 pause() 期间暂停计时；
 * - maxDurationMs > 0：可选硬性总时长天花板；
 * - 任一触发即 abort（触发 $/cancel_request）并抛出 SdkRequestTimeoutError。
 */
export async function sdkRequestWithActivity<Response, Params>(
  agent: ClientContext,
  method: string,
  params: Params,
  options: SdkRequestActivityOptions = {},
): Promise<Response> {
  const idleTimeoutMs = options.idleTimeoutMs
  const maxDurationMs = options.maxDurationMs
  const hasIdle = typeof idleTimeoutMs === 'number' && Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0
  const hasMax = typeof maxDurationMs === 'number' && Number.isFinite(maxDurationMs) && maxDurationMs > 0

  if (!hasIdle && !hasMax) {
    return await agent.request<Response, Params>(method, params)
  }

  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let rejectTimeout!: (error: SdkRequestTimeoutError) => void
  let paused = false

  const meta = options.activity ? activitySubscribers.get(options.activity) : undefined
  if (meta) paused = meta.isPaused()

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  const armIdleTimer = () => {
    clearIdleTimer()
    if (settled || paused || !hasIdle) return
    idleTimer = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort()
      rejectTimeout(new SdkRequestTimeoutError('idle', method, idleTimeoutMs!))
    }, clampTimerMs(idleTimeoutMs!))
    idleTimer.unref?.()
  }

  const subscriber: ActivitySubscriber = {
    onTouch() {
      if (!paused) armIdleTimer()
    },
    onPauseChange(nextPaused: boolean) {
      paused = nextPaused
      if (paused) {
        clearIdleTimer()
      } else {
        armIdleTimer()
      }
    },
  }

  if (meta) {
    meta.subscribers.add(subscriber)
  }

  try {
    const pending = agent.request<Response, Params>(method, params, {
      cancellationSignal: controller.signal,
    })

    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject
      if (hasIdle && !paused) {
        armIdleTimer()
      }
      if (hasMax) {
        maxTimer = setTimeout(() => {
          if (settled) return
          settled = true
          controller.abort()
          reject(new SdkRequestTimeoutError('max_duration', method, maxDurationMs!))
        }, clampTimerMs(maxDurationMs!))
        maxTimer.unref?.()
      }
    })

    return await Promise.race([pending, timeout])
  } finally {
    settled = true
    clearIdleTimer()
    if (maxTimer !== undefined) clearTimeout(maxTimer)
    if (meta) {
      meta.subscribers.delete(subscriber)
    }
  }
}

/** 带显式超时的 agent.request：超时 abort（触发 $/cancel_request）并拒绝；timeoutMs <= 0 时不设超时 */
export async function sdkRequest<Response, Params>(
  agent: ClientContext,
  method: string,
  params: Params,
  timeoutMs: number = ACP_SDK_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await agent.request<Response, Params>(method, params)
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = agent.request<Response, Params>(method, params, {
      cancellationSignal: controller.signal,
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new SdkRequestTimeoutError('timeout', method, timeoutMs))
      }, clampTimerMs(timeoutMs))
      timer.unref?.()
    })
    return await Promise.race([pending, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Close owned sessions before transport/process teardown; unsupported failures stay bounded. */
export async function closeAcpSessions(agent: ClientContext, sessionIds: Iterable<string>, timeoutMs = 2000): Promise<string[]> {
  const failed: string[] = []
  await Promise.all([...new Set(sessionIds)].map(async sessionId => {
    try { await sdkRequest(agent, 'session/close', {sessionId}, timeoutMs) }
    catch { failed.push(sessionId) }
  }))
  return failed
}
