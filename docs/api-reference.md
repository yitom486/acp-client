# 完整 API 参考文档 (API Reference)

本文档详细列出 `@inkdown/acp` 导出的所有核心类、方法与类型定义。

---

## 1. `AcpClient` 类

管理单个 Agent 连接及其生命周期的核心门面类。

### 构造函数

```typescript
const client = new AcpClient(options: AcpClientOptions)
```

#### `AcpClientOptions` 参数说明

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `workspaceRoot` | `string` | **是** | Agent 工作区根目录（绝对路径） |
| `runtime` | `string \| AcpRuntimeInfo` | 否 | 运行时标识（如 `'codex-acp'`、`'cursor-cli'`、`'claude'`、`'deepseek'` 等），默认 `'codex-acp'` |
| `clientInfo` | `{ name: string; version?: string }` | 否 | 客户端身份声明，默认 `{ name: 'inkdown', version: '0.1.0' }` |
| `dataDir` | `string` | 否 | 本地凭据与配置持久化目录，缺省自动使用操作系统标准应用数据目录 |
| `proxy` | `Partial<AcpProxySettings>` | 否 | 代理配置 `{ enabled?: boolean; host?: string; port?: number }` |
| `env` | `NodeJS.ProcessEnv` | 否 | 注入给子进程的额外环境变量 |
| `resources` | `{ directory: string }` | 否 | 应用资源目录（单目录接口）：含 `AGENTS.md` 与 `skills/<name>/SKILL.md`。提供即走原生资源准备（读取/合并/注入/报告），缺席保持旧行为 |
| `callbacks` | `AcpClientCallbacks` | 否 | 事件与审批回调钩子（详见下文） |

### 实例属性

- `currentStatus`: `AcpConnectionStatus`
  - 当前状态值：`'disconnected' | 'connecting' | 'connected' | 'awaiting_auth' | 'error'`
- `isConnected`: `boolean`
  - 是否已成功建连且持有就绪的 RPC 客户端
- `agent`: `ClientContext | null`
  - 底层 `@agentclientprotocol/sdk` 的原生 RPC 上下文，可用于直接发送低级 RPC 请求

### 核心方法

#### `connect(): Promise<Result<{ status: AcpConnectionStatus; init: InitializeResponse }, AppError>>`
启动 Agent 后台进程、初始化 Stdio 通道并完成 Initialize 握手。

#### `createSession(options?): Promise<Result<AcpSessionHandle, AppError>>`
开启一个新会话或恢复已有会话。
- `options.resumeSessionId?: string | null`：尝试恢复的会话 ID
- `options.mcpServers?: unknown[]`：挂载的 MCP 服务器列表

#### `disconnect(reason?: string): Promise<void>`
断开当前连接，释放 Stdio 管道并安全杀死后台进程（清理进程树，避免孤儿进程）。

#### `resourceReport: AppResourceReport | null`
当前连接的应用资源加载报告（规则/技能分开记录，无 resources 入口时为 null）。

---

## 2. `AcpSessionHandle` 类

代表一个已建立的对话会话。

### 属性

- `resourceReport?: AppResourceReport | null`
  - 建会话时刻的资源加载报告快照（规则/技能分开记录）。

### 方法

#### `prompt(text: string, options?: { timeoutMs?: number }): Promise<Result<unknown, AppError>>`
向当前会话发送提示词或用户输入。

#### `setConfigOption(configId: string, value: string | boolean): Promise<Result<unknown, AppError>>`
动态修改会话配置项（如切换底层模型 `model`、模式 `mode` 等）。

---

## 3. 回调接口 `AcpClientCallbacks`

用于完全解耦宿主与界面的事件驱动接口：

