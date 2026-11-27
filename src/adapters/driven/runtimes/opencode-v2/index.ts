import { OPENCODE_CLI_NPM_PACKAGE } from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { probeOpencodeAuth } from '../_shared/opencode-auth'

export const opencodeV2RuntimePlugin: AcpRuntimePlugin = {
  id: 'opencode-v2',
  manifest: {
    id: 'opencode-v2',
    name: 'OpenCode v2',
    description:
      '通过 npx 启动独立产品线 @opencode/cli v2（acp）；与 1.x 共存，复用 v2 SQLite 登录态',
    authHint: 'v2 登录态在 SQLite（auth.json 仅兼容残留）；未登录先用 v2 二进制跑 opencode auth login',
    command: 'npx',
    args: ['-y', OPENCODE_CLI_NPM_PACKAGE, 'acp'],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => probeOpencodeAuth(),
    orderAuthMethods: (methods) => methods,
    canSkipInteractiveAuth: () => false,
    tryDirectSessionFirst: true,
  },
  resources: {
    capability: { entry: null, strategy: 'compatibility', configHome: null },
    prepareOverlay: async ({ directory }) =>
      prepareCompatibilityResources(directory, 'native-config-entry-not-verified'),
    sessionConfigLayout: {
      kind: 'opencode-xdg',
      includeConfigDirEnv: false,
      skillsShape: 'array',
      nativeRules: true,
    },
  },
}
