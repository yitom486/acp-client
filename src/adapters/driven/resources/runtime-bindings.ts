import type { AppResourcePrep } from '../../../domain/contracts'
import { digestAppResources, readAppResourcesDir } from './app-resources'

/**
 * Shared compatibility fallback helper for runtime plugins without verified
 * native overlay config injection.
 */
export function prepareCompatibilityResources(directory: string, reason: string): AppResourcePrep {
  const load = readAppResourcesDir(directory)
  return {
    report: {
      rulesApplied: false,
      rulesPrepared: false,
      skillsApplied: false,
      rulesChars: load.rules?.chars ?? 0,
      profileDigest: digestAppResources(load),
      skillsFound: load.skills.map((s) => s.name),
      reason,
    },
  }
}
