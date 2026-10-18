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
| `deepseek` | `deepseek/` | `DEEPSEEK_API_KEY` / `$DSH_HOME/.credentials.yaml` / **宿主 URL+Token 表单**（`deepseek-provider.ts`，落 `<dataDir>/agent/deepseek-provider.json`，连接时经 `getProviderEnv` 注入 `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`）三选一即视为已配置；预检判停（`resolveSpawnBlocker` 带 env+dataDir 上下文）只在前三者都缺时生效 + 启动目标解析（`DSH_BIN` → 用户级稳定安装（自动取已装最高版本，见 `dsh-acp-bootstrap.ts`）→ `DSH_PACKAGE` → `bunx -y <pkg>@latest --profile acp`）+ 可迁移模型覆盖（`ensureAcpModelPatchFile` 写系统临时补丁并以 `--patch` 附加，`DSH_MODEL`/`DSH_PROVIDER` 可调、`DSH_ACP_MODEL_PATCH=off` 关闭；**不修改用户 profile**）；模型经 session 到达，dsh 的 model 选项是**按 provider 分组**、value 为 `["provider","model"]` JSON 串，由 `parseAcpConfigOptions` 拍平保留 `group`；V4.1-Flash 的 id 是 `deepseek-flash`（桌面端 1017 徽标只是 UI 标签）；新机器初始化：`node scripts/setup-dsh-acp.mjs` |
| `agy` | `agy/` | `bunx -y @yitom/agy-acp-map` 直调官方桥 JS 入口（`agy-acp → dist/bin.js`，无参 stdio；免安装，跨平台，版本跟随 bunx 解析，新鲜度由 bun 缓存语义接管，不再逐次 `npm view` 保证最新）；`probe` 中性空结果 + `tryDirectSessionFirst=true`（`authMethods` 为 `[]`，直连即可）；模型经 session/new 的 configOptions 到达，中途换模型走 `set_config_option`（即现有 setModel 通道直通，无需逃生口）；历史回放刻意极简（本地 zustand 仍是显示真相源） |

新适配器一律实现 `GenericRuntimeAdapter`：`probeAuth` 按各家凭证位置、
`orderAuthMethods` 默认透传、`canSkipInteractiveAuth` 保守 `false`；需预检 CLI
安装时可选实现 `resolveSpawnCommand`（`null` = 未安装，由连接层转错）；
需预检判停（缺 key 等）时可选实现 `resolveSpawnBlocker`（非空字符串 = 阻断文案，
由连接层转 `ACP_SPAWN_ERROR`，不触达 spawn）；
`tryDirectSessionFirst=true` 的 runtime 在 gate 判定 needs_auth 前先试一次直接建会话；
代理 `getSpawnEnv` 未声明时由 `acp-client.ts` 回落通用 `buildAcpProxySpawnEnv`，
故各适配器按需省略。`codex/` 另有 `getCustomProvider`（隔离 `CODEX_HOME`），他家不跟进。

入口：`index.ts`（`getAcpRuntimeAdapter` 统一工厂方法，未知 id 回落空壳中性探测）。Antigravity 运行时已淘汰（目录与桥接代码已删，含硬编码凭证）。
