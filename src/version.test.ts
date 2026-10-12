import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ACP_CLIENT_VERSION } from './version'

describe('ACP_CLIENT_VERSION', () => {
  it('matches package.json (run scripts/sync-version.mjs on bump)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(ACP_CLIENT_VERSION).toBe(pkg.version)
  })
  it('sidecar reports it instead of a hardcoded string', () => {
    const src = readFileSync(new URL('./sidecar/main.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/sendNotification\('ready', \{\s*version: ACP_CLIENT_VERSION,/)
  })
})
