import { prepareOpenCodeResources } from '../../resources/runtime-bindings'
import type { GenericRuntimeAdapter } from '../index'
import { probeOpencodeAuth } from '../opencode'

/**
 * OpenCode v2 专属运行时（独立产品线 `@opencode/cli`，与 1.x 共存）。
 *
 * 启动：`npx -y @opencode/cli acp`（npx 跑 postinstall 落本地二进制，
 * 首冷慢、后热；不要用 bunx——bun 会拦 postinstall 导致无二进制可跑）。
 * 凭证：v2 已迁 SQLite，auth.json 仅兼容残留；探针沿用 v1 同款 hint，
 * 未命中由 gate 直连试一次兜底（tryDirectSessionFirst）。
 */
export const opencodeV2Adapter: GenericRuntimeAdapter = {
  id: 'opencode-v2',
  prepareAppResources: prepareOpenCodeResources,
  probeAuth: () => probeOpencodeAuth(),
  orderAuthMethods: (methods) => methods,
  canSkipInteractiveAuth: () => false,
  // v2 文件探针同样会漏检（SQLite 凭据），未命中时由 gate 直连试一次兜底
  tryDirectSessionFirst: true,
}
