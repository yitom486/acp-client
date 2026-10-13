import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import type { AcpAgentQuota } from '../../contracts/quota'
import { resolveOpencodeAuthCandidates } from './index'

export function resolveOpencodeAuthPath(): string | null {
  const candidates = resolveOpencodeAuthCandidates()
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0] ?? null
}

interface OpencodeStatsResult {
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

let cachedStats: { res: OpencodeStatsResult; time: number } | null = null

/**
 * 原生 OpenCode stats 探针: 通过 opencode stats --standalone --cost --json 获取使用量与账单
 */
async function queryOpencodeStats(timeoutMs = 1200): Promise<OpencodeStatsResult | null> {
  if (cachedStats && Date.now() - cachedStats.time < 30000) {
    return cachedStats.res
  }

  return new Promise((resolve) => {
    try {
      execFile(
        'opencode',
        ['stats', '--standalone', '--cost', '--json'],
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (!stdout) return resolve(null)
          try {
            const data = JSON.parse(stdout.trim())
            cachedStats = { res: data, time: Date.now() }
            resolve(data)
          } catch {
            resolve(null)
          }
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 原生 OpenCode auth 探针: 通过 opencode auth list 检查已连接 Provider (毫秒级响应)
 */
async function queryOpencodeAuthList(timeoutMs = 1200): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile('opencode', ['auth', 'list'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (!stdout) return resolve([])
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('stored'))
        resolve(lines)
      })
    } catch {
      resolve([])
    }
  })
}

export async function probeOpencodeQuota(runtimeId = 'opencode'): Promise<AcpAgentQuota | null> {
  const authPath = resolveOpencodeAuthPath()
  let isLoggedIn = false
  let accountEmail: string | undefined
  let plan = 'OpenCode Community'

  // 1. 静态凭据文件解析 (极速保底)
  if (authPath && existsSync(authPath)) {
    try {
      const data = JSON.parse(readFileSync(authPath, 'utf8'))
      if (data && typeof data === 'object') {
        const keys = Object.keys(data)
        if (keys.length > 0) {
          isLoggedIn = true
          if (data.email) accountEmail = String(data.email)
          if (data.plan) plan = String(data.plan)
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 动态 CLI 探针 (快速并行)
  const [stats, authList] = await Promise.all([
    queryOpencodeStats(1200),
    queryOpencodeAuthList(1200),
  ])

  if (authList.length > 0) {
    isLoggedIn = true
    const providers = authList.map((l) => l.split(/\s{2,}/)[0]).filter(Boolean)
    if (providers.length > 0) {
      plan = `OpenCode (${providers.join(', ')})`
    }
  }

  if (process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY) {
    isLoggedIn = true
  }

  if (!isLoggedIn) {
    return {
      runtimeId,
      provider: 'OpenCode',
      status: 'unauthorized',
      message: '未登录 OpenCode 或未配置 Provider (No stored credentials)',
      updatedAt: Date.now(),
    }
  }

  let credits: AcpAgentQuota['credits']
  if (stats && typeof stats.cost === 'number') {
    credits = {
      balance: stats.cost > 0 ? `$${stats.cost.toFixed(2)} spent` : '0.00',
    }
  }

  return {
    runtimeId,
    provider: 'OpenCode',
    account: {
      email: accountEmail,
      plan,
      type: 'provider_oauth',
    },
    credits,
    status: 'ok',
    updatedAt: Date.now(),
  }
}
