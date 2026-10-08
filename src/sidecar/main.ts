#!/usr/bin/env node
import * as readline from 'node:readline'
import {
  AcpClient,
  AcpSessionHandle,
  BUILTIN_ACP_RUNTIMES,
  getAcpRuntimeAdapter,
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
const activeSessions = new Map<string, AcpSessionHandle>()
const pendingPermissions = new Map<string, (outcome: AcpPermissionOutcome) => void>()
let suppressUpdates = false

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
      try {
        if (client) {
          try {
            await client.disconnect()
          } catch {
            // Ignore previous disconnect failure
          }
          client = null
          activeSessions.clear()
        }

        const { runtime, workspaceRoot, clientInfo, dataDir, proxy, env, customCommand, customArgs } = params ?? {}
        client = new AcpClient({
          runtime: customCommand
            ? {
                id: runtime ?? 'custom',
                name: runtime ?? 'Custom Agent',
                description: 'Custom command launched via Dawnsight',
                command: customCommand,
                args: Array.isArray(customArgs) ? customArgs : [],
              }
            : runtime ?? 'codex-acp',
          workspaceRoot: workspaceRoot ?? process.cwd(),
          clientInfo: clientInfo ?? { name: 'dawnsight-desktop', version: '0.4.0' },
          dataDir,
          proxy,
          env,
          callbacks: {
            onStatusChange: (status: AcpConnectionStatus, detail?: string) => {
              sendNotification('status/change', { status, detail })
            },
            onSessionUpdate: (update: Record<string, unknown>) => {
              if (suppressUpdates) {
                sendNotification('session/update', { ...update, suppressed: true })
              } else {
                sendNotification('session/update', update)
              }
            },
            onStderrLine: (line: string) => {
              sendNotification('stderr/line', { line })
            },
            onPermissionRequest: async ({ sessionId, toolCall, params: permParams }) => {
              const requestId = 'req_' + Math.random().toString(36).slice(2, 10)
              sendNotification('permission/request', {
                requestId,
                sessionId,
                toolCall,
                params: permParams,
              })

              return new Promise<AcpPermissionOutcome>((resolve) => {
                const timer = setTimeout(() => {
                  pendingPermissions.delete(requestId)
                  resolve({ outcome: 'cancelled' })
                }, 120_000)

                pendingPermissions.set(requestId, (outcome) => {
                  clearTimeout(timer)
                  resolve(outcome)
                })
              })
            },
            onLog: (level, msg, meta) => {
              console.error(`[acp:${level}]`, msg, meta ?? '')
            },
          },
        })

        const connectResult = await client.connect()
        if (!connectResult.ok) {
          sendError(id, -32001, connectResult.error.message, connectResult.error)
          return
        }

        sendResponse(id, {
          success: true,
          status: client.currentStatus,
          initResponse: client.initializeResponse,
        })
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'session/open': {
      try {
        if (!client) {
          sendError(id, -32002, 'Client not connected')
          return
        }

        const { resumeSessionId, mcpServers } = params ?? {}
        const sessionResult = await client.createSession({
          resumeSessionId: resumeSessionId ?? null,
          mcpServers: mcpServers ?? [],
        })

        if (!sessionResult.ok) {
          sendError(id, -32003, sessionResult.error.message, sessionResult.error)
          return
        }

        const handle = sessionResult.value
        activeSessions.set(handle.sessionId, handle)

        sendResponse(id, {
          sessionId: handle.sessionId,
          restoreMethod: handle.restoreMethod,
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
          sendError(id, -32005, promptResult.error.message, promptResult.error)
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

    case 'session/cancel': {
      try {
        const { sessionId } = params ?? {}
        if (client && (client as any).sdkConnection?.agent) {
          const agent = (client as any).sdkConnection.agent
          await agent.request('session/cancel', { sessionId })
          sendResponse(id, { success: true })
        } else {
          sendError(id, -32002, 'Client not connected')
        }
      } catch (err: any) {
        sendError(id, -32000, err?.message ?? String(err))
      }
      break
    }

    case 'permission/respond': {
      const { requestId, outcome } = params ?? {}
      const resolver = pendingPermissions.get(requestId)
      if (resolver) {
        pendingPermissions.delete(requestId)
        resolver(outcome ?? { outcome: 'cancelled' })
        sendResponse(id, { success: true })
      } else {
        sendError(id, -32007, `Permission request ${requestId} not found`)
      }
      break
    }

    case 'client/disconnect': {
      try {
        if (client) {
          await client.disconnect()
          client = null
          activeSessions.clear()
        }
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
    if (client) {
      try {
        await client.disconnect()
      } catch {}
    }
    process.exit(0)
  })

  sendNotification('ready', {
    version: '0.1.2',
    platform: process.platform,
    pid: process.pid,
  })
}

startSidecar()
