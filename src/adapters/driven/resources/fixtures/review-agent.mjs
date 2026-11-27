import { createInterface } from 'node:readline';
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (!('id' in msg)) return;
  if (msg.method === 'initialize') respond(msg.id, { protocolVersion: 1, authMethods: [], agentInfo: { name: 'review-agent', version: process.env.REVIEW_BRIDGE_VERSION || '2.2.2' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } });
  else if (/^session\/(new|load|resume)$/.test(msg.method)) respond(msg.id, { sessionId: msg.params.sessionId || 'new-review-session', configOptions: [] });
  else if (msg.method === 'session/prompt') {
    const userKept = JSON.parse(process.env.CODEX_CONFIG || '{}').developer_instructions?.includes('EXTRA_ENV_USER');
    const result = { stopReason: 'end_turn', pid: process.pid, userKept: !!userKept };
    if (msg.params.prompt[0]?.text === 'hold') setTimeout(() => respond(msg.id, result), 100);
    else respond(msg.id, result);
  } else respond(msg.id, {});
});
