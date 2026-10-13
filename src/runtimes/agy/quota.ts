import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpAgentQuota } from '../../contracts/quota'

export function resolveGeminiHome(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.gemini')
}

export async function probeAgyQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const geminiHome = resolveGeminiHome()
  const hasAgyDir = existsSync(join(geminiHome, 'antigravity')) || existsSync(join(geminiHome, 'antigravity-cli'))
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)

  const isAvailable = hasAgyDir || hasApiKey


  if (!isAvailable) {
    return {
      runtimeId: 'agy',
      provider: 'Google Antigravity',
      status: 'unauthorized',
      message: 'wenjianlingu antigravity cli',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId: 'agy',
    provider: 'Google Antigravity',
    account: {
      name: process.env.GOOGLE_ACCOUNT || process.env.USERNAME || 'Google Developer',
      plan: 'Antigravity / Gemini',
      type: 'gemini',
    },
    primaryWindow: {
      label: '5-Hour limit',
      percentLeft: 100,
      usedPercent: 0,
      windowDurationMins: 300,
    },
    secondaryWindow: {
      label: 'Weekly limit',
      percentLeft: 100,
      usedPercent: 0,
      windowDurationMins: 10080,
    },
    credits: {
      unlimited: true,
      balance: 'unlimited',
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
