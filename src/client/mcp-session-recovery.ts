import { requestSessionWithResources } from './session-open'
import type { AcpMcpHealthMonitor } from '../mcp/connection-health'

export class AcpMcpRecoveryCancelledError extends Error {}
class RecoveryInvariantError extends Error {}

export interface AcpMcpRecoveryEvent {
  type: 'started' | 'failed' | 'discovered' | 'cancelled'
  sessionId: string
  method?: string
}

export interface AcpMcpRecoveryOptions {
  request: AcpMcpRecoveryRequest
  getCapabilities: () => { resume: boolean; load: boolean }
  isConnected: () => boolean
  isBusy?: (sessionId: string) => boolean
  onSuppressUpdates?: (suppress: boolean) => void
  onEvent?: (event: AcpMcpRecoveryEvent) => void
  discoveryTimeoutMs?: number
  requestTimeoutMs?: number
}

export type AcpMcpRecoveryRequest = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>

export interface AcpMcpSessionBinding {
  sessionId: string
  cwd: string
  mcpServers: unknown[]
  sessionMeta?: Record<string, unknown>
  monitor: AcpMcpHealthMonitor
}
interface Binding extends AcpMcpSessionBinding { disconnects: number }

/** One manager per ACP connection owner. Does not own MCP transports or send prompts. */
export class AcpMcpSessionRecovery {
  private readonly sessions = new Map<string, Binding>()
  private generation = 0
  private suppressing = false
  private active?: { sessionId: string; controller: AbortController; promise: Promise<void> }

  constructor(private readonly options: AcpMcpRecoveryOptions) {}

  get isRecovering(): boolean { return Boolean(this.active) }

  register(input: AcpMcpSessionBinding): void {
    if (this.active) throw new Error('MCP recovery is in progress; wait before opening a session')
    if (!input.sessionId.trim() || !input.mcpServers.length) throw new Error('MCP recovery requires a session id and servers')
    this.sessions.set(input.sessionId, {
      ...input,
      mcpServers: structuredClone(input.mcpServers),
      sessionMeta: input.sessionMeta ? structuredClone(input.sessionMeta) : undefined,
      disconnects: input.monitor.disconnects,
    })
  }

  cancel(sessionId?: string): void {
    if (sessionId === undefined || this.active?.sessionId === sessionId) this.active?.controller.abort()
  }

  reset(): void {
    ++this.generation
    this.cancel()
    this.active = undefined
    this.sessions.clear()
    if (this.suppressing) {
      this.suppressing = false
      this.options.onSuppressUpdates?.(false)
    }
  }

  ensureReady(sessionId: string): Promise<void> {
    if (this.active) {
      return this.active.sessionId === sessionId ? this.active.promise
        : Promise.reject(new Error('Another session is recovering MCP tools; retry shortly'))
    }
    const binding = this.sessions.get(sessionId)
    if (!binding || binding.monitor.disconnects <= binding.disconnects) return Promise.resolve()
    const controller = new AbortController()
    const generation = this.generation
    // Publish the reservation before starting callbacks or RPC (including synchronous reentry).
    const promise = Promise.resolve().then(() => this.recover(binding, controller, generation))
    const active = { sessionId, controller, promise }
    this.active = active
    void promise.finally(() => { if (this.active === active) this.active = undefined }).catch(() => undefined)
    return promise
  }

  private emit(event: AcpMcpRecoveryEvent): void {
    try { this.options.onEvent?.(event) } catch { /* Diagnostics must not change recovery. */ }
  }

  private async recover(binding: Binding, controller: AbortController, generation: number): Promise<void> {
    const { sessionId, monitor } = binding
    const valid = () => {
      if (controller.signal.aborted || generation !== this.generation || !this.options.isConnected()) {
        throw new AcpMcpRecoveryCancelledError('MCP recovery cancelled or ACP connection changed')
      }
    }
    let suppressed = false
    try {
      valid()
      if (this.options.isBusy?.(sessionId)) throw new Error('Agent is processing a prompt; retry MCP recovery shortly')
      const caps = this.options.getCapabilities()
      const methods = [...(caps.resume ? ['session/resume'] : []), ...(caps.load ? ['session/load'] : [])]
      if (!methods.length) throw new Error('MCP disconnected and the agent cannot restore this session; reconnect the agent')
      this.emit({ type: 'started', sessionId })
      suppressed = true
      this.suppressing = true
      this.options.onSuppressUpdates?.(true)
      for (const method of methods) {
        valid()
        const after = monitor.discoveries
        try {
          const opened = await requestSessionWithResources(
            (rpc, params) => this.boundedRequest(rpc, params, controller.signal),
            method,
            { sessionId, cwd: binding.cwd, mcpServers: structuredClone(binding.mcpServers) },
            binding.sessionMeta ? structuredClone(binding.sessionMeta) : undefined,
          )
          valid()
          if (typeof opened.result.sessionId === 'string' && opened.result.sessionId !== sessionId) {
            throw new RecoveryInvariantError('Agent restored a different session; reconnect the original session')
          }
          if (binding.sessionMeta?.toolsMode === 'ptc' && !opened.nativeSessionAccepted) {
            throw new RecoveryInvariantError('Agent rejected Code mode during recovery; reconnect the agent')
          }
          const timeoutMs = this.options.discoveryTimeoutMs ?? 10_000
          await this.bounded(
            (signal) => monitor.waitForDiscovery(after, signal, timeoutMs),
            controller.signal, timeoutMs, 'Timed out waiting for the agent to rediscover MCP tools',
          )
          valid()
          if (!monitor.hasDiscoveredClient) throw new Error('MCP transport closed again during recovery')
          binding.disconnects = monitor.disconnects
          this.emit({ type: 'discovered', sessionId, method })
          return
        } catch (error) {
          valid()
          this.emit({ type: 'failed', sessionId, method })
          if (error instanceof RecoveryInvariantError) throw error
          if (method === methods.at(-1)) {
            throw new Error(`MCP recovery failed; reconnect the agent: ${error instanceof Error ? error.message : 'unknown error'}`)
          }
        }
      }
    } catch (error) {
      if (error instanceof AcpMcpRecoveryCancelledError) this.emit({ type: 'cancelled', sessionId })
      throw error
    } finally {
      if (suppressed && generation === this.generation) {
        this.suppressing = false
        this.options.onSuppressUpdates?.(false)
      }
    }
  }

  private boundedRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.bounded(
      (requestSignal) => this.options.request(method, params, requestSignal), signal,
      this.options.requestTimeoutMs ?? 120_000, 'ACP MCP recovery request timed out',
    )
  }

  private bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        callback()
      }
      const abort = () => finish(() => {
        controller.abort()
        reject(new AcpMcpRecoveryCancelledError('MCP recovery cancelled'))
      })
      const timer = setTimeout(() => finish(() => {
        controller.abort()
        reject(new Error(message))
      }), timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new AcpMcpRecoveryCancelledError('MCP recovery cancelled')
        return operation(controller.signal)
      }).then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      )
    })
  }
}