```typescript
export interface AcpClientCallbacks {
  /** 权限审批回调：当 Agent 尝试调用工具或执行敏感操作时触发 */
  onPermissionRequest?: (payload: {
    sessionId?: string
    toolCall?: { id?: string; title?: string; kind?: string }
    params: Record<string, unknown>
  }) => Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>
  // 允许放行统一用 pickAllowOptionId(params) 挑 Agent 给定的允许项（协议层无 'approved'）

  /** 会话状态与内容流式更新 */
  onSessionUpdate?: (params: Record<string, unknown>) => void

  /** 连接状态机变化通知 */
  onStatusChange?: (status: AcpConnectionStatus, detail?: string) => void

  /** Agent 进程 stderr 输出（用于实时调试排错） */
  onStderrLine?: (line: string) => void

  /** 虚拟文件读取（供 Agent 读取内存快照） */
  readSnapshot?: (resource: InkdownVirtualResource) => Promise<string>

  /** 日志打印 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}
```

---

## 4. 运行时适配器工具

- `getAcpRuntimeAdapter(runtimeId: string): AcpRuntimeAdapter`
  获取指定运行时的适配器对象。
- `BUILTIN_ACP_RUNTIMES: readonly AcpRuntimeInfo[]`
  获取当前内置支持的所有 8 大 Agent 运行时配置元数据列表。

---

## 5. 应用资源目录（单目录接口）

宿主只传一个目录，SDK 负责读取、合并、注入与报告：

```typescript
const client = new AcpClient({
  runtime: 'codex-acp',
  workspaceRoot: '/path/to/work',
  resources: { directory: '/path/to/agent-config' },
})
```

目录约定：`AGENTS.md`（宿主常驻规则，主动读取）与 `skills/<name>/SKILL.md`
（按需技能，发现与正文分别记录）。工作目录保持不变；用户全局配置、
认证、HOME/CODEX_HOME/用户 cwd 一律不动；安装目录不加入可写根。

- 配置准备（codex）：使用最终 spawn 环境合并 CODEX_CONFIG；尚无有效磁盘配置查询入口，存在 config.toml/项目配置时不覆盖用户规则，返回 effective-config-not-verified。隔离供应商配置仅支持简单 TOML 合并；复杂内容保留原文件。
- 版本：Codex 2.2.2、OpenCode 1.18.35、Claude ACP 0.91.0 使用各自已核对的原生接口。OpenCode 同时探测实际启动命令的 --version，未命中不注入原生配置；Claude 的版本依据官方源码契约和 mock 链路，尚未完成真实桥/模型抽检。未知版本继续兼容。
- 自动兼容引导：无安全原生入口（未支持运行时、合并失败、未知版本、恢复未确认）时，SDK 在必要会话首轮自动前置同源兼容块（稳定 `<acp-compat-context>` 标记，如实记为 compatibility/user-context，不宣称 system/developer 优先级），之后不再重复；取消/失败不重置，已知已送达的同会话恢复不重复，新客户端恢复按新代次有界附带一次。原生已交付的会话不双发。
- 连接隔离：AcpClient 实例拥有独立进程作用域，不跨客户端共享 stdio。已连接时 connect 幂等；活动 prompt 期间拒绝重连，不取消回答。低层进程工具保留显式 scope/context/tag 查询，null 标签也严格匹配。
- 报告：client.resourceReport 表示当前连接的准备/握手事实；rulesPrepared 是环境已准备，连接级 rulesApplied 恒为 false（应用与否按会话判定）。session.resourceReport 只对已准备、版本已核对且成功新建的会话标 rulesApplied；恢复会话暂不确认；新增 skillsExposed（mcp-exposed/none）表示 Agent 是否接受携带技能 MCP 描述符的会话请求；不证明工具进程或模型读取成功，裸调降级后为 none。disconnect 清除客户端报告。这里的 applied 指配置传递，不代表模型遵从。
- 技能：skillsFound 是 SDK 扫描并读到正文的技能名（含 frontmatter 名称/描述解析）；skillsApplied 仍为 false（原生运行时扫描未实现，不冒充）。技能正文经 SDK 通用只读 MCP 服务（`app_list_skills`/`app_read_skill`，随包 `dist/app-skills-mcp-serve.cjs`，无写入无执行，越界拒绝）供给；建会话时自动并入 MCP 列表（调用方同名服务优先保留），`skillsExposed: mcp-exposed` 仅表示会话请求携带该描述符并被接受。实际被模型读取的证据见 Runner stderr 日志与测试断言，报告不混报。
- resources.directory 必须是本机绝对路径；目录是资源输入，不改变 cwd/HOME/CODEX_HOME，不加入可写根。`attachSkillsMcp: false` 可关闭技能 MCP 自动挂载。

