import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpAgentQuota } from '../../contracts/quota'
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

export async function probeCodexQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const codexHome = resolveCodexHome()
  const authPath = join(codexHome, 'auth.json')

  let accountEmail: string | undefined
  let accountPlan = 'Codex Free / Local'
  let isLoggedIn = false

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

  if (!isLoggedIn) {
    return {
      runtimeId: 'codex-acp',
      provider: 'OpenAI / Codex',
      status: 'unauthorized',
      message: '未登录 Codex (Not logged in)',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId: 'codex-acp',
    provider: 'OpenAI / Codex',
    account: {
      email: accountEmail,
      plan: accountPlan,
      type: 'chatgpt',
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
