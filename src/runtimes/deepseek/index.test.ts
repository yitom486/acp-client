import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEEPSEEK_DSH_NPM_PACKAGE } from "../../contracts"
import {
  buildDeepseekMissingKeyMessage,
  deepseekAdapter,
  hasDshCredentials,
  probeDeepseekAuth,
  resolveDeepseekSpawnBlocker,
  resolveDeepseekSpawnCommand,
} from './index'
import { DSH_ACP_PINNED_VERSION } from './dsh-acp-bootstrap'
import { saveDeepseekProvider } from './deepseek-provider'

/**
 * 关掉模型覆盖层 + 指向空运行时目录：让 spawn 断言只关注启动目标本身，
 * 且不受本机真实的用户级稳定安装影响。
 */
const NO_PATCH: NodeJS.ProcessEnv = {
  DSH_ACP_MODEL_PATCH: 'off',
  DSH_RUNTIME_DIR: mkdtempSync(join(tmpdir(), 'acp-dsh-noruntime-')),
}

/** 空 harness 家目录（无凭证库）：隔离本机真实 ~/.dsh。 */
function emptyDshHome(): string {
  return mkdtempSync(join(tmpdir(), 'acp-dsh-nocred-'))
}

function dshHomeWithCredentials(body: string): string {
  const dir = emptyDshHome()
  writeFileSync(join(dir, '.credentials.yaml'), body, 'utf8')
  return dir
}

/** 造一个假的用户级稳定安装，只落 bin.js 占位。 */
function fakeManagedRuntime(): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'acp-dsh-runtime-'))
  const entry = join(
    root,
    DSH_ACP_PINNED_VERSION,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  )
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, '// fake dsh entry\n', 'utf8')
  return { root, entry }
}

describe('deepseek 缺凭证预检判停', () => {
  it('缺 key 且无 harness 凭证时判停，文案含动作指引', () => {
    const message = buildDeepseekMissingKeyMessage()
    expect(message).toContain('DEEPSEEK_API_KEY')
    expect(message).toContain('终端')
    expect(resolveDeepseekSpawnBlocker({ DSH_HOME: emptyDshHome() })).toBe(message)
  })

  it('空白 key 视同缺失', () => {
    expect(
      resolveDeepseekSpawnBlocker({ DEEPSEEK_API_KEY: '   ', DSH_HOME: emptyDshHome() }),
    ).toContain('DEEPSEEK_API_KEY')
  })

  it('有 key 放行（null）', () => {
    expect(
      resolveDeepseekSpawnBlocker({ DEEPSEEK_API_KEY: 'sk-x', DSH_HOME: emptyDshHome() }),
    ).toBeNull()
  })

  it('无 key 但 harness 已登录（凭证库有记录）时放行', () => {
    const home = dshHomeWithCredentials(
      ['version: 1', 'records:', '  - kind: api-key', '    ref: DEEPSEEK_API_KEY', ''].join('\n'),
    )
    expect(resolveDeepseekSpawnBlocker({ DSH_HOME: home })).toBeNull()
    expect(hasDshCredentials({ DSH_HOME: home })).toBe(true)
  })

  it('凭证库为空集合或缺文件时仍判停', () => {
    expect(hasDshCredentials({ DSH_HOME: dshHomeWithCredentials('records: []\n') })).toBe(false)
    expect(hasDshCredentials({ DSH_HOME: emptyDshHome() })).toBe(false)
    expect(
      resolveDeepseekSpawnBlocker({ DSH_HOME: dshHomeWithCredentials('records: []\n') }),
    ).toContain('DEEPSEEK_API_KEY')
  })

  it('顶层其他字段不冒充凭证记录', () => {
    const home = dshHomeWithCredentials('version: 1\nrecords:\nrefs: 2\n')
    expect(hasDshCredentials({ DSH_HOME: home })).toBe(false)
  })

  it('adapter 经 resolveSpawnBlocker 接线（可选 + 缺省兼容）', () => {
    expect(deepseekAdapter.resolveSpawnBlocker).toBeTypeOf('function')
  })

  it('宿主 URL+Token 表单已落库时放行（无需 key/登录）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'acp-dsh-form-'))
    saveDeepseekProvider({ apiKey: 'sk-form' }, dataDir)
    expect(resolveDeepseekSpawnBlocker({ DSH_HOME: emptyDshHome() }, dataDir)).toBeNull()
  })

  it('adapter getProviderEnv 把落库配置注入 spawn 环境', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'acp-dsh-form-'))
    saveDeepseekProvider({ baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-form' }, dataDir)
    const env = deepseekAdapter.getProviderEnv?.({ dataDir, env: {} })
    expect(env).toEqual({
      DEEPSEEK_BASE_URL: 'https://gw.example.com/v1',
      DEEPSEEK_API_KEY: 'sk-form',
    })
  })

  it('probeAuth 与阻断一致：无 key 无记录不谎报已登录', () => {
    const home = emptyDshHome()
    const probe = probeDeepseekAuth({ DSH_HOME: home })
    expect(probe.looksLoggedIn).toBe(false)
    expect(probe.hasApiKeyEnv).toBe(false)
    expect(probe.hasAuthFile).toBe(false)
    expect(resolveDeepseekSpawnBlocker({ DSH_HOME: home })).toContain('DEEPSEEK_API_KEY')
  })

  it('probeAuth 带出 harness 家目录与凭证文件', () => {
    const home = dshHomeWithCredentials('records:\n  - kind: api-key\n')
    const probe = probeDeepseekAuth({ DSH_HOME: home })
    expect(probe.codexHome).toBe(home)
    expect(probe.hasCodexHome).toBe(true)
    expect(probe.hasAuthFile).toBe(true)
    expect(probe.looksLoggedIn).toBe(true)
  })
})