示例见 `examples/app-resources-demo.ts`（纯 Node，无 Electron；默认仅扫描，`--mock-agent` 走完整 connect/createSession/prompt 离线验收，`--real` 走真实 Agent 需本机登录）。构建产物验收见 `scripts/smoke-dist-resources.mjs`（dist ESM/CJS/MCP 三入口）。

### 支持矩阵（实测为准）

| 场景 | 状态 | 证据 |
| :--- | :--- | :--- |
| codex 新会话 + 版本 2.2.2 + 无用户磁盘配置 | native（CODEX_CONFIG 注入） | mock peer 见进程 env 含规则；真实桥 initialize 2.2.2 |
| codex 有磁盘用户配置 / 未知版本 / 其他运行时 / 恢复会话 | compatibility 自动引导（首轮一次） | mock peer prompt 标记断言；真实会话报告 reason |
| 技能目录/正文 | SDK 扫描 + MCP 供给（`app-skills`） | 真实 stdio 子进程 list→read；修改跟随版本 |
| 真实模型收到 SDK 下发规则 | 1 次抽检通过（见计划记录） | 真实 codex + 真实模型回复含仅存在于规则块的哨兵词 |
| OpenCode 1.18.35 | native overlay + 原生 skill + MCP 工具通过 | 实际命令 --version 门；真实 ACP + 本地 mock 模型，规则在 system、零兼容块；两轮 MCP list/read，第三轮原生 skill 读取随机正文 |
| OpenCode 2.0.6 | initialize/new 通过；完整工具链未通过验收 | 隔离测试配置的本地模型未进入 ACP 可选列表，发送前停止；不外推 1.x 结果 |
| WSL/SSH、压缩后保留、多窗口隔离 | 未验 | compatibility 兜底 |

OpenCode 可复跑验收：`bun scripts/smoke-opencode-resources.mjs <absolute-opencode-executable>`。先构建 SDK；已验证 1.18.35。脚本创建独立临时配置与 HTTP 模型端点，只有明确选择本地模型后才发送，不使用真实 API Key；模型回放、ACP/SDK/MCP/文件读取真实。2.x 不满足本地模型前置条件时以非零退出，不算通过。

### 原生配置与 ACP 的边界（2026-10-15）

ACP 的 cwd/MCP/能力协商不等于统一 Agent 配置 HOME，也没有通用 systemPrompt 参数。宿主依旧只传 resources.directory；SDK 负责运行时差异。APP_RESOURCE_CAPABILITIES 可查询全部内置运行时的策略及已知配置目录入口；configHome 仅为信息，不表示 SDK 会重定向它，更不保证规则/技能随其自动迁移。

- Codex：保留已有 CODEX_CONFIG 合并与未知有效磁盘配置回退策略。
- OpenCode 1.18.35：OPENCODE_CONFIG_CONTENT 合并 instructions（AGENTS.md 绝对路径）与 skills.paths，保留已有 instructions、skills 字段、模型、MCP 等配置；不改 OPENCODE_CONFIG_DIR 或登录存储。无效配置明确兼容，不覆盖。
- Claude ACP 0.91.0：用官方桥 _meta.systemPrompt 的 claude_code preset + append 传递规则；_meta.claudeCode.options.plugins 引用资源目录的 skills/ 标准插件布局。规则属于原生追加通道，不替换内置提示。new/resume/load 对称携带；拒绝扩展时先去掉扩展重试，保留调用方 MCP；SDK 回到首轮规则兼容。此 _meta 是 Claude 桥扩展，不是 ACP 通用字段。未通过真实 Claude 模型验收，不能把 mock 结果当真实发现。
- Gemini：声明配置 HOME 会迁移状态/认证的风险，未实测安全叠加入口前兼容；不擅自用 GEMINI_SYSTEM_MD 替换整个默认 system prompt。
- Cursor：CURSOR_CONFIG_DIR 能改 CLI 配置位置，但尚不能证明能让独立目录的规则/技能自动发现，兼容原因单独报告。
- Copilot：官方额外规则目录入口 COPILOT_CUSTOM_INSTRUCTIONS_DIRS 已识别，尚未完成适配/真实验证，仍兼容；不改 COPILOT_HOME。
- agy、DeepSeek、OpenCode v2：缺少已验证的安全原生入口，继续兼容 + 技能 MCP；不臆造环境变量。agy 本机 CLI --help 有 --add-dir，但没有配置根或临时插件目录参数。

