import { describe, expect, it } from 'vitest'
import {
  ACP_EARLY_EXIT_STDERR_TAIL_LINES,
  getAcpEarlyExitStderrDetail,
  getLiveAcpProcess,
  isSpawnedAcpProcessAlive,
  spawnAcpProcess,
  tryReuseLiveAcpProcess,
  type SpawnedAcpProcess,
  withAcpEarlyExitDetail,
} from './process-manager'

/** 等进程落定（kill 经 taskkill/信号异步生效，同步断言撞中间态） */
async function waitForDead(handle: SpawnedAcpProcess, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (isSpawnedAcpProcessAlive(handle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('进程未在时限内退出')
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('连接失败自诊断（stderr 尾部拼进连接失败错误，去窗口化）', () => {
  it('早退带 stderr 尾', () => {
    const now = Date.now()
    const detail = getAcpEarlyExitStderrDetail(
      { spawnedAt: now - 500, stderrTail: ['harness: missing key', 'second line'] },
      now,
    )
    expect(detail).toContain('harness: missing key')
    expect(detail).toContain('second line')
    const message = withAcpEarlyExitDetail('ACP connection closed', detail)
    expect(message).toContain('ACP connection closed')
    expect(message).toContain('stderr 尾部')
    expect(message).toContain('harness: missing key')
  })

  it('无 stderr 不崩（null/空尾返回原文）', () => {
    const now = Date.now()
    expect(getAcpEarlyExitStderrDetail(null, now)).toBeNull()
    expect(getAcpEarlyExitStderrDetail(undefined, now)).toBeNull()
    expect(
      getAcpEarlyExitStderrDetail({ spawnedAt: now, stderrTail: [] }, now),
    ).toBeNull()
    expect(
      getAcpEarlyExitStderrDetail({ spawnedAt: now, stderrTail: ['   ', ''] }, now),
    ).toBeNull()
    expect(withAcpEarlyExitDetail('ACP connection closed', null)).toBe(
      'ACP connection closed',
    )
  })

  it('慢退同样带尾（去窗口化：窗口外不再返回 null）', () => {
    const now = Date.now()
    const detail = getAcpEarlyExitStderrDetail(
      {
        spawnedAt: now - 60_000,
        stderrTail: ['harness: missing key'],
      },
      now,
    )
    expect(detail).toContain('harness: missing key')
    expect(withAcpEarlyExitDetail('ACP connection closed', detail)).toContain(
      'stderr 尾部',
    )
  })

  it('尾部截断到单处常量行数', () => {
    const now = Date.now()
    const tail = Array.from(
      { length: ACP_EARLY_EXIT_STDERR_TAIL_LINES + 5 },
      (_, i) => `line-${i}`,
    )
    const detail = getAcpEarlyExitStderrDetail({ spawnedAt: now, stderrTail: tail }, now)
    expect(detail).not.toBeNull()
    expect(detail!.split('\n')).toHaveLength(ACP_EARLY_EXIT_STDERR_TAIL_LINES)
    expect(detail).not.toContain('line-0')
  })
})

describe('标签感知复用裁决（tryReuseLiveAcpProcess）', () => {
  const tagA = 'codex-acp:resources@aaa'
  const tagB = 'codex-acp:resources@bbb'
  const rid = `reuse-probe-${Date.now()}`

  function spawnTagged(tag: string | null) {
    return spawnAcpProcess({
      runtime: {
        id: rid,
        name: 'Reuse Probe',
        description: 'reuse probe',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 60000)'],
        requiredEnvKeys: [],
      },
      cwd: process.cwd(),
      profileTag: tag,
    })
  }

  it('一致命中、不一致拒绝、无要求沿旧语义', async () => {
    const handle = spawnTagged(tagA)
    try {
      expect(isSpawnedAcpProcessAlive(handle)).toBe(true)
      expect(tryReuseLiveAcpProcess(rid, { expectedTag: tagA })).toEqual({
        status: 'hit',
        handle,
      })
      expect(getLiveAcpProcess(rid, { expectedTag: null })).toBeUndefined()
      expect(tryReuseLiveAcpProcess(rid, { expectedTag: tagB })).toEqual({ status: 'miss' })
      // 不一致且空闲：旧进程被杀（版本/摘要变更只处理空闲进程；落定异步，等 exit）
      await waitForDead(handle)
    } finally {
      handle.kill()
    }
  })

  it('摘要变更而旧进程忙：沿用不断不杀（busy）', async () => {
    const handle = spawnTagged(tagA)
    try {
      const res = tryReuseLiveAcpProcess(rid, { expectedTag: tagB, isBusy: () => true })
      expect(res).toEqual({ status: 'busy', handle })
      expect(isSpawnedAcpProcessAlive(handle)).toBe(true)
      expect(getLiveAcpProcess(rid, { expectedTag: tagA })).toBe(handle)
    } finally {
      handle.kill()
      await waitForDead(handle)
    }
  })

  it('作用域隔离：不同 scope 不串用', async () => {
    const handle = spawnTagged(tagA)
    try {
      expect(getLiveAcpProcess(rid, { scopeKey: 'other', expectedTag: tagA })).toBeUndefined()
    } finally {
      handle.kill()
      await waitForDead(handle)
    }
  })
})
