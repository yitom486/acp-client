import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpClient } from './acp-client'
import { isAcpPermissionOutcome, pickAllowOptionId } from '../../../domain/session/permission'

describe('AcpClient Headless SDK', () => {
  it('prefers a one-time approval and requires a selection from the advertised options', () => {
    const options = [
      { kind: 'reject_once', optionId: 'reject' },
      { kind: 'allow_always', optionId: 'always' },
      { kind: 'allow_once', optionId: 'once' },
    ]
    expect(pickAllowOptionId({ options })).toBe('once')
    expect(pickAllowOptionId({ options: options.slice(0, 1) })).toBeNull()
    expect(isAcpPermissionOutcome({ outcome: 'selected', optionId: 'reject' }, { options })).toBe(true)
    expect(isAcpPermissionOutcome({ outcome: 'selected', optionId: 'unknown' }, { options })).toBe(false)
  })
  it('正确实例化默认客户端', () => {
    const client = new AcpClient({
      workspaceRoot: process.cwd(),
      clientInfo: {
        name: 'test-app',
        version: '1.0.0',
      },
    })

    expect(client).toBeDefined()
    expect(client.currentStatus).toBe('disconnected')
    expect(client.isConnected).toBe(false)
  })

  it('支持传入不同的运行时名称', () => {
    const runtimes = ['codex-acp', 'claude', 'cursor-cli', 'deepseek', 'gemini', 'copilot', 'opencode', 'agy', 'antigravity-cli']

    for (const runtime of runtimes) {
      const client = new AcpClient({
        runtime,
        workspaceRoot: process.cwd(),
      })
      expect(client).toBeDefined()
    }
  })

  it('传入未知运行时抛出明确错误', () => {
    expect(() => {
      new AcpClient({
        runtime: 'unknown-agent-xyz',
        workspaceRoot: process.cwd(),
      })
    }).toThrow('未知或未注册的 ACP 运行时模板: unknown-agent-xyz')
  })

  it('reuses cached auth and offers explicit ACP authentication when required', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'acp-client-auth-'))
    const fixture = `
      const readline = require('node:readline');
      let authenticated = process.env.TEST_AUTH_CACHED === '1';
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        if (id == null) return;
        const send = (reply) => console.log(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
        if (method === 'initialize') return send({ result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] } });
        if (method === 'authenticate' && params?.methodId === 'oauth-personal') {
          authenticated = true;
          return send({ result: {} });
        }
        if (method === 'session/new') return authenticated
          ? send({ result: { sessionId: 'test-session' } })
          : send({ error: { code: -32000, message: 'Authentication required' } });
        send({ error: { code: -32601, message: 'Method not found' } });
      });`

    try {
      for (const cached of [true, false]) {
        const client = new AcpClient({
          workspaceRoot,
          dataDir: workspaceRoot,
          runtime: {
            id: 'antigravity-cli', name: 'ACP fixture', description: 'ACP fixture',
            command: process.execPath, args: ['-e', fixture], requiredEnvKeys: [],
          },
          env: { TEST_AUTH_CACHED: cached ? '1' : '0' },
        })
        try {
          expect(await client.connect()).toMatchObject({
            ok: true,
            value: { init: { authMethods: [{ id: 'oauth-personal' }] } },
          })
          if (!cached) {
            expect(await client.createSession()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
            expect(await client.authenticate('unknown')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
            expect(await client.authenticate('oauth-personal')).toEqual({ ok: true, value: undefined })
          }
          expect(await client.createSession()).toMatchObject({ ok: true, value: { sessionId: 'test-session' } })
        } finally {
          await client.disconnect()
        }
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