所有 prepareAppResources 均已接到内置适配器；兼容模式也返回规则字节、技能目录、摘要及具体原因。任何原生模式的 rulesApplied 只证明配置传递事实，不证明模型遵从；skillsApplied 暂保持 false，不充当运行时技能读取计数器。源文件为空/未知版本/扩展拒绝可回到统一规则及 MCP 通道。认证 HOME、用户全局文件和工作目录不变。

官方接口依据：
- https://dev.opencode.ai/docs/config#custom-directory
- https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/acp-agent.ts
- https://code.claude.com/docs/en/plugins-reference
- https://geminicli.com/docs/reference/configuration/
- https://cursor.com/docs/cli/reference/configuration
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions

### 会话专属原生配置根（2026-10-16）

显式启用，旧调用缺省 overlay 保持兼容：

```typescript
const client = new AcpClient({
  runtime: 'claude',
  workspaceRoot,
  resources: { directory: applicationResources, configurationScope: 'session' },
})
```

安装目录或应用资源目录提供 AGENTS.md 与纯文档 skills。SDK 为每个 AcpClient 连接生成随机、独占的临时配置根；不把安装目录变成 cwd，也不更改进程父环境、用户环境变量/注册表/全局配置文件。多个 ACP session 若由同一个 AcpClient 连接承载，会共享这个连接的配置快照；不同客户端/重连使用不同目录。configurationScope 拼错会报错，不静默使用全局配置。

| Runtime | 仅传给子进程的配置根 | 规则文件/边界 |
|---|---|---|
| Codex | CODEX_HOME | AGENTS.md；原生目录契约，隔离模式真实模型未验 |
| Claude | CLAUDE_CONFIG_DIR | CLAUDE.md + skills；隔离模式不再另传 systemPrompt/plugin 扩展；SDK+mock 进程隔离及清理已验，真实 Claude 模型未验 |
| Gemini | GEMINI_CLI_HOME | 在该根内生成 .gemini/GEMINI.md 与 .gemini/skills |
| Copilot | COPILOT_HOME + 专属 instructions/skills 路径 | copilot-instructions.md、AGENTS.md；不使用平台路径分隔符拼其逗号分隔变量 |
| OpenCode 1.x | 专属 XDG_CONFIG/DATA/CACHE/STATE_HOME + OPENCODE_CONFIG_DIR | opencode/AGENTS.md、skills、opencode.json；真实 1.18.35 ACP + mock 模型通过 |
| OpenCode v2 | 专属 XDG_CONFIG/DATA/CACHE/STATE_HOME | v2 格式 opencode.json（skills 数组）；目录布局已验，真实完整模型链仍未验 |
| Cursor | CURSOR_CONFIG_DIR | 只确认 CLI 配置根；规则独立根发现未确认，仍需兼容规则+技能 MCP，不能称完全原生规则 |
| agy / DeepSeek / 未知 | 不臆造变量 | 显式 session 模式拒绝启动；缺省 overlay 原有兼容路径保留 |

配置根中只写 SDK 生成的规则、配置和纯 Markdown 技能副本；拒绝技能符号链接/越界，不复制用户 auth.json、OAuth token、用户全局设置或非 Markdown 文件。配置根替换可能使文件式登录态不可见；已有环境凭据正常透传，其他认证需要运行时在自己的隔离环境中完成。重连生成新根，因此不承诺沿用上次临时根里的历史或认证；用户原有登录环境在原位置保留，不能把原路径的登录探针当作隔离子进程已登录证据。

已按原生规则文件布局配置的隔离模式不再附带用户规则前缀，但 configurationScope/configurationDirectory/configurationRulesFile 只报告文件与绑定，rulesApplied 不因目录存在而置 true；真实运行时读入需独立验收。Cursor 保留明确兼容。管理员策略、项目规则、系统钥匙串依然由各 CLI 自己决定；配置目录重定向不是文件系统安全沙箱。

