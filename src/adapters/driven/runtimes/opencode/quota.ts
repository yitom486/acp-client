import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import type { AcpAgentQuota } from '../../../../domain/contracts'
import { resolveOpencodeAuthCandidates } from '../_shared/opencode-auth'

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
 * Official OpenCode CLI stats probe (`opencode stats --standalone --cost --json`).
 */
async function queryOpencodeStats(timeoutMs = 1200): Promise<OpencodeStatsResult | null> {
  if (cachedStats && Date.now() - cachedStats.time < 30_000) {
    return cachedStats.res
  }

  return new Promise((resolve) => {
    try {
      execFile(
        'opencode',
        ['stats', '--standalone', '--cost', '--json'],
        { timeout: timeoutMs, windowsHide: true },
        (_err, stdout) => {
          if (!stdout) return resolve(null)
          try {
            const data = JSON.parse(stdout.trim()) as OpencodeStatsResult
            cachedStats = { res: data, time: Date.now() }
            resolve(data)
          } catch {
            resolve(null)
          }
        },
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * Official OpenCode CLI auth probe (`opencode auth list`).
 */
async function queryOpencodeAuthList(timeoutMs = 1200): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      execFile('opencode', ['auth', 'list'], { timeout: timeoutMs, windowsHide: true }, (_err, stdout) => {
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

/**
 * Official OpenCode quota/usage probe.
 *
 * Uses only documented official CLI commands (`opencode stats --standalone --cost --json`
 * and `opencode auth list`) plus standard `auth.json` presence — does NOT read
 * internal SQLite databases or call undocumented OpenCode console HTTP APIs.
 */
export async function probeOpencodeQuota(runtimeId = 'opencode'): Promise<AcpAgentQuota | null> {
  const authPath = resolveOpencodeAuthPath()
  let isLoggedIn = false
  let accountEmail: string | undefined
  let plan = 'OpenCode'

  if (authPath && existsSync(authPath)) {
    try {
      const data = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        isLoggedIn = true
        if (typeof data.email === 'string') accountEmail = data.email
        if (typeof data.plan === 'string') plan = data.plan
      }
    } catch {
      // ignore unreadable auth.json
    }
  }

  const [stats, authList] = await Promise.all([
    queryOpencodeStats(1200),
    queryOpencodeAuthList(1200),
  ])

  if (authList.length > 0) {
    isLoggedIn = true
    const providers = authList.map((l) => l.split(/\s{2,}/)[0]).filter(Boolean)
    if (providers.some((p) => p.toLowerCase().includes('go'))) {
      plan = 'OpenCode Go'
    } else if (providers.length > 0) {
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
      balance: stats.cost > 0 ? `$${stats.cost.toFixed(2)} spent` : '$0.00',
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
