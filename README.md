# @yitom/acp-client — Headless ACP (Agent Client Protocol) SDK

通用的 **ACP (Agent Client Protocol)** 纯 TypeScript / Node.js 客户端 SDK。零 UI / 零 Electron 强依赖，可独立打包发布到 NPM，在任何命令行 CLI、Node.js 后端服务、Electron 或 Tauri 桌面端中跨项目直接调用。

---

## 📚 详细文档导航

为了方便在不同场景下深入接入与定制，我们在 [`docs/`](./docs/) 目录下提供了专项详细指南：

| 文档 | 链接 | 内容说明 |
| :--- | :--- | :--- |
| **快速入门** | [Getting Started](./docs/getting-started.md) | 在 CLI 工具、Web/后端服务、Electron 主进程中接入的标准范式 |
| **API 参考** | [API Reference](./docs/api-reference.md) | `AcpClient` 构造参数、方法、事件回调接口与会话控制详述 |
| **新增 Agent 适配** | [Adding an Agent](./docs/adding-an-agent.md) | 插件式适配器开发指南（如何为新 Agent 编写凭证探测与 CLI 接线） |
| **Tauri 集成实战** | [Tauri Integration](./docs/tauri-integration.md) | 通过 Bun 编译独立单文件二进制，作为 Tauri Sidecar 伴生进程运行 |

---

## ⚡ 核心特性

- **多 Agent 统一适配（8 大主流运行时）**：
  开箱即用支持 `codex-acp` (ChatGPT)、`claude`、`cursor-cli`、`deepseek`、`gemini`、`copilot`、`opencode`、`agy`。新增 Agent 只需在该包实现一个适配器，全局所有项目自动生效。
- **纯 Node.js / Headless 架构**：
  不依赖任何 Electron API、React 或特定前端框架。配置目录跨平台自动检测回落（支持自定义 `dataDir`）。
- **生命周期全托管**：
  负责跨平台后台进程拉起（Windows PID 级联杀进程）、Stdio ndJson 传输桥接、协议初始化（Initialize 握手）、温进程池长驻复用、错误诊断（stderr 尾部日志聚合）。
- **会话状态机与容错**：
  自动处理 `resume` → `load` → `new` 会话恢复流程，处理模型方言（models 数组/对象）、无 MCP 自动降级与网络抖动重试。
- **解耦的事件钩子与审批**：
  工具调用审批、权限请求、会话流式更新采用标准的回调与事件驱动，宿主自由决定如何确认（命令行交互 / 桌面弹窗 / Web 消息）。
- **应用资源目录（单目录接口）**：
  宿主只传 `resources: { directory }`（`AGENTS.md` + `skills/<name>/SKILL.md`），SDK 负责读取、摘要、配置合并、资格/版本门、会话级记录与温复用标签；详见 `docs/api-reference.md §5` 与 `examples/app-resources-demo.ts`。

---

## 🤖 运行时与认证支持矩阵

| 运行时 ID | 显示名称 | 本机凭据探测路径 / 环境变量 | 预检 / 启动特性 |
| :--- | :--- | :--- | :--- |
| `codex-acp` | ChatGPT | `~/.codex/auth.json` / 自定义供应商 API Key | 支持隔离 `CODEX_HOME` 生成 `config.toml` |
| `claude` | Claude | `~/.claude.json` / `ANTHROPIC_API_KEY` | 自动复用本机 Claude Code CLI 登录态 |
| `cursor-cli` | Cursor | `CURSOR_API_KEY` / 系统 Keychain 登录态 | 自动探测 `%LOCALAPPDATA%\cursor-agent\agent.cmd` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` 或 `~/.dsh/.credentials.yaml` | 缺凭证提前判停；`DSH_BIN` 指向稳定安装，`DSH_PACKAGE` pin 版本 |
| `gemini` | Gemini | `~/.gemini/oauth_creds.json` / `GEMINI_API_KEY` | 自动探测 OAuth 凭证与系统 Key |
| `copilot` | Copilot | `~/.copilot/config.json` / `GH_TOKEN` | 自动提取 `loggedInUsers` 凭证列表 |
| `opencode` | OpenCode | `$XDG_DATA_HOME/opencode/auth.json` | 遵循 XDG / `%LOCALAPPDATA%` 规范 |
| `agy` | agy | 官方桥接器免密直连 | `tryDirectSessionFirst` 免鉴权直通 |

### DeepSeek（dsh）在新机器上接入

不需要改任何本机 profile，三步即可复现：

```bash
node scripts/setup-dsh-acp.mjs     # 装/复用用户级运行时并自检 ACP 握手
export DEEPSEEK_API_KEY=sk-...     # 或在 dsh/桌面版里登录（二选一）
```

如果用户本机根本没装/没登录 harness，宿主可以直接用内置的「URL + Token」表单，免环境变量：

```typescript
import { saveDeepseekProvider, getDeepseekProviderStatus } from '@yitom/acp-client'

