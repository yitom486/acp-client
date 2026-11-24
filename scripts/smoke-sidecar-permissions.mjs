import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const workspaceRoot = await mkdtemp(join(tmpdir(), 'acp-permissions-smoke-'))
const fixture = join(workspaceRoot, 'agent.cjs')
await writeFile(fixture, String.raw`
  const { createInterface } = require('node:readline');
  const name = process.argv[2];
  const send = (fields) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\n');
  const pending = new Map();
  let receivedCancel = false;
  createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params, result } = JSON.parse(line);
    if (!method && pending.has(id)) {
      const promptId = pending.get(id);
      pending.delete(id);
      send({ id: promptId, result: {
        stopReason: result?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn',
        _meta: { permission: result?.outcome, receivedCancel },
      } });
    } else if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, authMethods: [],
        agentInfo: { name, version: '1' }, agentCapabilities: { sessionCapabilities: { close: {} } },
      } });
    } else if (method === 'session/new') {
      send({ id, result: { sessionId: 'fixture-session' } });
    } else if (method === 'session/close') {
      setTimeout(() => send({ id, result: {} }), 75);
    } else if (method === 'session/prompt') {
      receivedCancel = false;
      const permissionId = 'permission-' + id;
      pending.set(permissionId, id);
      send({ id: permissionId, method: 'session/request_permission', params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tool-' + id, title: 'Execute fixture command', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny once', kind: 'reject_once' },
        ],
      } });
    } else if (method === 'session/cancel') {
      if (id !== undefined) throw new Error('session/cancel must be a notification');
      receivedCancel = true;
    }
  });
`)

const sidecar = spawn(process.execPath, [fileURLToPath(new URL('../dist/sidecar.cjs', import.meta.url))], {
  cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'inherit'],
})
const closed = once(sidecar, 'close')
const stream = createInterface({ input: sidecar.stdout })
const messages = []
let pendingMessage
let id = 0
stream.on('line', (line) => {
  const message = JSON.parse(line)
  if (pendingMessage?.predicate(message)) pendingMessage.finish(message)
  else messages.push(message)
})

function receive(predicate) {
  const index = messages.findIndex(predicate)
  if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMessage = undefined
      reject(new Error('Timed out waiting for sidecar response'))
    }, 5000)
    pendingMessage = { predicate, finish: (message) => {
      clearTimeout(timer)
      pendingMessage = undefined
      resolve(message)
    } }
  })
}

function send(method, params) {
  const requestId = ++id
  sidecar.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  return requestId
}

const reply = (requestId) => receive((message) => message.id === requestId)
const rpc = (method, params) => reply(send(method, params))
const connectOptions = (name) => ({
  runtime: 'antigravity-cli', workspaceRoot, dataDir: workspaceRoot,
  customCommand: process.execPath, customArgs: [fixture, name],
})
const permission = async () => (await receive((message) => message.method === 'permission/request')).params
const choose = (requestId, optionId) => rpc('permission/respond', {
  requestId, outcome: { outcome: 'selected', optionId },
})

try {
  const connected = await rpc('client/connect', connectOptions('fixture'))
  assert.equal(connected.result.initResponse.agentInfo.name, 'fixture')
  const { sessionId } = (await rpc('session/open', {})).result
  const startPrompt = () => send('session/prompt', { sessionId, promptText: 'Run the fixture tool' })

  for (const optionId of ['deny', 'allow']) {
    const promptId = startPrompt()
    const request = await permission()
    assert.equal(request.sessionId, sessionId)
    assert.deepEqual(request.options.map((option) => option.kind), ['allow_once', 'reject_once'])
    assert.equal((await choose(request.requestId, 'unknown')).error.code, -32602)
    assert.equal((await choose(request.requestId, optionId)).result.success, true)
    assert.deepEqual((await reply(promptId)).result.result._meta.permission, { outcome: 'selected', optionId })
  }

  const promptId = startPrompt()
  const request = await permission()
  assert.equal((await rpc('session/cancel', { sessionId })).result.success, true)
  const withdrawal = await receive((message) => message.method === 'permission/cancelled')
  assert.equal(withdrawal.params.requestId, request.requestId)
  assert.equal(withdrawal.params.reason, 'session_cancelled')
  const cancelled = (await reply(promptId)).result.result
  assert.equal(cancelled.stopReason, 'cancelled')
  assert.equal(cancelled._meta.receivedCancel, true)
  assert.equal((await choose(request.requestId, 'allow')).error.code, -32007)

  const pendingPrompt = startPrompt()
  const pending = await permission()
  const earlier = send('client/connect', connectOptions('earlier'))
  const later = send('client/connect', connectOptions('later'))
  const replaced = await receive((message) => message.method === 'permission/cancelled')
  assert.equal(replaced.params.requestId, pending.requestId)
  assert.equal(replaced.params.reason, 'connection_closed')
  await reply(pendingPrompt)
  assert.equal((await reply(earlier)).error.code, -32800)
  assert.equal((await reply(later)).result.initResponse.agentInfo.name, 'later')
  assert.equal((await choose(pending.requestId, 'allow')).error.code, -32007)

  console.log('SMOKE OK: sidecar permission choices, cancellation, and connection switching')
} finally {
  sidecar.stdin.end()
  const deadline = setTimeout(() => sidecar.kill(), 3000)
  await closed
  clearTimeout(deadline)
  stream.close()
  await rm(workspaceRoot, { recursive: true, force: true })
}
