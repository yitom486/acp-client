import { existsSync, readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import type { AcpAgentQuota } from "../../contracts/quota"
import { resolveOpencodeAuthCandidates } from "./index"

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
        "opencode",
        ["stats", "--standalone", "--cost", "--json"],
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
      execFile("opencode", ["auth", "list"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (!stdout) return resolve([])
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.includes("stored"))
        resolve(lines)
      })
    } catch {
      resolve([])
    }
  })
}

interface OpencodeDBCredentials {
  email?: string
  name?: string
  token?: string
  orgId?: string
  accountId?: string
}

function readLocalOpencodeCredentials(): OpencodeDBCredentials {
  const home = os.homedir()
  const dbPaths = [
    path.join(home, ".local", "share", "opencode", "opencode.db"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "opencode.db") : null,
    path.join(home, ".config", "opencode", "opencode.db"),
  ].filter(Boolean) as string[]

  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue
    try {
      let rows: Array<{ integration_id: string; value: string }> = []
      if (typeof (process.versions as any)?.bun !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Database } = require("bun:sqlite")
        const db = new Database(dbPath, { readonly: true })
        rows = db.query("SELECT integration_id, value FROM credential").all() as any
        db.close()
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DatabaseSync } = require("node:sqlite")
        const db = new DatabaseSync(dbPath, { readOnly: true })
        rows = db.prepare("SELECT integration_id, value FROM credential").all() as any
        db.close()
      }

      const opencodeCred = rows.find((r) => r.integration_id === "opencode")
      if (opencodeCred?.value) {
        const parsed = JSON.parse(opencodeCred.value)
        const meta = parsed.metadata || {}
        return {
          email: meta.email || undefined,
          name: meta.email ? meta.email.split("@")[0] : meta.orgName || undefined,
          token: parsed.access || undefined,
          orgId: meta.orgID || undefined,
          accountId: meta.accountID || undefined,
        }
      }
    } catch {
      try {
        const buf = readFileSync(dbPath, "utf8")
        const emailMatch = buf.match(/"email"\s*:\s*"([^"]+)"/)
        const tokenMatch = buf.match(/"access"\s*:\s*"(st_[a-zA-Z0-9_\\-]+)"/)
        const orgMatch = buf.match(/"orgID"\s*:\s*"(wrk_[a-zA-Z0-9_\\-]+)"/)
        const accMatch = buf.match(/"accountID"\s*:\s*"(acc_[a-zA-Z0-9_\\-]+)"/)
        if (emailMatch || tokenMatch) {
          return {
            email: emailMatch?.[1],
            name: emailMatch?.[1]?.split("@")[0],
            token: tokenMatch?.[1],
            orgId: orgMatch?.[1],
            accountId: accMatch?.[1],
          }
        }
      } catch {}
    }
  }
  return {}
}