正常 disconnect、握手失败均停止子进程再有界重试清理。无法删除时报告保留路径，不静默冒称已清理；应用被强杀/断电可能留下临时文件，但未修改父环境或全局注册，外部 CLI 不会自动指向该随机目录。SDK 不替宿主自动调用 disconnect，应用退出需完成现有 disconnect 生命周期。

复跑：`bun scripts/smoke-opencode-resources.mjs <opencode-1.x-path> --session-config`。真实 ACP/本地 mock 模型验证 system 规则、零兼容前缀、MCP 与原生 skill，并检查断开后临时配置根已删除。默认不带参数继续验证原有 overlay 路径。

Antigravity bridge 0.1.24 / 0.1.25 / 0.1.26 supports `resources.directory` through `_meta.appResources.directory` and private temporary additional workspaces. Rules and Skills are session-scoped, without changing cwd or global authentication. Unknown bridge versions retain compatibility delivery. Orderly close/delete/shutdown remove bridge-owned resources; forced termination cannot guarantee cleanup.

### DeepSeek（dsh）对接要点（2026-10-18 实测 0.2.1-rc.2）

ACP 侧是 `dsh --profile acp`：`initialize` 返回 `authMethods: []`（天然 `skip_auth`），`session/new` 返回的 `model` 选项按 provider 分组，value 是 `["provider","model"]` 的 JSON 串。宿主拿到的 `configOptions[].options[].value` 必须原样回写 `set_config_option`，SDK 只拍平分组并保留 `group`，不改写 value。

模型口径：官方 catalog 里 **`deepseek-flash` 就是 DeepSeek-V4.1-Flash**（桌面的 `1017` 是 `dsh-client-ui-deepseek-model-label-1017` 这个 UI 徽标包，不是模型版本）。V4-Pro 是 `deepseek-v4-pro`。

#### 可迁移性：不写用户 profile

`dsh-acp-app` 自带补丁把默认模型写死成 `deepseek-v4-flash`（该 id 不在 catalog 里），所以自动化会话默认拿不到 V4.1。SDK **不修改** `$DSH_HOME/profiles/acp/cordis.patch.yml`，而是在 spawn 时追加启动器自带的覆盖层：

```bash
dsh --profile acp --patch <系统临时目录>/acp-dsh-runtime/acp-model-deepseek-official--deepseek-flash.patch.yml
```

补丁文件由 `src/runtimes/deepseek/dsh-acp-bootstrap.ts` 生成并在内容变化时重写，随代码走、换机不丢。可用环境变量调整：

| 变量 | 作用 | 缺省 |
|---|---|---|
| `DSH_MODEL` | 覆盖模型 id | `deepseek-flash`（V4.1-Flash） |
| `DSH_PROVIDER` | 覆盖 provider | `deepseek-official`（account 路线填 `deepseek-account`） |
| `DSH_ACP_MODEL_PATCH` | `off`/`0`/`false`/`none` 关闭覆盖层 | 开启 |
| `DSH_RUNTIME_DIR` | 用户级运行时根目录 | Win `%LOCALAPPDATA%\acp-dsh`；mac `~/Library/Application Support/acp-dsh`；Linux `$XDG_DATA_HOME/acp-dsh` |
| `DSH_RUNTIME_VERSION` | 固定使用某个已装版本 | 未设时**自动取已装最高版本** |
| `DSH_BIN` | 显式 dsh 入口（最高优先级） | 无 |
| `DSH_PACKAGE` | npm 定位符覆盖 | `@deepseek-ai/dsh@latest` |

启动目标优先级：`DSH_BIN` → 用户级稳定安装（自动取已装最高版本）→ `DSH_PACKAGE` → `bunx -y @deepseek-ai/dsh@latest`。

**升级语义**：用户用 `node scripts/setup-dsh-acp.mjs --version 0.3.0`（或 `--version latest|next`）装了新版本后，acp-client 下次连接就自动选中它，不需要改代码或改配置——版本目录扫描 + 取最高，见 `resolveManagedDshVersion`。

