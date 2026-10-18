import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../client/acp-client';
import { codexAdapter } from '../runtimes/codex';
import { mergeConfigTomlPreserving } from './config-text';

const dirs: string[] = [];
const clients: AcpClient[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.disconnect(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function resourceDir() { const d = mkdtempSync(join(tmpdir(), 'acp-review-')); dirs.push(d); writeFileSync(join(d, 'AGENTS.md'), 'HOST_RULES'); return d; }
function client(directory: string, version = '2.2.2') {
  const c = new AcpClient({ runtime: { id: 'codex-acp', name: 'review', description: 'no model fixture', command: process.execPath, args: [join(import.meta.dirname, 'fixtures/review-agent.mjs')], requiredEnvKeys: [] }, workspaceRoot: process.cwd(), dataDir: directory, env: { CODEX_HOME: directory, CODEX_CONFIG: JSON.stringify({ developer_instructions: 'EXTRA_ENV_USER' }), REVIEW_BRIDGE_VERSION: version }, resources: { directory } });
  clients.push(c); return c;
}
describe('SDK resource review regressions', () => {
  it('TOML 合并保留真实顶层位置与其他表，复杂规则拒绝改写', () => {
    const args = { managedTopKeys: ['model'], managedTables: ['provider.mine'], replacementBlock: 'model = "new"\n[provider.mine]\nname = "fresh"' };
    const text = mergeConfigTomlPreserving({ ...args, existingText: 'model = "old"\n[other]\nvalue = 1' });
    const parsed = JSON.parse(execFileSync('bun', ['-e', 'process.stdout.write(JSON.stringify(Bun.TOML.parse(await Bun.stdin.text())))'], { input: text, encoding: 'utf8', windowsHide: true }));
    expect(parsed.model).toBe('new'); expect(parsed.other.value).toBe(1); expect(parsed.other.model).toBeUndefined();
    expect(() => mergeConfigTomlPreserving({ ...args, existingText: 'developer_instructions = """\n[other]\n"""' })).toThrow();
  });
  it('读取真正的最终 env；磁盘规则未经有效配置查询时不覆盖', async () => {
    const d = resourceDir();
    const prep = await codexAdapter.prepareAppResources!({ directory: d, workspaceRoot: process.cwd(), env: { CODEX_HOME: d, CODEX_CONFIG: '{"developer_instructions":"EXTRA_ENV_USER"}' } });
    expect(prep.report.rulesApplied).toBe(false); expect(prep.report.rulesPrepared).toBe(true);
    expect(JSON.parse(prep.env!.CODEX_CONFIG!).developer_instructions).toContain('EXTRA_ENV_USER');
    const original = 'developer_instructions = "DISK_USER"'; writeFileSync(join(d, 'config.toml'), original);
    const kept = await codexAdapter.prepareAppResources!({ directory: d, workspaceRoot: process.cwd(), env: { CODEX_HOME: d } });
    expect(kept.env).toBeUndefined(); expect(kept.report.reason).toBe('effective-config-not-verified');
    expect(readFileSync(join(d, 'config.toml'), 'utf8')).toBe(original);
  });
  it('真实 SDK/stdio 会话区分准备、新建、恢复与断开，不把 mock 当模型', async () => {
    const c = client(resourceDir()); expect((await c.connect()).ok).toBe(true);
    expect(c.resourceReport?.rulesApplied).toBe(false); expect(c.resourceReport?.rulesPrepared).toBe(true);
    const fresh = await c.createSession(); expect(fresh.ok).toBe(true); if (!fresh.ok) return;
    expect(fresh.value.resourceReport?.rulesApplied).toBe(true); expect(fresh.value.resourceReport?.skillsApplied).toBe(false);
    const result = await fresh.value.prompt('inspect'); expect(result.ok && (result.value as any).userKept).toBe(true);
    const resumed = await c.createSession({ resumeSessionId: fresh.value.sessionId });
    expect(resumed.ok && resumed.value.resourceReport?.rulesApplied).toBe(false);
    const held = fresh.value.prompt('hold'); expect((await c.connect()).ok).toBe(false); expect(c.isConnected).toBe(true); expect((await held).ok).toBe(true);
    await c.disconnect(); expect(c.resourceReport).toBeNull();
  });
  it('两个 SDK 实例不会复用同 runtime 的子进程，未知精确版本不宣称应用', async () => {
    const a = client(resourceDir()); const b = client(resourceDir(), '2.9.0');
    expect((await a.connect()).ok).toBe(true); const sa = await a.createSession(); if (!sa.ok) throw new Error('new failed');
    expect((await b.connect()).ok).toBe(true); const sb = await b.createSession(); if (!sb.ok) throw new Error('new failed');
    expect(sb.value.resourceReport?.rulesApplied).toBe(false);
    const pa = await sa.value.prompt('pid'); const pb = await sb.value.prompt('pid');
    expect(pa.ok && pb.ok).toBe(true); if (pa.ok && pb.ok) expect((pa.value as any).pid).not.toBe((pb.value as any).pid);
  });
  it('资源输入拒绝相对路径', () => {
    expect(() => new AcpClient({ workspaceRoot: process.cwd(), resources: { directory: './rules' } })).toThrow();
  });
});
