# electron/services/acp/runtimes

按 Agent 运行时划分的配置、发现、凭据桥接与认证守门员模块。

| 运行时 | 目录 | 核心职能 |
|--------|------|----------|
| `codex-acp` | `codex/` | 本机 `~/.codex/auth.json` 登录探测、自定义供应商 (API Key) 与隔离 `CODEX_HOME` 生成 |
| `claude` | `claude/` | 本机 Claude Code 登录（`~/.claude.json`）/`ANTHROPIC_API_KEY` 探测 |
| `gemini` | `gemini/` | Gemini CLI 登录（`~/.gemini/oauth_creds.json`）/`GEMINI_API_KEY` 探测 |
| `copilot` | `copilot/` | Copilot CLI 登录（`~/.copilot/config.json` 的 `loggedInUsers`，`COPILOT_HOME` 可改目录）/ `GH_TOKEN` 系探测 |
| `opencode` | `opencode/` | `opencode auth login` 的 auth.json（legacy；`$XDG_DATA_HOME/opencode/` 优先，win `%LOCALAPPDATA%\\opencode\\` ＞ `%USERPROFILE%\\.local\\share\\opencode\\`；空白/非法/空对象判未登录）探测 |
| `cursor-cli` | `cursor/` | 安装路径探测（`resolveCursorCommand`：win `%LOCALAPPDATA%\\cursor-agent\\agent.cmd` / posix `~/.local/bin/agent` / 回落 PATH）+ 预 spawn 接线（`resolveSpawnCommand`：两处皆无回 `null`，由 `acp-connection.ts` 转带安装指引的 `ACP_SPAWN_ERROR`）；登录态文件位置官方未承诺，保守仅认 `CURSOR_API_KEY` |
| `deepseek` | `deepseek/` | `DEEPSEEK_API_KEY` 探测（harness 自身 `authMethods` 为空，天然跳过认证）+ 预检判停（`resolveSpawnBlocker`：缺 key 时 spawn 前回带中文动作指引，不触达 spawn，防 harness 秒退只剩裸 `connection closed`）+ 包定位符覆盖（`resolveSpawnCommand`：`DSH_PACKAGE` 非空/无空格/无 shell 元字符才透传为 `bunx -y <pkg> --profile acp`，非法回落缺省；上游最新 dsh 坏依赖时可 pin 旧版）；模型经 session 到达（顶层 `models` 方言由 `session-open` 合成 model 选项），无需额外动作 |
| `antigravity-cli` | `agy/` | `agy acp` 启动 Google 官方 CLI 自带的 ACP。内置 `resolveAntigravityCliCommand`（探测 `PATH` 与 `~/.local/bin/agy` / Windows 标准目录）、`probeQuota`（复用 `probeAgyQuota({ runtimeId: 'antigravity-cli' })`）与 `tryDirectSessionFirst=true`；先用 CLI 保存的登录态建会话，按 Agent 声明的认证方式处理登录。 |
| `agy` | `agy/` | `bunx -y @yitom/agy-acp-map` 启动旧桥接，继续支持桥接会话 ID、历史回放和应用资源扩展。 |

新适配器一律实现 `GenericRuntimeAdapter`：`probeAuth` 按各家凭证位置、
`orderAuthMethods` 默认透传、`canSkipInteractiveAuth` 保守 `false`；需预检 CLI
安装时可选实现 `resolveSpawnCommand`（`null` = 未安装，由连接层转错）；
需预检判停（缺 key 等）时可选实现 `resolveSpawnBlocker`（非空字符串 = 阻断文案，
由连接层转 `ACP_SPAWN_ERROR`，不触达 spawn）；
`tryDirectSessionFirst=true` 的 runtime 在 gate 判定 needs_auth 前先试一次直接建会话；
代理 `getSpawnEnv` 未声明时由 `acp-client.ts` 回落通用 `buildAcpProxySpawnEnv`，
故各适配器按需省略。`codex/` 另有 `getCustomProvider`（隔离 `CODEX_HOME`），他家不跟进。

`index.ts` 提供 `getAcpRuntimeAdapter` 统一工厂方法，未知 ID 使用中性探测。
