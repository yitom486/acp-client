import {
  AGY_ACP_NPM_PACKAGE,
  emptyAcpAuthPreflight,
  type AcpAuthMethod,
  type AcpAuthPreflight,
} from '../../../../domain/contracts'
import type { AcpRuntimePlugin } from '../../../../ports'
import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import { probeAgyQuota } from './quota'

export { probeAgyQuota } from './quota'

export function probeAgyAuth(): AcpAuthPreflight {
  return emptyAcpAuthPreflight()
}

export const agyRuntimePlugin: AcpRuntimePlugin = {
  id: 'agy',
  manifest: {
    id: 'agy',
    name: 'Antigravity (legacy bridge)',
    description: '通过 bunx 启动 @yitom/agy-acp-map，兼容旧会话 ID 和桥接扩展',
    authHint: '复用 Antigravity CLI 本地登录态；未登录先在本机终端完成 agy 登录后再连接',
    command: 'bunx',
    args: ['-y', `${AGY_ACP_NPM_PACKAGE}@latest`],
    requiredEnvKeys: [],
  },
  auth: {
    probeAuth: () => probeAgyAuth(),
    orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
    canSkipInteractiveAuth: () => false,
    tryDirectSessionFirst: true,
  },
  resources: {
    capability: { entry: '_meta.appResources.directory', strategy: 'native-session', configHome: null },
    supportedBridgeVersions: ['0.1.24', '0.1.25', '0.1.26'],
    prepareOverlay: async ({ directory }) => {
      const prep = prepareCompatibilityResources(directory, 'native-session-version-not-verified')
      return {
        ...prep,
        env: { AGY_ACP_RESOURCES_DIR: directory },
        report: { ...prep.report, rulesPrepared: prep.report.rulesChars > 0 },
      }
    },
    sessionMeta: (directory) => ({ appResources: { directory } }),
    sessionConfigLayout: {
      kind: 'simple-config',
      rulesFileName: 'AGENTS.md',
      nativeRules: false,
      buildEnv: ({ configDir }) => ({ AGY_ACP_RESOURCES_DIR: configDir }),
    },
  },
  quota: {
    probeQuota: (options) => probeAgyQuota(options),
  },
}
