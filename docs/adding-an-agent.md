# 新增 Agent 运行时插件指南 (Adding an Agent)

`@yitom/acp-client` 采用**六边形架构（Hexagonal Architecture / Ports & Adapters）**。每个 ACP 运行时都是一个自包含的 **`AcpRuntimePlugin`**（出站驱动插件），集中声明其启动模板、认证预检、命令行探测、应用资源布局与可选额度探针。

新增一个内置运行时只需要 **新建 1 个插件文件 + 在注册表加 1 行**；或者外部宿主无需修改 SDK 源码，直接把自定义插件传入 `new AcpClient({ runtime: myPlugin })` 或独立的 `createRuntimeRegistry()` 即可使用。

---

## 插件契约：`AcpRuntimePlugin`

所有运行时插件实现 [src/ports/runtime-plugin.ts](../src/ports/runtime-plugin.ts) 中定义的 `AcpRuntimePlugin`：

```typescript
export interface AcpRuntimePlugin {
  /** 唯一运行时标识，如 'ollama-acp' */
  readonly id: string
  /** 静态描述与默认启动命令模板 */
  readonly manifest: AcpRuntimeInfo
  /** 可选别名（例如 cursor -> cursor-cli） */
  readonly aliases?: readonly string[]

  /** [可选] 认证预检与门闩策略（缺省则按标准 ACP 流程处理） */
  readonly auth?: {
    probeAuth?: () => AcpAuthPreflight
    orderAuthMethods?: (methods: AcpAuthMethod[]) => AcpAuthMethod[]
    canSkipInteractiveAuth?: (methodId: string, force?: boolean) => boolean
    tryDirectSessionFirst?: boolean
  }

  /** [可选] 启动前命令解析、缺 Key 判停与环境定制 */
  readonly spawn?: {
    resolveCommand?: () => { command: string; args: string[] } | null
    resolveBlocker?: () => string | null | undefined
    getSpawnEnv?: (proxySettings?: Partial<AcpProxySettings>) => RuntimeEnvOverrides
    beforeSpawn?: () => Promise<void>
    onColdStart?: () => Promise<void>
  }

  /** [可选] 应用资源策略、桥版本白名单与会话级隔离配置布局 */
  readonly resources?: {
    capability: AppResourceCapability
    supportedBridgeVersions?: readonly string[]
    prepareOverlay?: (input: RuntimeResourcePrepInput) => Promise<AppResourcePrep>
    sessionMeta?: (directory: string) => Record<string, unknown> | undefined
    sessionConfigLayout?: SessionConfigLayoutSpec
  }

  /** [可选] 官方额度探针（无官方接口请省略或返回 null） */
  readonly quota?: {
    probeQuota: (options?: { sessionId?: string }) => Promise<AcpAgentQuota | null>
  }
}
```

---

## 方式一：外部宿主零修改直接接入自定义运行时（推荐）

无需 fork 或修改 `@yitom/acp-client`，直接构造一个 `AcpRuntimePlugin`：

```typescript
import {
  AcpClient,
  createBuiltinRuntimeRegistry,
  emptyAcpAuthPreflight,
  type AcpRuntimePlugin,
} from '@yitom/acp-client'

const ollamaPlugin: AcpRuntimePlugin = {
  id: 'ollama-acp',
  aliases: ['ollama'],
  manifest: {
    id: 'ollama-acp',
    name: 'Ollama',
    description: '本地 Ollama ACP 服务',
    command: 'ollama-acp',
    args: ['--stdio'],
    requiredEnvKeys: [],
    authHint: '本地模型，无需登录',
  },
  auth: {
    probeAuth: () => ({ ...emptyAcpAuthPreflight(), looksLoggedIn: true }),
  },
}

// 用法 A：直接传入单个客户端
const client = new AcpClient({
  runtime: ollamaPlugin,
  workspaceRoot: process.cwd(),
})

// 用法 B：创建独立注册表实例（不污染全局状态），供多个客户端共享
const registry = createBuiltinRuntimeRegistry([ollamaPlugin])
const client2 = new AcpClient({
  runtime: 'ollama', // 支持别名解析
  runtimeRegistry: registry,
  workspaceRoot: process.cwd(),
})
```

---

## 方式二：向 SDK 内置列表贡献新运行时（仅 2 步）

### 步骤 1：新建插件目录与文件

在 `src/adapters/driven/runtimes/<name>/index.ts` 新建自包含插件（禁止跨运行时互相 import；共用平台工具放 `runtimes/_shared/`）：

```typescript
// src/adapters/driven/runtimes/ollama/index.ts
import { emptyAcpAuthPreflight } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'

export const ollamaRuntimePlugin: AcpRuntimePlugin = {
  id: 'ollama-acp',
  manifest: {
    id: 'ollama-acp',
    name: 'Ollama',
    description: '启动本机 Ollama ACP 服务',
    authHint: '本地开源模型，无需登录',
    command: 'ollama-acp',
    args: ['--stdio'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => ({ ...emptyAcpAuthPreflight(), looksLoggedIn: true }),
  },
  resources: {
    capability: { entry: null, strategy: 'compatibility', configHome: null },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'runtime-not-supported'),
  },
}
```

### 步骤 2：注册到 `BUILTIN_RUNTIME_PLUGINS`

在 [src/adapters/driven/runtimes/registry.ts](../src/adapters/driven/runtimes/registry.ts) 的 `BUILTIN_RUNTIME_PLUGINS` 数组中加入 `ollamaRuntimePlugin`（并在 `runtimes/index.ts` 导出）。

`BUILTIN_ACP_RUNTIMES`、`APP_RESOURCE_CAPABILITIES`、`NATIVE_ELIGIBLE_BRIDGE_VERSIONS` 与会话级隔离配置都会**自动从插件声明派生**，不需要再同步修改其他文件。

### 步骤 3：运行测试与架构边界检查

```bash
bun run test
```

`src/architecture-boundaries.test.ts` 会自动校验六边形层级依赖与插件间零耦合。

---

## 声明 Code Mode（PTC）支持

如果运行时能切换“工具呈现方式”（模型改写成代码、以 `tools.<name>()` 调用工具），在 `initialize` 的 `agentCapabilities._meta` 里声明可用值：

```json
{ "_meta": { "toolsMode": { "values": ["native", "ptc"] } } }
```

并在 `session/new`、`session/resume` 读取 `params._meta.toolsMode`（`"native"` 为默认，`"ptc"` 表示 code mode）。`@yitom/acp-client` 的 `supportsCodeMode` / `mergeSessionMeta` 会按声明协商，不需要硬编码运行时 id。
