import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import type { AcpAgentQuota, AcpQuotaLimitWindow } from '../../contracts/quota'

export function resolveGeminiHome(): string {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.gemini')
}

const isWSL =
  process.platform === 'linux' &&
  (os.release().toLowerCase().includes('microsoft') || Boolean(process.env.WSL_DISTRO_NAME))

export function resolveAntigravityAccount(): { email?: string; name?: string } {
  if (process.env.GOOGLE_ACCOUNT?.trim()) {
    const email = process.env.GOOGLE_ACCOUNT.trim()
    return { email, name: email.split('@')[0] }
  }
  if (process.env.ANTIGRAVITY_ACCOUNT?.trim()) {
    const email = process.env.ANTIGRAVITY_ACCOUNT.trim()
    return { email, name: email.split('@')[0] }
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || ''
  const candidates: string[] = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Antigravity', 'app_storage.json') : null,
    join(home, '.config', 'Antigravity', 'app_storage.json'),
    join(home, 'Library', 'Application Support', 'Antigravity', 'app_storage.json'),
  ].filter(Boolean) as string[]

  if (isWSL) {
    try {
      const usersDir = '/mnt/c/Users'
      if (existsSync(usersDir)) {
        for (const u of readdirSync(usersDir)) {
          if (u === 'Public' || u === 'Default' || u.startsWith('.')) continue
          candidates.push(join(usersDir, u, 'AppData', 'Roaming', 'Antigravity', 'app_storage.json'))
        }
      }
    } catch {}
  }

  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const json = JSON.parse(raw)
        const username = json['jetski.onboarding.lastLoginUsername']
        if (username && typeof username === 'string' && username.trim()) {
          const u = username.trim()
          return {
            email: u,
            name: u.includes('@') ? u.split('@')[0] : u,
          }
        }
      }
    } catch {}
  }
  const osUser = process.env.USERNAME || process.env.USER
  if (osUser?.trim()) {
    return { name: osUser.trim() }
  }
  return {}
}

