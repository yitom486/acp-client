/** Real OpenCode ACP and SDK MCP; only model responses are deterministic local SSE.
 * No real API key is used. All config files live in a disposable test directory.
 * OpenCode 1.x config; unsupported versions fail before prompting. */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AcpClient } from '../dist/index.js';
const executable = process.argv[2];
if (!executable) throw new Error('Usage: bun scripts/smoke-opencode-resources.mjs <absolute-opencode-executable>');
const root = mkdtempSync(join(tmpdir(), 'acp-opencode-review-'));
const workspace = join(root, 'workspace');
const resources = join(root, 'resources');
mkdirSync(workspace); spawnSync('git', ['init', '--quiet', workspace], { windowsHide: true }); mkdirSync(join(resources, 'skills', 'review-skill'), { recursive: true });
const rulesToken = 'RULES_' + randomBytes(5).toString('hex');
const bodyToken = 'SKILL_BODY_' + randomBytes(5).toString('hex');
writeFileSync(join(resources, 'AGENTS.md'), `Host rules marker: ${rulesToken}. Use the SDK app skills tools when asked.\n`);
writeFileSync(join(resources, 'skills/review-skill/SKILL.md'), `---\nname: review-skill\ndescription: Read the review marker from this skill.\n---\n${bodyToken}\n`);
const evidence = { requests: [], toolNames: [], rulesSeen: false, skillBodySeen: false, result: '', notifications: 0 };
function textOf(content) { return typeof content === 'string' ? content : JSON.stringify(content ?? ''); }
const server = createServer(async (req, res) => {
  if(req.method === 'GET') { console.log('mock-discovery', req.url); res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({models:[{type:'llm',key:'review-model',display_name:'Review',loaded_instances:[],max_context_length:32000,capabilities:{vision:false,trained_for_tool_use:true}}]})); return; } let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const names = tools.map(t => t.function?.name ?? t.name);
  evidence.toolNames = names;
  const nativeSkillTurn = textOf(messages.findLast(m=>m.role==='user')?.content).includes('NATIVE_SKILL_TURN');
  const nativeSkill = tools.find(t=>t.function?.name==='skill');
  if(nativeSkillTurn && !nativeSkill) {res.writeHead(400, {'content-type':'application/json'}).end(JSON.stringify({error:{message:'Native skill tool is missing'}})); return;}
  evidence.rulesSeen ||= messages.some(m => textOf(m.content).includes(rulesToken));
  const lastUser = messages.findLastIndex(m => m.role === 'user');
  const responses = messages.slice(lastUser + 1).filter(m => m.role === 'tool');
  const read = responses.map(m => textOf(m.content)).join('\n').match(/SKILL_BODY_[a-f0-9]+/);
  evidence.skillBodySeen ||= !!read;
  const listTool = names.find(n => /app_list_skills$/.test(n));
  const readTool = names.find(n => /app_read_skill$/.test(n));
  evidence.requests.push({ path: req.url, tools: names, toolResponses: responses.length, rulesCopies: messages.filter(m => textOf(m.content).includes(rulesToken)).length, compatCopies: messages.filter(m=>textOf(m.content).includes('<acp-compat-context')).length, rulesInSystem: messages.some(m=>m.role==='system' && textOf(m.content).includes(rulesToken)) });
  let delta, finish;
  if (nativeSkillTurn && !read && responses.length > 0) {
    delta={role:'assistant',content:'NATIVE_SKILL_READ_FAILED'}; finish='stop';
  } else if (nativeSkillTurn && !read) {
    delta = {role:'assistant',tool_calls:[{index:0,id:'native_skill_'+evidence.requests.length,type:'function',function:{name:'skill',arguments:JSON.stringify({name:'review-skill'})}}]}; finish='tool_calls';
  } else if (!listTool || !readTool) {
    delta = { role: 'assistant', content: 'PROBE_NO_SKILL_TOOLS' }; finish = 'stop';
  } else if (responses.length === 0) {
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'probe_list_' + evidence.requests.length, type: 'function', function: { name: listTool, arguments: '{}' } }] }; finish = 'tool_calls';
  } else if (!read) {
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'probe_read_' + evidence.requests.length, type: 'function', function: { name: readTool, arguments: '{"name":"review-skill"}' } }] }; finish = 'tool_calls';
  } else {
    delta = { role: 'assistant', content: 'READ_OK:' + read[0] }; finish = 'stop';
  }
  const common = { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'review-model' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const mockConfig = { model: "lmstudio/review-model", provider: { lmstudio: { npm: "@ai-sdk/openai-compatible", name: "Local review", options: {baseURL: `http://127.0.0.1:${port}/v1`, apiKey:"local-test-only"}, models:{"review-model":{name:"Review",tool_call:true,limit:{context:32000,output:2000}}}}}};
const testEnv = { ACP_REVIEW_API_KEY: 'local-test-only', XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_STATE_HOME: join(root, 'xdg-state') };
mkdirSync(join(testEnv.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
writeFileSync(join(workspace, 'opencode.jsonc'), JSON.stringify(mockConfig));
writeFileSync(join(testEnv.XDG_CONFIG_HOME, 'opencode', 'opencode.jsonc'), JSON.stringify(mockConfig));
const client = new AcpClient({
  runtime: { id: 'opencode', name: 'OpenCode local', description: 'Real OpenCode with local mock model', command: executable, args: ['acp'], requiredEnvKeys: [] },
  workspaceRoot: workspace, resources: { directory: resources, configurationScope: process.argv.includes('--session-config') ? 'session' : 'overlay' }, dataDir: join(root, 'sdk'),
  env: testEnv,
  callbacks: {
    onSessionUpdate: p => { evidence.notifications++; const u = p.update; if (u?.sessionUpdate === 'agent_message_chunk') evidence.result += u.content?.text ?? ''; },
    onPermissionRequest: async p => { const option = p.params.options?.find(o => o.kind?.startsWith('allow')); return option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' }; },
    onStderrLine: line => { if (/error|failed|invalid/i.test(line)) console.log('runtime-error:', line.slice(0, 300)); },
  },
});
let session;
let isolatedDirectory;
try {
  console.log('starting real OpenCode');
  const connected = await client.connect();
  if (!connected.ok) throw new Error('connect: ' + connected.error.message);
  console.log('initialized', JSON.stringify(client.initializeResponse?.agentInfo));
  const created = await client.createSession();
  if (!created.ok) throw new Error('session: ' + created.error.message);
  session = created.value;
  isolatedDirectory=session.resourceReport?.configurationDirectory;
  if(!session.resourceReport?.rulesApplied && session.resourceReport?.configurationScope !== 'session') throw new Error('Native resource binding was not applied');
  const modelOption = session.configOptions?.find(o => o.id === 'model');
  const localAvailable = JSON.stringify(modelOption?.options).includes('lmstudio/review-model');
  console.log('session', JSON.stringify({ report: session.resourceReport, model: modelOption?.currentValue, localAvailable }));
  if (!localAvailable) throw new Error('Local test model not available; no prompt sent');
  const chosen = await session.setConfigOption('model', 'lmstudio/review-model');
  if (!chosen.ok || !JSON.stringify(chosen.value).includes('lmstudio/review-model')) throw new Error('Cannot confirm local mock model; no prompt sent');
  const result = await session.prompt('List the application skills, read review-skill, and return its exact marker.', { timeoutMs: 45000 });
  console.log('prompt', JSON.stringify(result));
  console.log('evidence', JSON.stringify({ ...evidence, result: evidence.result.replaceAll(bodyToken, '<BODY_FROM_FILE>') }));
  if (!result.ok || !evidence.rulesSeen || !evidence.skillBodySeen || !evidence.result.includes(bodyToken)) throw new Error('OpenCode resource chain not verified');
  evidence.result = '';
  const boundary = evidence.requests.length;
  const second = await session.prompt('SECOND_TURN: list skills and read review-skill again.', { timeoutMs: 45000 });
  const repeated = evidence.requests.slice(boundary).filter(r => r.tools.length > 0);
  if (!second.ok || !evidence.result.includes(bodyToken) || !repeated.length || repeated.some(r => r.rulesCopies !== 1)) throw new Error('Second turn or non-repeated rules check failed');
  evidence.result='';
  const native = await session.prompt('NATIVE_SKILL_TURN: use the native skill tool to read review-skill.', {timeoutMs:45000});
  if(!native.ok || !evidence.result.includes(bodyToken)) throw new Error('Native skill read failed');
  const modelCalls=evidence.requests.filter(r=>r.tools.length>0);
  if(modelCalls.some(r=>r.compatCopies!==0 || !r.rulesInSystem)) throw new Error('Rules were not delivered exclusively through native system context');
  console.log('PASS native rule/skill delivery, zero user compatibility blocks');
  console.log('PASS real OpenCode + mock model: rule delivery, MCP list/read, second turn without duplicate rules');
} finally {
  if (session && client.initializeResponse?.agentCapabilities?.sessionCapabilities?.close) {
    try { await client.agent.request('session/close', { sessionId: session.sessionId }); } catch {}
  }
  await client.disconnect();
  await new Promise(resolve => server.close(resolve));
  let cleanupError;
  for (let i=0;i<30;i++) {
    try { rmSync(root, {recursive:true,force:true}); cleanupError = undefined; break; }
    catch(error) { cleanupError = error; await new Promise(r=>setTimeout(r,100)); }
  }
  if (isolatedDirectory && existsSync(isolatedDirectory)) throw new Error('Isolated configuration directory was not cleaned: '+isolatedDirectory);
  if (cleanupError) throw new Error('Test fixture still locked: '+root, {cause:cleanupError});
}












