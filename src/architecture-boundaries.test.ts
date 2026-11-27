import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(__dirname)

function walkProductionTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkProductionTs(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full)
    }
  }
  return out
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g

function extractSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2]
    if (spec) specifiers.push(spec)
  }
  return specifiers
}

function toPosix(pathValue: string): string {
  return pathValue.split(sep).join('/')
}

function resolveLayerPath(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  const resolved = resolve(dirname(fromFile), specifier)
  return toPosix(relative(SRC_ROOT, resolved))
}

const FORBIDDEN_CORE_EXTERNALS = [
  /^node:/,
  /^(?:fs|path|os|crypto|child_process|net|http|https|stream|readline|util|url)$/,
  /^@agentclientprotocol\/sdk/,
]

function isUnderLayer(target: string, layer: string): boolean {
  return target === layer || target.startsWith(`${layer}/`)
}

describe('Hexagonal architecture dependency boundaries', () => {
  const prodFiles = walkProductionTs(SRC_ROOT)

  it('src/domain/** is pure: zero Node IO, zero ACP SDK, zero outer layers', () => {
    const violations: string[] = []
    for (const file of prodFiles) {
      const rel = toPosix(relative(SRC_ROOT, file))
      if (!rel.startsWith('domain/')) continue
      for (const spec of extractSpecifiers(file)) {
        const target = resolveLayerPath(file, spec)
        if (FORBIDDEN_CORE_EXTERNALS.some((re) => re.test(spec))) {
          violations.push(`${rel} -> ${spec}`)
        } else if (!isUnderLayer(target, 'domain')) {
          violations.push(`${rel} -> ${target}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('src/ports/** depends only on domain/ and ports/ (zero Node IO, zero ACP SDK)', () => {
    const violations: string[] = []
    for (const file of prodFiles) {
      const rel = toPosix(relative(SRC_ROOT, file))
      if (!rel.startsWith('ports/')) continue
      for (const spec of extractSpecifiers(file)) {
        const target = resolveLayerPath(file, spec)
        if (FORBIDDEN_CORE_EXTERNALS.some((re) => re.test(spec))) {
          violations.push(`${rel} -> ${spec}`)
        } else if (!isUnderLayer(target, 'domain') && !isUnderLayer(target, 'ports')) {
          violations.push(`${rel} -> ${target}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('src/application/** depends only on domain/, ports/, and application/ (zero Node IO, zero adapters/SDK)', () => {
    const violations: string[] = []
    for (const file of prodFiles) {
      const rel = toPosix(relative(SRC_ROOT, file))
      if (!rel.startsWith('application/')) continue
      for (const spec of extractSpecifiers(file)) {
        const target = resolveLayerPath(file, spec)
        if (FORBIDDEN_CORE_EXTERNALS.some((re) => re.test(spec))) {
          violations.push(`${rel} -> ${spec}`)
        } else if (
          !isUnderLayer(target, 'domain') &&
          !isUnderLayer(target, 'ports') &&
          !isUnderLayer(target, 'application')
        ) {
          violations.push(`${rel} -> ${target}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('src/adapters/driving/** never imports src/adapters/driven/** directly', () => {
    const violations: string[] = []
    for (const file of prodFiles) {
      const rel = toPosix(relative(SRC_ROOT, file))
      if (!rel.startsWith('adapters/driving/')) continue
      for (const spec of extractSpecifiers(file)) {
        const target = resolveLayerPath(file, spec)
        if (target.startsWith('adapters/driven/')) {
          violations.push(`${rel} -> ${target}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('runtime plugins under src/adapters/driven/runtimes/<id>/ do not cross-import sibling runtimes', () => {
    const violations: string[] = []
    for (const file of prodFiles) {
      const rel = toPosix(relative(SRC_ROOT, file))
      const match = rel.match(/^adapters\/driven\/runtimes\/([^/]+)\//)
      if (!match) continue
      const owner = match[1]
      if (owner === '_shared') continue
      for (const spec of extractSpecifiers(file)) {
        const target = resolveLayerPath(file, spec)
        const targetMatch = target.match(/^adapters\/driven\/runtimes\/([^/]+)(?:\/|$)/)
        if (!targetMatch) continue
        const targetPlugin = targetMatch[1]
        if (targetPlugin !== owner && targetPlugin !== '_shared') {
          violations.push(`${rel} -> ${target}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
