import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DSH_ACP_PINNED_VERSION,
  compareDshVersions,
  hasManagedDshRuntime,
  resolveManagedDshEntry,
  resolveManagedDshVersion,
} from './dsh-acp-bootstrap'

function runtimeRootWith(versions: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-dsh-root-'))
  for (const version of versions) {
    const entry = join(root, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, '// fake\n', 'utf8')
  }
  return root
}

describe('dsh 版本比较', () => {
  it('数字段优先', () => {
    expect(compareDshVersions('0.2.2', '0.2.1')).toBeGreaterThan(0)
    expect(compareDshVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('同号时正式版高于预发布版', () => {
    expect(compareDshVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareDshVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareDshVersions('1.0.0-alpha.5', '1.0.0-rc.2')).toBeLessThan(0)
  })
})

describe('稳定安装版本自动发现', () => {
  it('扫描根目录取已装最高版本（用户升级后无需改代码）', () => {
    const root = runtimeRootWith(['0.2.0-rc.2', '0.2.2', '0.2.1-rc.2'])
    expect(resolveManagedDshVersion({ DSH_RUNTIME_DIR: root })).toBe('0.2.2')
    expect(resolveManagedDshEntry({ DSH_RUNTIME_DIR: root })).toBe(
      join(root, '0.2.2', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    )
    expect(hasManagedDshRuntime({ DSH_RUNTIME_DIR: root })).toBe(true)
  })

  it('DSH_RUNTIME_VERSION 显式指定时优先', () => {
    const root = runtimeRootWith(['0.2.2', '0.3.0-rc.1'])
    expect(resolveManagedDshVersion({ DSH_RUNTIME_DIR: root, DSH_RUNTIME_VERSION: '0.2.2' })).toBe(
      '0.2.2',
    )
  })

  it('没有任何安装时回落内置 pin，且 hasManaged 为 false', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-dsh-empty-'))
    expect(resolveManagedDshVersion({ DSH_RUNTIME_DIR: root })).toBe(DSH_ACP_PINNED_VERSION)
    expect(hasManagedDshRuntime({ DSH_RUNTIME_DIR: root })).toBe(false)
  })

  it('不完整目录（缺 bin.js）不算安装', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-dsh-broken-'))
    mkdirSync(join(root, '0.9.9', 'node_modules'), { recursive: true })
    expect(resolveManagedDshVersion({ DSH_RUNTIME_DIR: root })).toBe(DSH_ACP_PINNED_VERSION)
  })
})
