import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACP_CLIENT_VERSION } from '../../../version'
import { AcpClient } from './acp-client'

describe('AcpClient native activity timeout & options', () => {
  it('keeps prompt alive when session/update events reset idleTimeoutMs and times out only on true silence', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'acp-timeout-'))
    const fixture = `
      const readline = require('node:readline');
      const seenInit = [];
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.id == null) return;
        const send = (reply) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\\n');
        const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n');
        if (msg.method === 'initialize') {
          seenInit.push(msg.params.clientInfo);
          return send({ result: { protocolVersion: 1, authMethods: [], agentInfo: { name: 'mock', version: '1.0' } } });
        }
        if (msg.method === 'session/new') {
          return send({ result: { sessionId: 's-timeout-1' } });
        }
        if (msg.method === 'session/prompt') {
          const text = msg.params?.prompt?.[0]?.text || '';
          if (text === 'STREAM_LONG') {
            let count = 0;
            const iv = setInterval(() => {
              count += 1;
              notify('session/update', {
                sessionId: 's-timeout-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk-' + count } },
              });
              if (count >= 7) {
                clearInterval(iv);
                setTimeout(() => send({ result: { stopReason: 'end_turn', echoClientInfo: seenInit[0], envProxy: process.env.HTTP_PROXY || null } }), 20);
              }
            }, 40);
            return;
          }
          if (text === 'SILENT') {
            // Intentionally never responds so idle timeout fires
            return;
          }
          if (text === 'PERM_WAIT') {
            const permId = 'perm-' + msg.id;
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: permId,
              method: 'session/request_permission',
              params: {
                sessionId: 's-timeout-1',
                toolCall: { toolCallId: 'tc-1', title: 'Write file', kind: 'edit' },
                options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }],
              },
            }) + '\\n');
            // Wait for client's permission response stored on global map
            globalThis.__pendingPermMap = globalThis.__pendingPermMap || new Map();
            globalThis.__pendingPermMap.set(permId, msg.id);
            return;
          }
          if (text === 'LEGACY_HARD') {
            const iv = setInterval(() => {
              notify('session/update', {
                sessionId: 's-timeout-1',
                update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '.' } },
              });
            }, 35);
            setTimeout(() => {
              clearInterval(iv);
              send({ result: { stopReason: 'end_turn' } });
            }, 250);
            return;
          }
        }
        if (!msg.method && globalThis.__pendingPermMap?.has(msg.id)) {
          const promptId = globalThis.__pendingPermMap.get(msg.id);
          globalThis.__pendingPermMap.delete(msg.id);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: promptId,
            result: { stopReason: 'end_turn', outcome: msg.result?.outcome },
          }) + '\\n');
        }
      });`

    try {
      // 1. Default clientInfo + proxy override + streaming longer than idleTimeoutMs
      const client = new AcpClient({
        workspaceRoot,
        dataDir: workspaceRoot,
        proxy: { enabled: true, host: '127.0.0.1', port: 17890 },
        promptIdleTimeoutMs: 120,
        runtime: {
          id: 'antigravity-cli',
          name: 'Timeout Mock',
          description: 'Mock',
          command: process.execPath,
          args: ['-e', fixture],
          requiredEnvKeys: [],
        },
        callbacks: {
          onPermissionRequest: async () => {
            await new Promise((r) => setTimeout(r, 220))
            return { outcome: 'selected', optionId: 'allow_once' }
          },
        },
      })

      try {
        const conn = await client.connect()
        expect(conn.ok).toBe(true)
        const sess = await client.createSession()
        expect(sess.ok).toBe(true)
        if (!sess.ok) return

        // Streaming 7 chunks x 40ms (~300ms) with idleTimeoutMs=120 must succeed
        const streamRes = await sess.value.prompt('STREAM_LONG')
        expect(streamRes.ok).toBe(true)
        if (streamRes.ok) {
          const val = streamRes.value as { echoClientInfo?: { name?: string; version?: string }; envProxy?: string | null }
          expect(val.echoClientInfo).toEqual({ name: 'acp-client', version: ACP_CLIENT_VERSION })
          expect(val.envProxy).toBe('http://127.0.0.1:17890')
        }

        // Permission approval waiting 220ms (> idleTimeoutMs 100ms) pauses timer and succeeds
        const permRes = await sess.value.prompt('PERM_WAIT', { idleTimeoutMs: 100 })
        expect(permRes.ok).toBe(true)

        // Legacy explicit timeoutMs enforces hard wall-clock ceiling despite frequent updates
        const hardRes = await sess.value.prompt('LEGACY_HARD', { timeoutMs: 100 })
        expect(hardRes.ok).toBe(false)
        if (!hardRes.ok) {
          expect(hardRes.error.code).toBe('ACP_TIMEOUT')
          expect(hardRes.error.message).toContain('请求超时')
        }

        // True silence exceeds idleTimeoutMs -> ACP_TIMEOUT
        const silentRes = await sess.value.prompt('SILENT', { idleTimeoutMs: 100 })
        expect(silentRes.ok).toBe(false)
        if (!silentRes.ok) {
          expect(silentRes.error.code).toBe('ACP_TIMEOUT')
          expect(silentRes.error.message).toContain('请求超时')
        }
      } finally {
        await client.disconnect()
      }

      // 2. Explicit custom clientInfo propagation
      const customClient = new AcpClient({
        workspaceRoot,
        dataDir: workspaceRoot,
        clientInfo: { name: 'tele_bot', version: '0.2.0' },
        runtime: {
          id: 'antigravity-cli',
          name: 'Custom Info Mock',
          description: 'Mock',
          command: process.execPath,
          args: ['-e', fixture],
          requiredEnvKeys: [],
        },
      })
      try {
        await customClient.connect()
        const sess = await customClient.createSession()
        expect(sess.ok).toBe(true)
        if (sess.ok) {
          const res = await sess.value.prompt('STREAM_LONG')
          expect(res.ok).toBe(true)
          if (res.ok) {
            expect((res.value as any).echoClientInfo).toEqual({ name: 'tele_bot', version: '0.2.0' })
          }
        }
      } finally {
        await customClient.disconnect()
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
