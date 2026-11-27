/**
 * Mock ACP peer（无模型 JSON-RPC 夹具，供 SDK 兼容/技能链路测试）：
 * - initialize：版本取 MOCK_BRIDGE_VERSION（缺省 2.2.2），能力 load+resume；
 * - session/new|load|resume：记录 params（含 mcpServers），回 sessionId；
 * - session/prompt：命令式脚本——
 *   __describe__ 返回观测状态（env 注入、mcp 列表、收到的 prompt 标记统计）；
 *   __fail_once__ 首调返回错误，之后成功（取消/失败重试记账用）；
 *   __hold__ 延迟 150ms（忙时行为用）；
 *   其他返回 end_turn + 回显标记（hasCompatMarker/首块前缀/字符数）。
 * 与 review-agent.mjs 相互独立；只读自身进程 env（注入证据），不触达网络与用户文件。
 */
import { createInterface } from 'node:readline';

const state = { prompts: [], news: [], failedOnce: false };
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const respondError = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');

function promptFlags(blocks) {
  const first = blocks[0]?.text ?? '';
  return {
    blocks: blocks.length,
    firstChars: first.slice(0, 120),
    hasCompatMarker: first.includes('<acp-compat-context'),
    markerProfile: (first.match(/profile="([0-9a-f]+)"/) || [])[1] || null,
    totalChars: blocks.map((b) => (b.text ?? '').length).reduce((a, b) => a + b, 0),
  };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!('id' in msg)) return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (process.env.MOCK_FAIL_INITIALIZE === '1') { process.stderr.write('TEST_CONFIG_DIR:'+process.env.CLAUDE_CONFIG_DIR+'\n'); respondError(id,'initialize rejected'); return; }
    respond(id, {
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: 'compat-agent', version: process.env.MOCK_BRIDGE_VERSION || '2.2.2' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    });
  } else if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
    if (process.env.MOCK_REJECT_NATIVE === '1' && params._meta) { respondError(id, 'native meta rejected'); return; }
    if (process.env.MOCK_REJECT_MCP === '1' && params.mcpServers?.length) { respondError(id, 'MCP descriptors rejected'); return; }
    state.news.push({
      method,
      nativeMeta: params._meta || null,
      sessionId: params.sessionId || null,
      mcpNames: (params.mcpServers || []).map((s) => s && s.name).filter(Boolean),
      mcpCount: (params.mcpServers || []).length,
    });
    respond(id, { sessionId: params.sessionId || 'compat-session', configOptions: [] });
  } else if (method === 'session/prompt') {
    const text = params.prompt?.map((b) => b.text ?? '').join('\n') ?? '';
    const flags = promptFlags(params.prompt || []);
    state.prompts.push({ sessionId: params.sessionId, ...flags });
    if (text.includes('__describe__')) {
      respond(id, {
        stopReason: 'end_turn',
        describe: {
          codexConfigHasHost: (process.env.CODEX_CONFIG || '').includes('HOST_RULES_MARKER'),
          configEnv: Object.fromEntries(['CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','COPILOT_HOME','CURSOR_CONFIG_DIR','XDG_CONFIG_HOME'].map(k=>[k,process.env[k]||null])),
          extraEnvSeen: process.env.MONTREE_COMPAT_PROBE_ENV || null,
          news: state.news,
          prompts: state.prompts,
        },
      });
    } else if (text.includes('__fail_once__') && !state.failedOnce) {
      state.failedOnce = true;
      respondError(id, 'injected once failure');
    } else if (text.includes('__hold__')) {
      setTimeout(() => respond(id, { stopReason: 'end_turn', pid: process.pid, ...flags }), 150);
    } else {
      respond(id, {
        stopReason: 'end_turn',
        pid: process.pid,
        userTextIntact: text.includes('PING-KEEP'),
        ...flags,
      });
    }
  } else {
    respond(id, {});
  }
});