getDeepseekProviderStatus() // { configured, baseUrl?, isOfficial, hasApiKey }
saveDeepseekProvider({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-...' }) // URL 留空即官方端点
```

SDK 会按 `DSH_BIN` → 用户级稳定安装（自动取已装最高版本）→ `DSH_PACKAGE` → `bunx` 的顺序解析启动目标，并在 spawn 时附加 `--patch` 覆盖层把会话模型修正为 `deepseek-flash`（= DeepSeek-V4.1-Flash；桌面端的 `1017` 只是 UI 徽标）。详见 [API 参考 §DeepSeek](./docs/api-reference.md)。

---

## 🚀 快速上手 (1 分钟代码)

```typescript
import { AcpClient } from '@yitom/acp-client'

// 1. 初始化客户端
const client = new AcpClient({
  runtime: 'cursor-cli', // 或 'claude' | 'codex-acp' | 'deepseek' 等
  workspaceRoot: process.cwd(),
  clientInfo: {
    name: 'my-custom-cli',
    version: '1.0.0',
  },
  callbacks: {
    onStatusChange: (status, detail) => {
      console.log(`[Status] -> ${status}`, detail ?? '')
    },
    onPermissionRequest: async ({ toolCall, params }) => {
      console.log(`Agent 请求调用工具:`, toolCall)
      // 交互式批准（y）或自动放行：协议层只有 selected/cancelled，
      // 允许项用 pickAllowOptionId 从 Agent 给的 options 里挑（无 'approved'）。
      return pickAllowOptionId(params)
        ? { outcome: 'selected' as const, optionId: pickAllowOptionId(params)! }
        : { outcome: 'cancelled' as const }
    },
    onSessionUpdate: (event) => {
      console.log(`[Stream Event]:`, event)
    },
  },
})

// 2. 启动并连接 Agent
const connectResult = await client.connect()
if (!connectResult.ok) {
  console.error('连接失败:', connectResult.error)
  return
}

// 3. 创建/恢复会话
const sessionResult = await client.createSession()
if (sessionResult.ok) {
  const session = sessionResult.data
  // 4. 发送提示词 / 消息交互
  await session.prompt('请帮我分析当前项目目录结构')
}

// 5. 随时安全断开连接（清理孤儿进程）
await client.disconnect()
```

---

## ⌨️ 斜杠命令（available_commands_update）

Agent 推送的 `available_commands_update` 会原样经 `onSessionUpdate` 透传，同时按会话缓存最新列表（含 `name` / `description` / `input.hint`），
即使宿主还没拿到 sessionId 也不会丢：

```ts
const handle = (await client.createSession()).value
const cmds = handle.availableCommands ?? (await client.waitForAvailableCommands(handle.sessionId, 500))
// 调用命令 = 普通文本 prompt（ACP 规范）
await handle.prompt(formatCommandPrompt('review', 'main')) // "/review main"
```

Sidecar：`session/open` 结果带 `availableCommands`（若已收到），并新增 `session/commands` 查询方法。

## 📦 打包构建

在本包根目录一键构建生成 `dist`（ESM / CJS / `.d.ts`）：

```bash
bun run build:acp
```

产物说明：
- `dist/index.js`：ESM 格式，适合现代构建工具（Vite、Webpack）与 ESM Node.js 环境；
- `dist/index.cjs`：CommonJS 格式，适合传统 Node.js 环境（`require`）；
- `dist/index.d.ts`：完整 TypeScript 类型声明，支持 IDE 智能感知。

---

## 🧪 运行独立验证示例

我们在 [`examples/standalone-acp-demo.ts`](./examples/standalone-acp-demo.ts) 提供了可在终端直接运行的验证脚本：

```bash
bun run packages/acp/examples/standalone-acp-demo.ts
```

资源接口当前为未发布试点：规则准备与会话应用分开记录；已有磁盘配置保守回退；skillsFound 仅 SDK 文件扫描，尚无原生技能挂载或通用兼容提示词注入。详见 docs/api-reference.md 第 5 节。

应用资源跨运行时验收：OpenCode 1.18.35 已通过真实 ACP + 本地 mock 模型 + 技能 MCP 两轮链路，复跑脚本为 `scripts/smoke-opencode-resources.mjs`；2.0.6 完整链路仍待验，详见 `docs/api-reference.md` 支持矩阵。

原生资源策略见 `src/resources/runtime-bindings.ts` / `docs/api-reference.md §5`：OpenCode 1.18.35 已验证原生 system 规则、native skill 和 MCP；Claude 0.91.0 已接官方原生会话扩展（仅源码契约+mock 验收）；其余运行时明确兼容，不自动迁移认证 HOME。

会话专属配置环境：`resources: { directory, configurationScope: 'session' }`。仅替换子进程原生配置根，生成规则/纯文档技能、断开清理；不复制用户认证。支持范围、Cursor 规则边界及 agy/DeepSeek 的明确拒绝见 `docs/api-reference.md`。实现与测试：`src/resources/session-config.ts` / `session-config.test.ts`。

### Antigravity session resources

With `@yitom/agy-acp-map` 0.1.24 / 0.1.25 / 0.1.26, `resources.directory` is delivered through the bridge session extension `_meta.appResources.directory`. Rules, native Skills and session MCP live in a private temporary additional workspace; cwd, global configuration and authentication remain unchanged. Close/delete/orderly shutdown remove the temporary workspace. Unknown bridge versions keep compatibility guidance and the app-skills MCP fallback. This extension is bridge-specific, not a standard ACP configuration-home API. `configurationScope: "session"` also supports agy; its configuration report remains conservative until the bridge accepts the session extension.

Normal disconnect closes owned sessions on agents advertising `sessionCapabilities.close` before terminating the transport/process. Requests are bounded to two seconds; failures are logged and teardown continues. This permits session resource cleanup on Windows as well.

### OpenCode ACP question compatibility

When a host supplies application resources, OpenCode 1.18.35 and 2.0.6 receive a child-process-only
OPENCODE_CONFIG_CONTENT overlay setting permission.question to deny. Its upstream ACP event
dispatcher omits native questions in 1.18.35 and cancels form.created in 2.0.6.
The v2 adapter prepares only the question overlay; native rules and skills remain unverified. The SDK preserves existing providers,
models, MCP servers, instructions and all unrelated permission rules, including shorthand
permission defaults. It never edits project/global OpenCode config files or authentication homes.
Overlay and isolated session configuration use the same policy.

Inspect resourceReport.openCodeQuestions: fallback + prepared means the overlay was prepared,
not proof that the runtime applied it. Unknown releases report unverified + unchanged; no semver
range or permission capability is treated as proof of question support. Hosts should provide
an available MCP question tool or a textual question, wait for the user, and keep security
approval separate. Standard ACP request_permission remains independent; elicitation support
is negotiated separately and is not implied by permissions or this fallback.

GitHub Actions builds and smoke-checks Linux, Windows and macOS packages and uploads a dist
artifact per OS. Only version-tag pushes publish to npm; branch/PR builds do not publish.

### 宿主接入的通用生命周期

`src/client/sdk-client.ts` 统一官方 SDK 流桥接、请求超时与方法类型推导；`connectSdkClient` 可传第四参 `{ name }`。`src/client/session-open.ts` 统一恢复/新建、原生扩展回退与有界工具输出恢复。`preserveMcpOnRetry: true` 保留重试时的 MCP 工具；缺省保持旧客户端的裸调回退策略。窗口、IPC、诊断日志由宿主提供，不进入协议包。
