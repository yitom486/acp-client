import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { AcpAgentQuota } from '../../contracts/quota'
import { resolveClaudeHome } from './index'

interface ClaudeAuthStatusResult {
  loggedIn?: boolean
  email?: string
  subscriptionType?: string
  plan?: string
  authMethod?: string
  apiProvider?: string
  organization?: string
}

let cachedClaudeAuth: { res: ClaudeAuthStatusResult; time: number } | null = null

/**
 * 原生 Claude Code 探针: 通过 claude auth status --json 获取实时账户状态
 */
async function queryClaudeAuthStatus(timeoutMs = 1200): Promise<ClaudeAuthStatusResult | null> {
  if (cachedClaudeAuth && Date.now() - cachedClaudeAuth.time < 30000) {
    return cachedClaudeAuth.res
  }

  return new Promise((resolve) => {
    try {
      execFile(
        'claude',
        ['auth', 'status', '--json'],
        { timeout: timeoutMs, windowsHide: true, shell: process.platform === 'win32' },
        (err, stdout) => {
          if (!stdout) return resolve(null)
          try {
            const data = JSON.parse(stdout.trim())
            cachedClaudeAuth = { res: data, time: Date.now() }
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

export async function probeClaudeQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const claudeHome = resolveClaudeHome()
  const claudeJsonPath = join(homedir(), '.claude.json')
  const credsPath = join(claudeHome, '.credentials.json')

  let isLoggedIn = false
  let isBanned = false
  let accountEmail: string | undefined
  let plan = 'Claude Free / Default'

  // 1. 静态凭证读取 (极速保底)
  if (existsSync(claudeJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
      if (data.oauthAccount) {
        isLoggedIn = true
        accountEmail = data.oauthAccount.emailAddress
        plan = data.oauthAccount.subscriptionTier || 'Claude Pro'
      }
      if (data.isBanned || data.accountSuspended || data.status === 'banned') {
        isBanned = true
      }
    } catch {
      // ignore
    }
  }

  if (existsSync(credsPath)) {
    try {
      const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
      if (creds.accessToken || creds.sessionKey) isLoggedIn = true
    } catch {
      // ignore
    }
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    isLoggedIn = true
    plan = 'API Key (Env)'
  }

  // 2. 动态 CLI 状态探测 (带 shell: true 与短超时)
  const dynamic = await queryClaudeAuthStatus(1200)
  if (dynamic) {
    if (dynamic.loggedIn) isLoggedIn = true
    if (dynamic.email) accountEmail = dynamic.email
    if (dynamic.subscriptionType) plan = dynamic.subscriptionType
    else if (dynamic.plan) plan = dynamic.plan
  }

  if (isBanned) {
    return {
      runtimeId: 'claude',
      provider: 'Anthropic / Claude Code',
      status: 'banned',
      message: '账号已被封禁或暂停使用 (Account suspended / banned)',
      updatedAt: Date.now(),
    }
  }

  if (!isLoggedIn) {
    return {
      runtimeId: 'claude',
      provider: 'Anthropic / Claude Code',
      status: 'unauthorized',
      message: '未登录 Claude Code 或凭据无效 (Unauthorized)',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId: 'claude',
    provider: 'Anthropic / Claude Code',
    account: {
      email: accountEmail,
      plan,
      type: dynamic?.authMethod || 'oauth',
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
