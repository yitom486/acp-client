import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { antigravityCliRuntimePlugin, resolveAntigravityCliCommand } from './index'

describe('antigravityCliRuntimePlugin（官方 agy acp 插件）', () => {
  it('暴露完整契约（tryDirectSessionFirst、orderAuthMethods、canSkipInteractiveAuth、probeQuota）', async () => {
    expect(antigravityCliRuntimePlugin.id).toBe('antigravity-cli')
    expect(antigravityCliRuntimePlugin.auth?.tryDirectSessionFirst).toBe(true)
    const methods = [{ id: 'oauth-personal' }]
    expect(antigravityCliRuntimePlugin.auth?.orderAuthMethods?.(methods)).toBe(methods)
    expect(antigravityCliRuntimePlugin.auth?.canSkipInteractiveAuth?.('oauth-personal')).toBe(false)
    expect(typeof antigravityCliRuntimePlugin.quota?.probeQuota).toBe('function')
    expect(await antigravityCliRuntimePlugin.quota!.probeQuota()).toBeNull()
  })

  it('resolveAntigravityCliCommand 探测 PATH 与标准安装目录，缺失时返回 null', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-cli-resolve-'))
    try {
      const pathDir = join(root, 'path-bin')
      mkdirSync(pathDir, { recursive: true })
      writeFileSync(join(pathDir, 'agy'), '#!/bin/sh\n')

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
        resolveAntigravityCliCommand({
          platform: 'linux',
          env: { PATH: '' },
          home: join(root, 'empty-home'),
        }),
      ).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
