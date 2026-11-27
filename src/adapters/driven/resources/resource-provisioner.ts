import type { ResourceProvisionerPort } from '../../../ports'
import { digestAppResources, isAbsolutePathLike, readAppResourcesDir, readAppRulesText } from './app-resources'
import { buildAppSkillsMcpServer } from './app-skills-mcp'
import { createSessionConfigHomeFromLayout } from './session-config'

export function createNodeResourceProvisioner(): ResourceProvisionerPort {
  return {
    isAbsolutePath: isAbsolutePathLike,
    readResourcesDir: readAppResourcesDir,
    readRulesText: readAppRulesText,
    digestResources: digestAppResources,
    createSessionConfigHome: ({ resourcesDir, layout }) =>
      createSessionConfigHomeFromLayout({ resourcesDir, layout }),
    buildSkillsMcpServer: (directory) => {
      try {
        return buildAppSkillsMcpServer(directory)
      } catch {
        return null
      }
    },
  }
}
