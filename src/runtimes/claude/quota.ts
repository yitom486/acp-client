import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpAgentQuota } from '../../contracts/quota'
import { resolveClaudeHome } from './index'

export async function probeClaudeQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const claudeHome = resolveClaudeHome()
  const claudeJsonPath = join(homedir(), '.claude.json')
  const credsPath = join(claudeHome, '.credentials.json')

  let isLoggedIn = false
  let isBanned = false
  let accountEmail: string | undefined
  let plan = 'Claude Free / Default'

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
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