async function probeOpencodeGoOnlineQuota(creds: OpencodeDBCredentials, runtimeId = "opencode"): Promise<AcpAgentQuota | null> {
  if (!creds.token || !creds.orgId) return null

  try {
    const res = await fetch("https://opencode.ai/console/api/go/status", {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "x-opencode-org-id": creds.orgId,
        "x-opencode-account-id": creds.accountId || "",
      },
      signal: AbortSignal.timeout(3500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    const meters = data?.access?.meters
    if (!meters) return null

    const formatReset = (isoStr?: string) => {
      if (!isoStr) return undefined
      const diffMs = new Date(isoStr).getTime() - Date.now()
      if (diffMs <= 0) return "已重置"
      const totalMins = Math.floor(diffMs / 60000)
      const hours = Math.floor(totalMins / 60)
      const days = Math.floor(hours / 24)
      if (days > 0) {
        const remH = hours % 24
        return `Resets in ${days}d ${remH}h`
      }
      const remM = totalMins % 60
      return `Resets in ${hours}h ${remM}m`
    }

    const calcWindow = (m: any, label: string, durMins: number) => {
      if (!m || !m.limitMicroCents) return undefined
      const limit = Number(m.limitMicroCents)
      const used = Number(m.usedMicroCents || 0)
      const usedPercent = limit > 0 ? Math.round((used / limit) * 100) : 0
      const percentLeft = Math.max(0, 100 - usedPercent)
      return {
        label,
        usedPercent,
        percentLeft,
        windowDurationMins: durMins,
        resetsAt: formatReset(m.resetsAt),
      }
    }

    const rolling = calcWindow(meters.fiveHour, "Rolling", 300)
    const weekly = calcWindow(meters.week, "Weekly", 10080)
    const monthly = calcWindow(meters.month, "Monthly", 43200)

    let creditBalance = "$0.00"
    try {
      const bRes = await fetch("https://opencode.ai/console/api/billing/status", {
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "x-opencode-org-id": creds.orgId,
          "x-opencode-account-id": creds.accountId || "",
        },
        signal: AbortSignal.timeout(2000),
      })
      if (bRes.ok) {
        const bData = (await bRes.json()) as any
        const availMicro = Number(bData.availableMicroCents || 0)
        creditBalance = `$${(availMicro / 100000000).toFixed(2)}`
      }
    } catch {}

    const quota: AcpAgentQuota = {
      runtimeId,
      provider: "OpenCode",
      account: {
        email: creds.email,
        name: creds.name || "OpenCode User",
        plan: "OpenCode Go",
        type: "opencode",
      },
      primaryWindow: rolling,
      secondaryWindow: weekly,
      extraWindows: monthly ? [monthly] : undefined,
      credits: {
        balance: creditBalance,
        currency: "USD",
        unlimited: false,
      },
      status: "ok",
      updatedAt: Date.now(),
    }
    return quota
  } catch {
    return null
  }
}

export async function probeOpencodeQuota(runtimeId = "opencode"): Promise<AcpAgentQuota | null> {
  // 1. 优先尝试本地 OpenCode Go 官方凭据与 Console API (精准多级限额)
  const dbCreds = readLocalOpencodeCredentials()
  if (dbCreds.token) {
    const goQuota = await probeOpencodeGoOnlineQuota(dbCreds, runtimeId)
    if (goQuota) return goQuota
  }

  const authPath = resolveOpencodeAuthPath()
  let isLoggedIn = Boolean(dbCreds.token || dbCreds.email)
  let accountEmail: string | undefined = dbCreds.email
  let accountName: string | undefined = dbCreds.name
  let plan = "OpenCode Community"

  // 2. 静态凭据文件解析 (保底)
  if (authPath && existsSync(authPath)) {
    try {
      const data = JSON.parse(readFileSync(authPath, "utf8"))
      if (data && typeof data === "object") {
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

  // 3. 动态 CLI 探针 (快速并行)
  const [stats, authList] = await Promise.all([
    queryOpencodeStats(1200),
    queryOpencodeAuthList(1200),
  ])

  if (authList.length > 0) {
    isLoggedIn = true
    const providers = authList.map((l) => l.split(/\s{2,}/)[0]).filter(Boolean)
    if (providers.some((p) => p.toLowerCase().includes("go"))) {
      plan = "OpenCode Go"
    } else if (providers.length > 0) {
      plan = `OpenCode (${providers.join(", ")})`
    }
  }

  if (process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY) {
    isLoggedIn = true
  }

  if (!isLoggedIn) {
    return {
      runtimeId,
      provider: "OpenCode",
      status: "unauthorized",
      message: "未登录 OpenCode 或未配置 Provider (No stored credentials)",
      updatedAt: Date.now(),
    }
  }

  let credits: AcpAgentQuota["credits"]
  if (stats && typeof stats.cost === "number") {
    credits = {
      balance: stats.cost > 0 ? `$${stats.cost.toFixed(2)} spent` : "$0.00",
    }
  }

  return {
    runtimeId,
    provider: "OpenCode",
    account: {
      email: accountEmail,
      name: accountName,
      plan,
      type: "provider_oauth",
    },
    credits,
    status: "ok",
    updatedAt: Date.now(),
  }
}
