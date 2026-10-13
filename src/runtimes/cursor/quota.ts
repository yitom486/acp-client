import type { AcpAgentQuota } from '../../contracts/quota'
import { probeCursorAuth } from './index'

export async function probeCursorQuota(): Promise<AcpAgentQuota | null> {
  const auth = probeCursorAuth()
  if (!auth.looksLoggedIn) {
    return {
      runtimeId: 'cursor-cli',
      provider: 'Cursor',
      status: 'unauthorized',
      message: '未检测到 Cursor CLI 登录凭证',
      updatedAt: Date.now(),
    }
  }

  return {
    runtimeId: 'cursor-cli',
    provider: 'Cursor',
    account: {
      plan: 'Cursor Pro / Fast Requests',
    },
    status: 'ok',
    updatedAt: Date.now(),
  }
}