export async function probeAgyQuota(options?: { sessionId?: string }): Promise<AcpAgentQuota | null> {
  const acc = resolveAntigravityAccount()
  let lsInfo: { port: number; csrfToken: string } | null = null

  try {
    let out = ''
    if (process.platform === 'win32') {
      out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*language_server*" } | Select-Object -ExpandProperty CommandLine',
        ],
        { encoding: 'utf8', timeout: 4000, windowsHide: true }
      )
    } else if (isWSL) {
      out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*language_server*" } | Select-Object -ExpandProperty CommandLine',
        ],
        { encoding: 'utf8', timeout: 4000 }
      )
    } else {
      out = execFileSync('ps', ['aux'], { encoding: 'utf8', timeout: 4000 })
    }
    const lines = out.split(/\r?\n/)
    for (const l of lines) {
      const portMatch = l.match(/--https_server_port\s+(\d+)/)
      const csrfMatch = l.match(/--csrf_token\s+([a-f0-9\-]+)/)
      if (portMatch && csrfMatch) {
        lsInfo = { port: parseInt(portMatch[1], 10), csrfToken: csrfMatch[1] }
        break
      }
    }
  } catch {}

  if (lsInfo) {
    try {
      let data: any = null
      if (isWSL) {
        const raw = execFileSync(
          'curl.exe',
          [
            '-k',
            '-s',
            '-X',
            'POST',
            '-H',
            'Content-Type: application/json',
            '-H',
            `x-codeium-csrf-token: ${lsInfo.csrfToken}`,
            '-d',
            '{}',
            `https://127.0.0.1:${lsInfo.port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
          ],
          { encoding: 'utf8', timeout: 4000 }
        )
        data = JSON.parse(raw)
      } else {
        const prevReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
        try {
          const res = await fetch(
            `https://127.0.0.1:${lsInfo.port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-codeium-csrf-token': lsInfo.csrfToken,
              },
              body: JSON.stringify({}),
              signal: AbortSignal.timeout(4000),
              tls: { rejectUnauthorized: false },
            } as any
          )
          if (res.ok) {
            data = await res.json()
          }
        } finally {
          if (prevReject !== undefined) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevReject
          } else {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
          }
        }
      }

      if (data?.response?.groups) {
        const groups = data.response.groups as Array<{
          displayName: string
          description?: string
          buckets?: Array<{
            bucketId?: string
            displayName: string
            description?: string
            window?: string
            remainingFraction?: number
            resetTime?: string
          }>
        }>

        const formatReset = (isoStr?: string, fallbackDesc?: string) => {
          if (fallbackDesc && fallbackDesc.includes('it will fully refresh in ')) {
            const m = fallbackDesc.match(/it will fully refresh in (.+?)\.?$/)
            if (m?.[1]) return `Resets in ${m[1].trim()}`
          }
          if (!isoStr) return undefined
          const diffMs = new Date(isoStr).getTime() - Date.now()
          if (diffMs <= 0) return '已重置'
          const totalMins = Math.floor(diffMs / 60000)
          const hours = Math.floor(totalMins / 60)
          const days = Math.floor(hours / 24)
          if (days > 0) return `Resets in ${days}d ${hours % 24}h`
          return `Resets in ${hours}h ${totalMins % 60}m`
        }

        const toWindow = (b: any, groupName: string, label: string, durMins: number): AcpQuotaLimitWindow | undefined => {
          if (!b) return undefined
          const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1
          const percentLeft = Math.max(0, Math.min(100, Math.round(frac * 100)))
          const usedPercent = 100 - percentLeft
          return {
            label,
            group: groupName,
            percentLeft,
            usedPercent,
            windowDurationMins: durMins,
            resetsAt: formatReset(b.resetTime, b.description),
          }
        }

        const geminiGroup = groups.find((g) => g.displayName?.toLowerCase().includes('gemini'))
        const thirdPartyGroup = groups.find((g) =>
          g.displayName?.toLowerCase().includes('claude') || g.displayName?.toLowerCase().includes('gpt')
        )

        const gemini5h = geminiGroup?.buckets?.find(
          (b) => b.displayName?.toLowerCase().includes('five hour') || b.bucketId?.includes('5h') || b.window === '5h'
        )
        const geminiWeekly = geminiGroup?.buckets?.find(
          (b) => b.displayName?.toLowerCase().includes('weekly') || b.bucketId?.includes('weekly') || b.window === 'weekly'
        )

        const tp5h = thirdPartyGroup?.buckets?.find(
          (b) => b.displayName?.toLowerCase().includes('five hour') || b.bucketId?.includes('5h') || b.window === '5h'
        )
        const tpWeekly = thirdPartyGroup?.buckets?.find(
          (b) => b.displayName?.toLowerCase().includes('weekly') || b.bucketId?.includes('weekly') || b.window === 'weekly'
        )

        const primaryWindow = toWindow(gemini5h, 'Gemini Models', '5-Hour limit', 300) || {
          label: '5-Hour limit',
          group: 'Gemini Models',
          percentLeft: 100,
          usedPercent: 0,
          windowDurationMins: 300,
        }

        const secondaryWindow = toWindow(geminiWeekly, 'Gemini Models', 'Weekly limit', 10080)

        const extraWindows = [
          toWindow(tp5h, 'Claude and GPT models', '5-Hour limit', 300),
          toWindow(tpWeekly, 'Claude and GPT models', 'Weekly limit', 10080),
        ].filter(Boolean) as AcpQuotaLimitWindow[]

        return {
          runtimeId: 'agy',
          provider: 'Google Antigravity',
          account: {
            email: acc.email,
            name: acc.name || 'Google Developer',
            plan: 'Google AI Pro',
            type: 'gemini',
          },
          primaryWindow,
          secondaryWindow,
          extraWindows: extraWindows.length > 0 ? extraWindows : undefined,
          credits: {
            unlimited: true,
            balance: 'unlimited',
          },
          status: 'ok',
          updatedAt: Date.now(),
        }
      }
    } catch {}
  }

  // 回落逻辑
  const geminiHome = resolveGeminiHome()
  const hasAgyDir = existsSync(join(geminiHome, 'antigravity')) || existsSync(join(geminiHome, 'antigravity-cli'))
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
  const isAvailable = hasAgyDir || hasApiKey || Boolean(acc.email || acc.name)

  if (!isAvailable) {
    return {
      runtimeId: 'agy',
      provider: 'Google Antigravity',
      status: 'unauthorized',
      message: '未检测到 Antigravity 登录凭据',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId: 'agy',
    provider: 'Google Antigravity',
    account: {
      email: acc.email,
      name: acc.name || 'Google Developer',
      plan: 'Google AI Pro',
      type: 'gemini',
    },
    primaryWindow: {
      label: '5-Hour limit',
      group: 'Gemini Models',
      percentLeft: 100,
      usedPercent: 0,
      windowDurationMins: 300,
    },
    secondaryWindow: {
      label: 'Weekly limit',
      group: 'Gemini Models',
      percentLeft: 100,
      usedPercent: 0,
      windowDurationMins: 10080,
    },
    extraWindows: [
      {
        label: '5-Hour limit',
        group: 'Claude and GPT models',
        percentLeft: 100,
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        label: 'Weekly limit',
        group: 'Claude and GPT models',
        percentLeft: 100,
        usedPercent: 0,
        windowDurationMins: 10080,
      },
    ],
    credits: {
      unlimited: true,
      balance: 'unlimited',
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
