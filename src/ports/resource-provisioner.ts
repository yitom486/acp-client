import type {
  AppResourceLoad,
  AppSkillsMcpServerDescriptor,
  SessionConfigLayoutSpec,
} from '../domain/contracts'

export interface ProvisionedSessionConfigHome {
  readonly directory: string
  readonly env: Record<string, string | undefined>
  readonly rulesFile: string
  readonly nativeRules: boolean
  dispose(): Promise<void>
}

export interface ResourceProvisionerPort {
  isAbsolutePath(path: string): boolean
  readResourcesDir(directory: string): AppResourceLoad
  readRulesText(directory: string): string | null
  digestResources(load: AppResourceLoad): string | null
  createSessionConfigHome(input: {
    runtimeId: string
    resourcesDir: string
    layout: SessionConfigLayoutSpec
  }): Promise<ProvisionedSessionConfigHome>
  buildSkillsMcpServer(directory: string): AppSkillsMcpServerDescriptor | null
}