describe('deepseek DSH_PACKAGE 包定位符覆盖', () => {
  it('缺省走 contracts 常量并带 @latest（每次冷启动直取最新）', () => {
    expect(DEEPSEEK_DSH_NPM_PACKAGE).toBe('@deepseek-ai/dsh')
    expect(resolveDeepseekSpawnCommand({ ...NO_PATCH })).toEqual({
      command: 'bunx',
      args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
    })
  })

  it('合法覆盖透传（如 pin 旧版绕上游坏依赖）', () => {
    expect(
      resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_PACKAGE: '@deepseek-ai/dsh@0.1.4' }),
    ).toEqual({
      command: 'bunx',
      args: ['-y', '@deepseek-ai/dsh@0.1.4', '--profile', 'acp'],
    })
  })

  it('非法值回落缺省（空格/shell 元字符，回落同样带 @latest）', () => {
    for (const bad of ['', '   ', 'pkg with-space', 'pkg;rm -rf', 'pkg$(id)', 'pkg|tee', 'pkg`id`']) {
      expect(resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_PACKAGE: bad })).toEqual({
        command: 'bunx',
        args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
      })
    }
  })

  it('adapter 经 resolveSpawnCommand 接线（spawn 目标覆盖 precedent 照抄 cursor）', () => {
    expect(deepseekAdapter.resolveSpawnCommand).toBeTypeOf('function')
  })
})

describe('deepseek DSH_BIN 稳定安装覆盖', () => {
  it('JS 入口走当前 node（路径含空格也不经 shell）', () => {
    const bin = 'D:\\Program Files\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
    expect(resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_BIN: bin })).toEqual({
      command: process.execPath,
      args: [bin, '--profile', 'acp'],
    })
  })

  it('DSH_BIN 优先于 DSH_PACKAGE 与缺省 @latest', () => {
    expect(
      resolveDeepseekSpawnCommand({
        ...NO_PATCH,
        DSH_BIN: 'dsh',
        DSH_PACKAGE: '@deepseek-ai/dsh@0.1.4',
      }),
    ).toEqual({ command: 'dsh', args: ['--profile', 'acp'] })
  })

  it('不存在的绝对路径回落包解析', () => {
    expect(
      resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_BIN: 'D:\\nope\\dsh.cmd' }),
    ).toEqual({
      command: 'bunx',
      args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
    })
  })

  it('含 shell 元字符的 DSH_BIN 回落包解析', () => {
    for (const bad of ['dsh; rm -rf /', 'dsh && whoami', 'dsh$(id)']) {
      expect(resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_BIN: bad })).toEqual({
        command: 'bunx',
        args: ['-y', `${DEEPSEEK_DSH_NPM_PACKAGE}@latest`, '--profile', 'acp'],
      })
    }
  })
})

describe('deepseek 用户级稳定安装（迁移默认路径）', () => {
  it('命中稳定安装时用当前 node 直跑，且优先于 bunx', () => {
    const { root, entry } = fakeManagedRuntime()
    const resolved = resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_RUNTIME_DIR: root })
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.args.slice(0, 3)).toEqual([entry, '--profile', 'acp'])
  })

  it('DSH_BIN 显式覆盖优先于稳定安装', () => {
    const { root, entry } = fakeManagedRuntime()
    const resolved = resolveDeepseekSpawnCommand({
      ...NO_PATCH,
      DSH_RUNTIME_DIR: root,
      DSH_BIN: 'dsh',
    })
    expect(resolved).toEqual({ command: 'dsh', args: ['--profile', 'acp'] })
    expect(resolved.args).not.toContain(entry)
  })

  it('稳定安装缺失时回落包解析', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'acp-dsh-empty-'))
    expect(
      resolveDeepseekSpawnCommand({ ...NO_PATCH, DSH_RUNTIME_DIR: emptyRoot }).command,
    ).toBe('bunx')
  })
})

describe('deepseek 模型覆盖层（可迁移，不碰用户 profile）', () => {
  it('缺省追加 --patch，指向临时目录里的覆盖文件', () => {
    const resolved = resolveDeepseekSpawnCommand({})
    const index = resolved.args.indexOf('--patch')
    expect(index).toBeGreaterThan(-1)
    const patchFile = resolved.args[index + 1]
    expect(patchFile).toContain('acp-model-')
    const body = readFileSync(patchFile!, 'utf8')
    expect(body).toContain('- id: acp')
    expect(body).toContain('model: deepseek-flash')
    expect(body).toContain('provider: deepseek-official')
    // --patch 必须排在 --profile acp 之后（启动器选项顺序）
    expect(resolved.args.slice(resolved.args.indexOf('--profile'))).toEqual([
      '--profile',
      'acp',
      '--patch',
      patchFile,
    ])
  })

  it('DSH_ACP_MODEL_PATCH=off 时不追加覆盖层', () => {
    expect(resolveDeepseekSpawnCommand({ ...NO_PATCH }).args).not.toContain('--patch')
  })

  it('DSH_MODEL / DSH_PROVIDER 可改目标，非法值回落缺省', () => {
    const custom = resolveDeepseekSpawnCommand({ DSH_MODEL: 'deepseek-v4-pro' })
    const patchFile = custom.args[custom.args.indexOf('--patch') + 1]!
    expect(readFileSync(patchFile, 'utf8')).toContain('model: deepseek-v4-pro')

    const bad = resolveDeepseekSpawnCommand({ DSH_MODEL: 'x: y' })
    const badFile = bad.args[bad.args.indexOf('--patch') + 1]!
    expect(readFileSync(badFile, 'utf8')).toContain('model: deepseek-flash')
  })
})
