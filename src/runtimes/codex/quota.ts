import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { AcpAgentQuota, AcpQuotaLimitWindow } from '../../contracts/quota'
import { resolveCodexHome } from './codex-auth-preflight'

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    const json = Buffer.from(parts[1], 'base64').toString('utf8')
    return JSON.parse(json)
  } catch {
    return null
  }
}

interface CodexAppServerResult {
  account?: {
    email?: string
    planType?: string
    type?: string
  }
  rateLimits?: {
    primary?: {
      usedPercent: number
      windowDurationMins: number
      resetsAt?: number
    }
    secondary?: {
      usedPercent: number
      windowDurationMins: number
      resetsAt?: number
    }
    credits?: {
      hasCredits?: boolean
      unlimited?: boolean
      balance?: string | number
    }
  }
}

let cachedDynamicResult: { res: CodexAppServerResult; time: number } | null = null

/**
 * 原生 JSON-RPC 探针: 直连 codex app-server 获取毫秒级实时额度与账户数据
 * 0 Token 消耗、0 ACP 上下文污染、独立并发安全
 */
async function queryCodexAppServer(timeoutMs = 4000): Promise<CodexAppServerResult | null> {
  // 15 秒短缓存，避免高频请求重复创建子进程
  if (cachedDynamicResult && Date.now() - cachedDynamicResult.time < 15000) {
    return cachedDynamicResult.res
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null
    let proc: ReturnType<typeof spawn> | null = null
    let finished = false

    const cleanup = (res: CodexAppServerResult | null) => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      if (proc) {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      }
      if (res) {
        cachedDynamicResult = { res, time: Date.now() }
      }
      resolve(res)
    }

    timer = setTimeout(() => cleanup(null), timeoutMs)

    try {
      proc = spawn('codex', ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })

      if (!proc.stdin || !proc.stdout) {
        return cleanup(null)
      }

      const rl = readline.createInterface({ input: proc.stdout })
      let reqSeq = 1
      const pending = new Map<number, (res: any) => void>()
      const result: CodexAppServerResult = {}

      rl.on('line', (line) => {
        try {
          const data = JSON.parse(line.trim())
          if (data && typeof data.id === 'number' && pending.has(data.id)) {
            const cb = pending.get(data.id)!
            pending.delete(data.id)
            cb(data.result)
          }
        } catch {
          // ignore notifications
        }
      })

      proc.on('error', () => cleanup(null))
      proc.on('exit', () => cleanup(Object.keys(result).length > 0 ? result : null))

      const send = (method: string, params?: unknown): Promise<any> => {
        const id = reqSeq++
        const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        proc!.stdin!.write(msg)
        return new Promise((res) => {
          pending.set(id, res)
        })
      }

      ;(async () => {
        try {
          await send('initialize', {
            clientInfo: { name: 'acp-client', version: '0.1.6' },
          })

          const acc = await send('account/read', { refreshToken: false })
          if (acc?.account) {
            result.account = acc.account
          }

          const limits = await send('account/rateLimits/read')
          if (limits?.rateLimits) {
            result.rateLimits = limits.rateLimits
          }

          cleanup(result)
        } catch {
          cleanup(null)
        }
      })()
    } catch {
      cleanup(null)
    }
  })
}

function formatEpochTime(epochSeconds?: number): string | undefined {
  if (!epochSeconds) return undefined
  try {
    const d = new Date(epochSeconds * 1000)
    const hours = String(d.getHours()).padStart(2, '0')
    const mins = String(d.getMinutes()).padStart(2, '0')
    return `${hours}:${mins}`
  } catch {
    return undefined
  }
}

export async function probeCodexQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const codexHome = resolveCodexHome()
  const authPath = join(codexHome, 'auth.json')

  let accountEmail: string | undefined
  let accountPlan = 'Codex Free / Local'
  let isLoggedIn = false

  // 1. 静态本地凭据探针 (保底快速解析)
  if (existsSync(authPath)) {
    try {
      const authData = JSON.parse(readFileSync(authPath, 'utf8'))
      if (authData.OPENAI_API_KEY) {
        isLoggedIn = true
        accountPlan = 'OpenAI API Key'
      }
      if (authData.tokens?.id_token) {
        isLoggedIn = true
        const payload = decodeJwtPayload(authData.tokens.id_token)
        if (payload) {
          if (typeof payload.email === 'string') accountEmail = payload.email
          const authObj = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
          if (authObj && typeof authObj.chatgpt_plan_type === 'string') {
            accountPlan = `ChatGPT ${authObj.chatgpt_plan_type}`
          }
        }
      } else if (authData.tokens?.access_token) {
        isLoggedIn = true
      }
    } catch {
      // ignore
    }
  }

  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
    isLoggedIn = true
    accountPlan = 'API Key (Env)'
  }

  // 2. 原生动态 JSON-RPC 探针 (直连 codex app-server)
  const dynamic = await queryCodexAppServer(4000)
  if (dynamic) {
    isLoggedIn = true
    if (dynamic.account?.email) accountEmail = dynamic.account.email
    if (dynamic.account?.planType) accountPlan = `ChatGPT ${dynamic.account.planType}`
  }

  if (!isLoggedIn) {
    return {
      runtimeId: 'codex-acp',
      provider: 'OpenAI / Codex',
      status: 'unauthorized',
      message: '未登录 Codex (Not logged in)',
      updatedAt: Date.now(),
    }
  }

  let primaryWindow: AcpQuotaLimitWindow | undefined
  let secondaryWindow: AcpQuotaLimitWindow | undefined
  let credits: AcpAgentQuota['credits']

  if (dynamic?.rateLimits) {
    const rl = dynamic.rateLimits
    if (rl.primary) {
      const used = rl.primary.usedPercent ?? 0
      primaryWindow = {
        label: '5h limit',
        percentLeft: Math.max(0, Math.min(100, Math.round(100 - used))),
        usedPercent: used,
        windowDurationMins: rl.primary.windowDurationMins || 300,
        resetsAt: formatEpochTime(rl.primary.resetsAt) || (rl.primary.resetsAt ? String(rl.primary.resetsAt) : undefined),
      }
    }
    if (rl.secondary) {
      const used = rl.secondary.usedPercent ?? 0
      secondaryWindow = {
        label: 'Weekly limit',
        percentLeft: Math.max(0, Math.min(100, Math.round(100 - used))),
        usedPercent: used,
        windowDurationMins: rl.secondary.windowDurationMins || 10080,
        resetsAt: formatEpochTime(rl.secondary.resetsAt) || (rl.secondary.resetsAt ? String(rl.secondary.resetsAt) : undefined),
      }
    }
    if (rl.credits) {
      credits = {
        balance: rl.credits.balance,
        unlimited: rl.credits.unlimited,
      }
    }
  }

  return {
    runtimeId: 'codex-acp',
    provider: 'OpenAI / Codex',
    account: {
      email: accountEmail,
      plan: accountPlan,
      type: dynamic?.account?.type || 'chatgpt',
    },
    primaryWindow,
    secondaryWindow,
    credits,
    status: 'ok',
    updatedAt: Date.now(),
  }
}
