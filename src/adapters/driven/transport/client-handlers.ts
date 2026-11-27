import { methods, RequestError, type ClientApp } from '@agentclientprotocol/sdk'
import type { AcpPermissionOutcome } from '../../../domain/contracts'
import { isAcpPermissionOutcome, pickAllowOptionId } from '../../../domain/session/permission'
import type { AgentTransportHandlers, HostFsPort, HostTerminalPort } from '../../../ports'

export { isAcpPermissionOutcome, pickAllowOptionId }

export interface AcpClientHandlerDeps extends AgentTransportHandlers {
  fs: HostFsPort
  terminals: HostTerminalPort
}

function toInvalidParams(message: string): RequestError {
  return RequestError.invalidParams(undefined, message)
}

function toServerError(error: unknown, fallback: string): RequestError {
  return new RequestError(-32000, error instanceof Error ? error.message : fallback)
}

/**
 * Registers Agent -> Client JSON-RPC callbacks (permission, fs, terminal,
 * session/update) onto the official `@agentclientprotocol/sdk` ClientApp.
 */
export function registerAcpClientHandlers(app: ClientApp, deps: AcpClientHandlerDeps): void {
  app.onRequest(methods.client.session.requestPermission, async (ctx) => {
    const params = ctx.params as unknown as Record<string, unknown>
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    deps.onActivity?.(sessionId)
    const resumeActivity = deps.onPauseActivity?.(sessionId)
    try {
      const outcome = await deps.onPermission({
        sessionId,
        params,
        signal: ctx.signal,
      })
      return {
        outcome:
          !ctx.signal.aborted && isAcpPermissionOutcome(outcome, params)
            ? outcome
            : ({ outcome: 'cancelled' } as AcpPermissionOutcome),
      }
    } catch (error) {
      console.error('[acp] request_permission 失败', error)
      return { outcome: { outcome: 'cancelled' } as AcpPermissionOutcome }
    } finally {
      resumeActivity?.()
      deps.onActivity?.(sessionId)
    }
  })

  app.onRequest(methods.client.fs.readTextFile, async (ctx) => {
    const workspaceRoot = deps.getWorkspaceRoot()
    const filePath = ctx.params.path
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!workspaceRoot || !filePath) {
      throw toInvalidParams('fs/read_text_file 需要 path 与已连接工作区')
    }
    try {
      return await deps.fs.readTextFile({
        path: filePath,
        workspaceRoot,
        line: ctx.params.line ?? undefined,
        limit: ctx.params.limit ?? undefined,
        maxReadBytes: deps.maxReadBytes,
      })
    } catch (error) {
      throw toServerError(error, '读取文件失败')
    }
  })

  app.onRequest(methods.client.fs.writeTextFile, async (ctx) => {
    const workspaceRoot = deps.getWorkspaceRoot()
    const filePath = ctx.params.path
    const content = ctx.params.content
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!workspaceRoot || !filePath || typeof content !== 'string') {
      throw toInvalidParams('fs/write_text_file 需要 path、content 与已连接工作区')
    }
    try {
      return await deps.fs.writeTextFile({ path: filePath, content, workspaceRoot })
    } catch (error) {
      throw toServerError(error, '写入文件失败')
    }
  })

  app.onRequest(methods.client.terminal.create, async (ctx) => {
    const workspaceRoot = deps.getWorkspaceRoot()
    const sessionId = ctx.params.sessionId
    const command = ctx.params.command
    deps.onActivity?.(sessionId)
    if (!workspaceRoot || !sessionId || !command) {
      throw toInvalidParams('terminal/create 需要 sessionId、command 与已连接工作区')
    }
    try {
      return deps.terminals.create({
        sessionId,
        command,
        args: ctx.params.args ?? undefined,
        env: ctx.params.env ?? undefined,
        cwd: ctx.params.cwd ?? undefined,
        outputByteLimit: ctx.params.outputByteLimit ?? undefined,
        workspaceRoot,
      })
    } catch (error) {
      throw toServerError(error, '创建终端失败')
    }
  })

  app.onRequest(methods.client.terminal.output, async (ctx) => {
    const terminalId = ctx.params.terminalId
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!terminalId) throw toInvalidParams('terminal/output 需要 terminalId')
    try {
      return deps.terminals.getOutput(terminalId)
    } catch (error) {
      throw toServerError(error, '读取终端输出失败')
    }
  })

  app.onRequest(methods.client.terminal.waitForExit, async (ctx) => {
    const terminalId = ctx.params.terminalId
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!terminalId) throw toInvalidParams('terminal/wait_for_exit 需要 terminalId')
    try {
      return await deps.terminals.waitForExit(terminalId)
    } catch (error) {
      throw toServerError(error, '等待终端退出失败')
    }
  })

  app.onRequest(methods.client.terminal.kill, async (ctx) => {
    const terminalId = ctx.params.terminalId
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!terminalId) throw toInvalidParams('terminal/kill 需要 terminalId')
    try {
      return deps.terminals.kill(terminalId)
    } catch (error) {
      throw toServerError(error, '终止终端失败')
    }
  })

  app.onRequest(methods.client.terminal.release, async (ctx) => {
    const terminalId = ctx.params.terminalId
    const sessionId =
      typeof (ctx.params as { sessionId?: unknown })?.sessionId === 'string'
        ? (ctx.params as { sessionId: string }).sessionId
        : undefined
    deps.onActivity?.(sessionId)
    if (!terminalId) throw toInvalidParams('terminal/release 需要 terminalId')
    try {
      return deps.terminals.release(terminalId)
    } catch (error) {
      throw toServerError(error, '释放终端失败')
    }
  })

  app.onNotification(methods.client.session.update, async (ctx) => {
    deps.onActivity?.(ctx.params.sessionId)
    deps.onSessionUpdate({
      sessionId: ctx.params.sessionId,
      update: ctx.params.update,
    } as unknown as Record<string, unknown>)
  })
}
