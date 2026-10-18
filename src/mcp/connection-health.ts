/** A host observation of MCP discovery/transport, independent of ACP and any UI. */
export interface AcpMcpHealthMonitor {
  readonly discoveries: number
  readonly disconnects: number
  readonly hasDiscoveredClient: boolean
  waitForDiscovery(after: number, signal: AbortSignal, timeoutMs?: number): Promise<void>
}

/** Call discovered after tools/list succeeds, and closed when its transport closes. */
export class McpConnectionHealth implements AcpMcpHealthMonitor {
  private clients = new Set<object>()
  private listeners = new Set<() => void>()
  private discoveryCount = 0
  private disconnectCount = 0

  get discoveries(): number { return this.discoveryCount }
  get disconnects(): number { return this.disconnectCount }
  get hasDiscoveredClient(): boolean { return this.clients.size > 0 }

  discovered(client: object): void {
    this.clients.add(client)
    ++this.discoveryCount
    for (const listener of this.listeners) listener()
  }

  closed(client: object): void {
    if (this.clients.delete(client)) ++this.disconnectCount
  }

  needsRecovery(since: number): boolean { return this.disconnectCount > since }

  waitForDiscovery(after: number, signal: AbortSignal, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.listeners.delete(check)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => { cleanup(); reject(new Error('MCP discovery cancelled')) }
      const check = () => {
        if (this.discoveries <= after || !this.hasDiscoveredClient) return
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for the agent to rediscover MCP tools; reconnect the agent'))
      }, timeoutMs)
      this.listeners.add(check)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else check()
    })
  }
}
