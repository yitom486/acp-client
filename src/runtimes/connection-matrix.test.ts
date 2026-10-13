import { describe, expect, it } from 'vitest'
import { BUILTIN_ACP_RUNTIMES } from "../contracts"
import { getAcpRuntimeAdapter } from './index'

/**
 * 连接矩阵（纯静态不断网可测）：模板完整性＋适配器↔模板一致性。
 * live 连接结论见排障记录（需本机 CLI/凭证，CI 不跑）：
 * codex-acp/opencode v1/v2 已实机建会话读表；deepseek 缺 Key 时秒回可读错；
 * claude/gemini/copilot/cursor/agy 仅门级验证（无凭证不触达 spawn）。
 */
describe('runtimes/connection-matrix', () => {
  it('全部内置模板可 spawn：command 非空、args 数组、描述齐全', () => {
    expect(BUILTIN_ACP_RUNTIMES.length).toBeGreaterThan(0)
    for (const runtime of BUILTIN_ACP_RUNTIMES) {
      expect(typeof runtime.id, `${runtime.id} 缺 id`).toBe('string')
      expect(runtime.command.trim().length, `${runtime.id} 缺 command`).toBeGreaterThan(0)
      expect(Array.isArray(runtime.args), `${runtime.id} args 非数组`).toBe(true)
      expect(typeof runtime.description, `${runtime.id} 缺 description`).toBe('string')
      expect(typeof runtime.authHint, `${runtime.id} 缺 authHint`).toBe('string')
      expect(Array.isArray(runtime.requiredEnvKeys), `${runtime.id} requiredEnvKeys 非数组`).toBe(true)
    }
  });

  it('模板 id 与适配器 id 双向一致（任一漂移即连接错位）', () => {
    for (const runtime of BUILTIN_ACP_RUNTIMES) {
      const adapter = getAcpRuntimeAdapter(runtime.id)
      expect(adapter.id).toBe(runtime.id)
    }
  });

  it('opencode v1/v2：独立产品线，启动方式不同（v2 禁 bunx：postinstall 被拦）', () => {
    const v1 = BUILTIN_ACP_RUNTIMES.find((r) => r.id === 'opencode')
    const v2 = BUILTIN_ACP_RUNTIMES.find((r) => r.id === 'opencode-v2')
    expect(v1).toBeDefined()
    expect(v2).toBeDefined()
    expect(v1!.command).not.toBe(v2!.command)
    expect(JSON.stringify(v1!.args)).toContain('acp')
    expect(JSON.stringify(v2!.args)).toContain('acp')
    // v2 走 npx（@opencode/cli postinstall 落二进制）；bunx 会拦 postinstall
    expect(v2!.command.toLowerCase()).not.toContain('bunx')
    expect(getAcpRuntimeAdapter('opencode-v2').id).toBe('opencode-v2')
  });

  it('Key 制运行时声明 env 键（缺 Key 门秒拦的依据）', () => {
    const deepseek = BUILTIN_ACP_RUNTIMES.find((r) => r.id === 'deepseek')
    expect(deepseek!.requiredEnvKeys).toContain('DEEPSEEK_API_KEY')
    const codex = BUILTIN_ACP_RUNTIMES.find((r) => r.id === 'codex-acp')
    expect(codex!.requiredEnvKeys.length).toBeGreaterThan(0)
  });
});
