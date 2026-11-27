import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agyAdapter,
  antigravityCliAdapter,
  probeAgyAuth,
  resolveAntigravityCliCommand,
} from './index'

describe('agyAdapter（中性探测 + 直连优先）', () => {
  it('probe 中性空结果（authMethods 为 []，直连即可）', () => {
    const probed = probeAgyAuth()
    expect(probed.looksLoggedIn).toBe(false)
    expect(probed.hasAuthFile).toBe(false)
    expect(probed.hasApiKeyEnv).toBe(false)
    expect(agyAdapter.probeAuth()).toEqual(probed)
  })

  it('tryDirectSessionFirst=true（authMethods 为空时直建会话）', () => {
    expect(agyAdapter.tryDirectSessionFirst).toBe(true)
    expect(agyAdapter.id).toBe('agy')
  })

  it('无 resolveSpawnCommand（模板 bunx 直调，无覆盖）', () => {
    expect(agyAdapter.resolveSpawnCommand).toBeUndefined()
  })
})

describe('antigravityCliAdapter（官方 agy acp 适配器）', () => {
  it('暴露完整契约（tryDirectSessionFirst、orderAuthMethods、canSkipInteractiveAuth、probeQuota）', async () => {
    expect(antigravityCliAdapter.id).toBe('antigravity-cli')
    expect(antigravityCliAdapter.tryDirectSessionFirst).toBe(true)
    const methods = [{ id: 'oauth-personal' }]
    expect(antigravityCliAdapter.orderAuthMethods?.(methods)).toBe(methods)
    expect(antigravityCliAdapter.canSkipInteractiveAuth?.('oauth-personal')).toBe(false)
    expect(typeof antigravityCliAdapter.probeQuota).toBe('function')
    const quota = await antigravityCliAdapter.probeQuota!()
    expect(quota?.runtimeId).toBe('antigravity-cli')
  })

  it('resolveAntigravityCliCommand 探测 PATH 与标准安装目录，缺失时返回 null', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-cli-resolve-'))
    try {
      const pathDir = join(root, 'path-bin')
      mkdirSync(pathDir, { recursive: true })
      const pathBin = join(pathDir, 'agy')
      writeFileSync(pathBin, '#!/bin/sh\n')

      expect(
        resolveAntigravityCliCommand({ platform: 'linux', env: { PATH: pathDir }, home: root }),
      ).toEqual({ command: 'agy', args: ['acp'] })

      const homeLocalDir = join(root, '.local', 'bin')
      mkdirSync(homeLocalDir, { recursive: true })
      const homeBin = join(homeLocalDir, 'agy')
      writeFileSync(homeBin, '#!/bin/sh\n')

      expect(
        resolveAntigravityCliCommand({ platform: 'linux', env: { PATH: '' }, home: root }),
      ).toEqual({ command: homeBin, args: ['acp'] })

      expect(
        resolveAntigravityCliCommand({ platform: 'linux', env: { PATH: '' }, home: join(root, 'empty-home') }),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
