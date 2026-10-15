import { prepareCompatibilityResources } from '../../resources/runtime-bindings'
import type { AcpAuthMethod, CodexAuthPreflight } from '../../contracts'
import type { GenericRuntimeAdapter } from '../index'
import { probeAgyQuota } from './quota'
 
export function probeAgyAuth(): CodexAuthPreflight {
  return {
    codexHome: '',
    hasCodexHome: false,
    hasAuthFile: false,
    hasApiKeyEnv: false,
    looksLoggedIn: false,
  }
}

export const agyAdapter: GenericRuntimeAdapter = {
  id: 'agy',
  prepareAppResources: async ({directory}) => {
    const prep = prepareCompatibilityResources(directory, 'native-session-version-not-verified')
    return {...prep, env:{AGY_ACP_RESOURCES_DIR:directory}, report:{...prep.report, rulesPrepared:prep.report.rulesChars > 0}}
  },
  appResourceSessionMeta: directory => ({appResources:{directory}}),
  supportedBridgeVersions: ['0.1.24', '0.1.25', '0.1.26'],
  probeAuth: () => probeAgyAuth(),
  probeQuota: (options) => probeAgyQuota(options),
  orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
  canSkipInteractiveAuth: () => false,
  tryDirectSessionFirst: true,
}
