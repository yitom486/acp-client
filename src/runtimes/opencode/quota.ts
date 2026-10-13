import { existsSync, readFileSync } from 'node:fs'
import type { AcpAgentQuota } from '../../contracts/quota'
import { resolveOpencodeAuthCandidates } from './index'

export function resolveOpencodeAuthPath(): string | null {
  const candidates = resolveOpencodeAuthCandidates()
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0] ?? null
}

export async function probeOpencodeQuota(runtimeId = 'opencode'): Promise<AcpAgentQuota | null> {
  const authPath = resolveOpencodeAuthPath()
  let isLoggedIn = false
  let accountEmail: string | undefined
  let plan = 'OpenCode Community'

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

  if (!isLoggedIn) {
    return {
      runtimeId,
      provider: 'OpenCode',
      status: 'unauthorized',
      message: '未检测到 OpenCode 登录凭证 (auth.json / SQLite)',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId,
    provider: 'OpenCode',
    account: {
      email: accountEmail,
      plan,
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