#### 没有本地 harness 也能用：URL + Token 表单

宿主可以完全不要求用户预装/登录 harness，直接弹一个「端点 + Token」表单：

```typescript
import {
  DEEPSEEK_OFFICIAL_BASE_URL, // 'https://api.deepseek.com/anthropic'
  getDeepseekProviderStatus,
  saveDeepseekProvider,
  clearDeepseekProvider,
} from '@yitom/acp-client'

// 1) 初始化表单：baseUrl 缺省就是官方端点；状态里不含 Key 明文
const status = getDeepseekProviderStatus() // { configured, baseUrl?, isOfficial, hasApiKey }

// 2) 保存：baseUrl 留空 = 官方；填 'https://api.deepseek.com' 会自动补 /anthropic；
//    apiKey 留空 = 保留原 Token（只切端点不重填）
const saved = saveDeepseekProvider({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-...' })

// 3) 之后照常 new AcpClient({ runtime: 'deepseek' }).connect() 即可
clearDeepseekProvider() // 退出登录/切换租户
```

落库位置：`<dataDir>/agent/deepseek-provider.json`（只存 baseUrl + apiKey，不写 harness 的 `.credentials.yaml`）。连接时 SDK 通过适配器的 `getProviderEnv` 自动转成 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` —— 也就是 harness 官方认的变量（实测：空 `DSH_HOME` + 仅环境变量 Key，`session/new` 就能列出 V4.1-Flash 与 V4-Pro）。

凭证优先级（高 → 低）：

1. `AcpClient({ env })` 显式传入；
2. 表单落库；
3. 进程环境同名变量；
4. harness 自身登录（`$DSH_HOME/.credentials.yaml`）。

四种都不是时才会在 spawn 前判停。也就是说：**本地已登录 → 开箱即用；没登录 → 填表单；表单也不填 → 给出明确动作指引**。

#### 新机器接入（三步）

```bash
# 1. 装/复用用户级运行时（幂等；自动取平台的稳定目录）+ 自检握手
node scripts/setup-dsh-acp.mjs
#    只报告不改动：node scripts/setup-dsh-acp.mjs --check
#    指定目录/版本/镜像：--runtime-dir <p> --version <v> --registry <url>

# 2. 认证：二选一
#    a) 在 dsh/桌面版里登录（写 $DSH_HOME/.credentials.yaml）
#    b) export DEEPSEEK_API_KEY=sk-...

