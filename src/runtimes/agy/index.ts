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
  probeAuth: () => probeAgyAuth(),
  probeQuota: (options) => probeAgyQuota(options),
  orderAuthMethods: (methods: AcpAuthMethod[]) => methods,
  canSkipInteractiveAuth: () => false,
  tryDirectSessionFirst: true,
}
