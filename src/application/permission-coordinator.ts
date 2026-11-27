import type { AcpPermissionOutcome } from '../domain/contracts'

export type PermissionCallback = (payload: {
  sessionId?: string
  toolCall?: { id?: string; title?: string; kind?: string }
  params: Record<string, unknown>
  signal: AbortSignal
}) => Promise<AcpPermissionOutcome>

/**
 * Coordinates in-flight agent permission prompts: combines agent-side abort
 * signals with client-side session cancellation / disconnect cancellation.
 */
export class PermissionCoordinator {
  private readonly pending = new Map<AbortController, string | undefined>()

  cancel(reason: string, sessionId?: string): void {
    for (const [controller, ownerSessionId] of this.pending.entries()) {
      if (sessionId === undefined || ownerSessionId === sessionId) {
        controller.abort(reason)
      }
    }
  }

  async handleRequest(
    callback: PermissionCallback | undefined,
    payload: {
      sessionId?: string
      params: Record<string, unknown>
      signal: AbortSignal
    },
  ): Promise<AcpPermissionOutcome> {
    const cancelled: AcpPermissionOutcome = { outcome: 'cancelled' }
    if (!callback || payload.signal.aborted) return cancelled

    const controller = new AbortController()
    const signal = AbortSignal.any([payload.signal, controller.signal])
    this.pending.set(controller, payload.sessionId)

    let resolveCancellation!: (outcome: AcpPermissionOutcome) => void
    const cancellation = new Promise<AcpPermissionOutcome>((resolve) => {
      resolveCancellation = resolve
    })
    const onAbort = () => resolveCancellation(cancelled)
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const toolCall = (payload.params as { toolCall?: { id?: string; title?: string; kind?: string } })?.toolCall
      const outcome = await Promise.race([
        cancellation,
        callback({
          sessionId: payload.sessionId,
          toolCall,
          params: payload.params,
          signal,
        }),
      ])
      return signal.aborted ? cancelled : outcome
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.pending.delete(controller)
    }
  }
}