# 3. 宿主直接 connect；SDK 自动解析到稳定安装并附加模型覆盖层
```

`setup-dsh-acp.mjs` 的 `--verify` 会用与 SDK 完全相同的命令行跑一次 `initialize` + `session/new`，打印当前模型与可选项，看不到 `DeepSeek-V4.1-Flash` 即非零退出。

启动稳定性：bunx 把包装在临时目录，harness 的 `$DSH_HOME/profiles/node_modules` 会软链过去，临时目录被清理后 profile 直接断链；稳定安装命中后不会再有这个问题，且 `bunx` 仍保留为最后回落。凭证既可来自 `DEEPSEEK_API_KEY`，也可来自 harness 自身登录（`.credentials.yaml` 的 `records`）；两者都没有时 SDK 在 spawn 前判停，避免 harness 秒退只剩裸 `connection closed`。

#### 余额与上下文用量

ACP 协议本身**没有**余额接口；它只有 `usage_update` 事件（`used` / `size`，表示本次会话的上下文 token 占用），dsh 会发。SDK 把这个事件并入 `getQuota()` 结果的 `extraWindows`（label=`Context`），与账户余额分账存放、读取时合并：

```typescript
const quota = await client.getQuota()
quota?.credits     // { balance: 110, currency: 'CNY' }  ← GET /user/balance
quota?.status      // 'ok' | 'exhausted' | 'unauthorized'
quota?.extraWindows // [{ label: 'Context', used, total, percentLeft }]  ← usage_update
```

余额走 DeepSeek 官方 `GET /user/balance`（Bearer API Key），Key 来源优先级：显式 `env` → 表单落库 → harness 凭证库 `refs.DEEPSEEK_API_KEY`。无 Key、401/403 一律返回 `status: 'unauthorized'`（不静默）；网络失败返回 `null`，调用方沿用 30 秒缓存，不谎报额度。注意余额接口挂在 API 根上，SDK 会把 base URL 的 `/anthropic` 去掉再请求。

### Agent 版本策略

ACP agent 是**外部程序**，不是 acp-client 的依赖，所以不写进本包 `package.json`：写进去会把「SDK 发版」和「agent 发版」绑死，还会强制所有宿主用同一版本。当前按三类解析（2026-10-18 实测）：

| 类型 | 运行时 | 解析方式 | 当前版本 |
|---|---|---|---|
| npm 包 + `@latest` | codex-acp / claude / agy / opencode v2 | 每次冷启动向 registry 取最新 | 2.2.2 / 0.93.0 / 0.1.30 / 2.0.32 |
| 本机 CLI（用户装什么用什么） | gemini / copilot / opencode v1 / cursor | 探测安装路径与登录态，不代装 | 用户本地版本 |
| 稳定安装 + 版本覆盖 | deepseek | 自动取已装最高版本；`DSH_PACKAGE` / `DSH_RUNTIME_VERSION` 可锁 | 0.2.1-rc.2（npm latest 仍是 0.2.0-rc.2） |

想锁版本时的做法：DeepSeek 用 `DSH_PACKAGE=@deepseek-ai/dsh@X` 或 `setup-dsh-acp.mjs --version X`；其它 npm 包运行时目前统一走 `@latest`，若将来需要锁定，按 `DSH_PACKAGE` 的同一模式给各自加覆盖变量即可，不建议下沉到 `package.json`。`opencode-v2` 已按 `npx -y @opencode/cli acp` 接入 2.x 最新版，无需额外动作；`opencode`（v1）则取决于用户本机安装的二进制。

### 跨运行时：哪些一样，哪些不一样

**宿主代码形态完全一样**——换 `runtime` 字符串即可，同一个宿主可以并存多个运行时（温进程按 runtime id + 作用域分键）：

```typescript
for (const runtime of ['deepseek', 'opencode-v2', 'codex-acp']) {
  const client = new AcpClient({ runtime, workspaceRoot, callbacks })
  await client.connect()
  const session = await client.createSession()
  await session.prompt('你好')
}
```

统一层包括：`connect` / `createSession`（resume → load → new）/ `prompt` / `setConfigOption` / `disconnect`、事件回调（session update、权限审批、snapshot、终端）、模型通道（`configOptions` + `set_config_option`）、进程与 stdio 托管、错误码模型。

差异在**配置面**（由各 agent 自身协议决定，SDK 不臆造）：

| 维度 | DeepSeek（dsh） | OpenCode 1.x | OpenCode 2.x |
|---|---|---|---|
| 启动 | 自动装（稳定目录 / bunx），无需预装 | **用户本机 `opencode` 二进制** | `npx -y @opencode/cli` 自动 |
| 凭证 | `DEEPSEEK_API_KEY` / URL+Token 表单 / harness 登录 | `opencode auth login` → `auth.json`（仅探测） | SQLite（文件探针会漏检） |
| 宿主表单 | ✅ 有 API（`saveDeepseekProvider`） | ❌ 不建议（v2 已迁 SQLite，写 auth.json 无效） | ❌ 同左 |
| 登录 gate | `authMethods: []`，天然 `skip_auth` | 有 authMethods，可能 `needs_auth` | 同 v1，但 `tryDirectSessionFirst` 直连兜底 |
| 应用资源 | 兼容模式（不臆造配置入口） | 原生 overlay（`OPENCODE_CONFIG_CONTENT` 合并 instructions/skills） | 同 v1 |
| 配额探针 | ❌ | ✅ | ❌ |
| 桥版本门 | ❌ | `1.18.35` 已核对 | ❌ |

给宿主的落地结论：DeepSeek 可以做到「表单填完即用」；OpenCode 必须尊重它自己的登录方式（v1 装 CLI + `auth login`，v2 直接 `auth login`），**不要用统一表单去伪造**，否则 v2 的 SQLite 凭据会失效。
