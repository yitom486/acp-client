#!/usr/bin/env node
import * as readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { ACP_CLIENT_VERSION } from '../version'
import {
  AcpClient,
  AcpSessionHandle,
  BUILTIN_ACP_RUNTIMES,
  getAcpRuntimeAdapter,
  isAcpPermissionOutcome,
  parseAcpConfigOptions,
  type AcpConnectionStatus,
  type AcpPermissionOutcome,
} from '../index'

// Redirect standard console.log/info/warn to stderr to keep stdout strictly for JSON-RPC
console.log = (...args) => console.error('[acp-engine:log]', ...args)
console.info = (...args) => console.error('[acp-engine:info]', ...args)
console.warn = (...args) => console.error('[acp-engine:warn]', ...args)

function sendNotification(method: string, params: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function sendResponse(id: string | number, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function sendError(id: string | number | null, code: number, message: string, data?: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }) + '\n')
}

let client: AcpClient | null = null
let connectionGeneration = 0
const activeSessions = new Map<string, AcpSessionHandle>()
type PermissionCancellation = 'agent_cancelled' | 'session_cancelled' | 'connection_closed' | 'timeout'
const pendingPermissions = new Map<string, {
  params: Record<string, unknown>
  finish: (outcome: AcpPermissionOutcome, reason?: PermissionCancellation) => void
}>()
let suppressUpdates = false

function cancelPermissionsOnDisconnect() {
  for (const pending of pendingPermissions.values()) {
    pending.finish({ outcome: 'cancelled' }, 'connection_closed')
  }
}

function detachClient() {
  const previous = client
  client = null
  activeSessions.clear()
  cancelPermissionsOnDisconnect()
  return previous
}

function extractModelOptions(rawConfigOptions: unknown) {
  const parsed = parseAcpConfigOptions(rawConfigOptions)
  let currentModelId: string | null = null
  let currentReasoningEffort: string | null = null
  const models: Array<{ value: string; name: string; description?: string }> = []
  const extraOptions: Array<any> = []

  for (const opt of parsed) {
    if (opt.configId === 'model') {
      currentModelId = typeof opt.currentValue === 'string' ? opt.currentValue : null
      if (opt.options) {
        for (const item of opt.options) {
          models.push({
            value: item.value,
            name: item.name,
            description: item.description,
          })
        }
      }
    } else if (opt.configId === 'reasoning_effort') {
      currentReasoningEffort = typeof opt.currentValue === 'string' ? opt.currentValue : null
      extraOptions.push({
        id: opt.configId,
        name: opt.name,
        kind: {
          Select: {
            current: currentReasoningEffort,
            options: (opt.options ?? []).map((o) => ({
              value: o.value,
              name: o.name,
              description: o.description,
            })),
          },
        },
      })
    } else {
      if (opt.type === 'boolean') {
        extraOptions.push({
          id: opt.configId,
          name: opt.name,
          kind: {
            Boolean: {
              current: Boolean(opt.currentValue),
            },
          },
        })
      } else if (opt.options && opt.options.length > 0) {
        extraOptions.push({
          id: opt.configId,
          name: opt.name,
          kind: {
            Select: {
              current: typeof opt.currentValue === 'string' ? opt.currentValue : null,
              options: opt.options.map((o) => ({
                value: o.value,
                name: o.name,
                description: o.description,
              })),
            },
          },
        })
      }
    }
  }

  return {
    current_model_id: currentModelId,
    current_reasoning_effort: currentReasoningEffort,
    models,
    extra_options: extraOptions,
  }
}

async function handleRpcRequest(id: string | number, method: string, params: any) {
  switch (method) {
    case 'ping': {
      sendResponse(id, { message: 'pong', timestamp: Date.now() })
      break
    }

    case 'runtimes/list': {
      const runtimes = BUILTIN_ACP_RUNTIMES.map((r) => {
        const adapter = getAcpRuntimeAdapter(r.id)
        const auth = adapter.probeAuth()
        return {
          id: r.id,
          name: r.name,
          looksLoggedIn: auth.looksLoggedIn,

        }
      })
      sendResponse(id, { runtimes })
      break
    }

    case 'status/get': {
      let activeSessionId: string | null = null
      let modelOptions: any = null
      for (const [sId, handle] of activeSessions.entries()) {
        activeSessionId = sId
        if (handle.configOptions) {
          modelOptions = extractModelOptions(handle.configOptions)
        }
        break
      }
      sendResponse(id, {
        status: client?.currentStatus ?? 'disconnected',
        connected: client?.currentStatus === 'connected',
        sessionId: activeSessionId,
        modelOptions,
      })
      break
    }

    case 'client/connect': {
      const generation = ++connectionGeneration
      try {
        try {
          await detachClient()?.disconnect()
        } catch {
          // A connection can still be replaced when cleanup reports an error.
        }
        if (generation !== connectionGeneration) {
          sendError(id, -32800, 'Connection request superseded')
          return
        }

        const { runtime, workspaceRoot, clientInfo, dataDir, proxy, env, customCommand, customArgs } = params ?? {}
        const next = new AcpClient({
          runtime: customCommand
            ? {
                id: runtime ?? 'custom',
                name: runtime ?? 'Custom Agent',
                description: 'Custom command launched via Dawnsight',
                command: customCommand,
                args: Array.isArray(customArgs) ? customArgs : [],
                requiredEnvKeys: [],
              }
            : runtime ?? 'codex-acp',
          workspaceRoot: workspaceRoot ?? process.cwd(),
          clientInfo: clientInfo ?? { name: 'dawnsight-desktop', version: '0.4.0' },
          dataDir,
          proxy,
          env,
          callbacks: {
            onStatusChange: (status: AcpConnectionStatus, detail?: string) => {
              if (generation !== connectionGeneration) return
              if (status === 'disconnected') cancelPermissionsOnDisconnect()
              sendNotification('status/change', { status, detail })
            },
            onSessionUpdate: (update: Record<string, unknown>) => {
              if (generation !== connectionGeneration) return
              if (suppressUpdates) {
                sendNotification('session/update', { ...update, suppressed: true })
              } else {
                sendNotification('session/update', update)
              }
            },
            onStderrLine: (line: string) => {
              if (generation !== connectionGeneration) return
              sendNotification('stderr/line', { line })
            },
            onPermissionRequest: async ({ sessionId, toolCall, params: permParams, signal }) => {
              if (generation !== connectionGeneration || signal.aborted) return { outcome: 'cancelled' }
              const requestId = `req_${randomUUID()}`
              return new Promise<AcpPermissionOutcome>((resolve) => {
                const finish = (outcome: AcpPermissionOutcome, reason?: PermissionCancellation) => {
                  if (!pendingPermissions.delete(requestId)) return
                  clearTimeout(timer)
                  signal.removeEventListener('abort', onAbort)
                  if (reason) sendNotification('permission/cancelled', { requestId, sessionId, reason })
                  resolve(outcome)
                }
                const onAbort = () => finish({ outcome: 'cancelled' },
                  signal.reason === 'session_cancelled' || signal.reason === 'connection_closed' ? signal.reason : 'agent_cancelled')
                const timer = setTimeout(() => finish({ outcome: 'cancelled' }, 'timeout'), 120_000)
                timer.unref()
                pendingPermissions.set(requestId, { params: permParams, finish })
                signal.addEventListener('abort', onAbort, { once: true })
                sendNotification('permission/request', {
                  requestId, sessionId, toolCall, params: permParams, options: permParams.options,
                })
              })
            },
            onLog: (level, msg, meta) => {
              console.error(`[acp:${level}]`, msg, meta ?? '')
            },
          },
        })
        client = next

        const connectResult = await next.connect()
        if (generation !== connectionGeneration) {
          sendError(id, -32800, 'Connection request superseded')
          return
        }
        if (!connectResult.ok) {
          sendError(id, -32001, connectResult.error.message, connectResult.error)
          return
        }

        sendResponse(id, {
          success: true,
          status: next.currentStatus,
          initResponse: connectResult.value.init,
        })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'client/authenticate': {
      if (!client) {
        sendError(id, -32002, 'Client not connected')
        return
      }
      const { methodId } = params ?? {}
      if (typeof methodId !== 'string' || !methodId.trim()) {
        sendError(id, -32602, 'client/authenticate needs a methodId')
        return
      }
      const result = await client.authenticate(methodId)
      if (!result.ok) {
        sendError(id, result.error.code === 'INVALID_ARGUMENT' ? -32602 : -32000, result.error.message, result.error)
        return
      }
      sendResponse(id, { success: true })
      break
    }

    case 'session/open': {
      try {
        const current = client
        if (!current) {
          sendError(id, -32002, 'Client not connected')
          return
        }

        const { resumeSessionId, mcpServers } = params ?? {}
        const sessionResult = await current.createSession({
          resumeSessionId: resumeSessionId ?? null,
          mcpServers: mcpServers ?? [],
        })

        if (!sessionResult.ok) {
          sendError(id, sessionResult.error.code === 'UNAUTHORIZED' ? -32000 : -32003, sessionResult.error.message, sessionResult.error)
          return
        }

        const handle = sessionResult.value
        const availableCommands = await current.waitForAvailableCommands(handle.sessionId, 150)
        if (client !== current || !current.isConnected) {
          sendError(id, -32800, 'Connection changed while opening session')
          return
        }
        activeSessions.set(handle.sessionId, handle)
        sendResponse(id, {
          sessionId: handle.sessionId,
          restoreMethod: handle.restoreMethod,
          ...(availableCommands ? { availableCommands } : {}),
          configOptions: handle.configOptions,
          modelOptions: extractModelOptions(handle.configOptions),
        })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/prompt': {
      try {
        const { sessionId, promptText, timeoutMs, images } = params ?? {}
        const session = activeSessions.get(sessionId)
        if (!session) {
          sendError(id, -32004, `Session ${sessionId} not found`)
          return
        }

        const promptResult = await session.prompt(promptText, { timeoutMs, images })
        if (!promptResult.ok) {
          sendError(id, promptResult.error.code === 'UNAUTHORIZED' ? -32000 : -32005, promptResult.error.message, promptResult.error)
          return
        }

        sendResponse(id, { result: promptResult.value })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'agent/request': {
      // Generic passthrough for agent-side methods the engine has no dedicated
      // wrapper for (e.g. `session/load` transcript replay). Streaming
      // `session/update` notifications keep flowing to the host, which
      // correlates them with this request id.
      try {
        if (!client) {
          sendError(id, -32002, 'Client not connected')
          return
        }
        const { method: agentMethod, params: agentParams } = params ?? {}
        if (typeof agentMethod !== 'string' || !agentMethod) {
          sendError(id, -32602, 'agent/request needs a method string')
          return
        }
        const agent = (client as any).sdkConnection?.agent
        if (!agent) {
          sendError(id, -32002, 'Agent connection not available')
          return
        }
        const result = await agent.request(agentMethod, agentParams ?? {})
        sendResponse(id, { result: result ?? null })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/set_config': {
      try {
        const { sessionId, configId, value } = params ?? {}
        const session = activeSessions.get(sessionId)
        if (!session) {
          sendError(id, -32004, `Session ${sessionId} not found`)
          return
        }

        const res = await session.setConfigOption(configId, value)
        if (!res.ok) {
          sendError(id, -32006, res.error.message, res.error)
          return
        }

        const rawUpdated = (res.value as any)?.configOptions ?? (res.value as any)
        const modelOptions = extractModelOptions(rawUpdated)

        sendResponse(id, {
          result: res.value,
          modelOptions,
        })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/list': {
      try {
        if (!client) {
          sendError(id, -32002, 'Client not connected')
          return
        }
        const { cwd, cursor } = params ?? {}
        const agent = (client as any).sdkConnection?.agent
        if (!agent) {
          sendError(id, -32002, 'Agent connection not available')
          return
        }
        const listResp = await agent.request('session/list', { cwd, cursor })
        sendResponse(id, {
          sessions: listResp?.sessions ?? [],
          cursor: listResp?.cursor ?? null,
          verified: true,
        })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/delete': {
      try {
        if (!client) {
          sendError(id, -32002, 'Client not connected')
          return
        }
        const { sessionId } = params ?? {}
        const agent = (client as any).sdkConnection?.agent
        if (agent && sessionId) {
          await agent.request('session/delete', { sessionId })
        }
        activeSessions.delete(sessionId)
        sendResponse(id, { success: true })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/quota': {
      const { sessionId } = params ?? {}
      if (!client) {
        sendError(id, -32002, 'Client not connected')
        return
      }
      try {
        const quota = await client.getQuota(sessionId ? String(sessionId) : undefined)
        sendResponse(id, { sessionId, quota })
      } catch (err) {
        sendError(id, -32000, err instanceof Error ? err.message : String(err))
      }
      break
    }

    case 'session/commands': {
      // Latest available_commands_update for a session (null = none received yet).
      const { sessionId } = params ?? {}
      if (!client) {
        sendError(id, -32002, 'Client not connected')
        return
      }
      sendResponse(id, { sessionId, availableCommands: client.getAvailableCommands(String(sessionId ?? '')) ?? null })
      break
    }

    case 'session/cancel': {
      const { sessionId } = params ?? {}
      if (!client) {
        sendError(id, -32002, 'Client not connected')
        return
      }
      if (typeof sessionId !== 'string' || !sessionId) {
        sendError(id, -32602, 'session/cancel needs a sessionId')
        return
      }
      const result = await client.cancelSession(sessionId)
      if (!result.ok) {
        sendError(id, -32000, result.error.message, result.error)
        return
      }
      sendResponse(id, { success: true })
      break
    }

    case 'permission/respond': {
      const { requestId, outcome } = params ?? {}
      const pending = pendingPermissions.get(requestId)
      if (!pending) {
        sendError(id, -32007, `Permission request ${requestId} not found`)
        return
      }
      const selection = outcome ?? { outcome: 'cancelled' }
      if (!isAcpPermissionOutcome(selection, pending.params)) {
        sendError(id, -32602, 'Choose an option offered for this permission request or cancel it')
        return
      }
      pending.finish(selection)
      sendResponse(id, { success: true })
      break
    }

    case 'client/disconnect': {
      const generation = ++connectionGeneration
      try {
        await detachClient()?.disconnect()
        if (generation === connectionGeneration) sendNotification('status/change', { status: 'disconnected' })
        sendResponse(id, { success: true })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    default: {
      sendError(id, -32601, `Method ${method} not found`)
      break
    }
  }
}

function startSidecar() {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  })

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const msg = JSON.parse(trimmed)
      if (msg.id !== undefined && msg.method) {
        await handleRpcRequest(msg.id, msg.method, msg.params)
      } else if (msg.method) {
        console.error('[acp-engine] received notification:', msg.method)
      }
    } catch (parseErr: any) {
      sendError(null, -32700, 'Parse error: ' + parseErr?.message)
    }
  })

  rl.on('close', async () => {
    console.error('[acp-engine] stdin closed, terminating sidecar...')
    ++connectionGeneration
    try { await detachClient()?.disconnect() } catch {}
    process.exit(0)
  })

  sendNotification('ready', {
    version: ACP_CLIENT_VERSION,
    platform: process.platform,
    pid: process.pid,
  })
}

startSidecar()
