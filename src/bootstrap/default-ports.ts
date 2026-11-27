import { randomUUID } from 'node:crypto'
import type { AcpClientEnginePorts } from '../application'
import type { RuntimeRegistryPort } from '../ports'
import { ACP_FS_MAX_READ_BYTES, createNodeHostFs } from '../adapters/driven/host/acp-fs'
import { getDefaultAgentDataDir } from '../adapters/driven/host/acp-paths'
import { createFsProxySettingsStore } from '../adapters/driven/host/acp-proxy-service'
import {
  ACP_TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT,
  AcpTerminalManager,
} from '../adapters/driven/host/acp-terminal'
import { createNodeProcessLauncher } from '../adapters/driven/process/process-manager'
import { createNodeResourceProvisioner } from '../adapters/driven/resources/resource-provisioner'
import { DEFAULT_RUNTIME_REGISTRY } from '../adapters/driven/runtimes/registry'
import { createSdkTransportAdapter } from '../adapters/driven/transport/sdk-client'
import { ACP_CLIENT_VERSION } from '../version'

export interface DefaultPortsOptions {
  runtimeRegistry?: RuntimeRegistryPort
  terminalOutputByteLimit?: number
  overrides?: Partial<AcpClientEnginePorts>
}

export function getDefaultRuntimeRegistry(): RuntimeRegistryPort {
  return DEFAULT_RUNTIME_REGISTRY
}

/**
 * Composition root: wires default Node.js Driven Adapters into the pure
 * Hexagonal Application Engine.
 */
export function createDefaultAcpPorts(options?: DefaultPortsOptions): AcpClientEnginePorts {
  const fs = createNodeHostFs()
  const terminalByteLimit = options?.terminalOutputByteLimit ?? ACP_TERMINAL_DEFAULT_OUTPUT_BYTE_LIMIT

  const defaults: AcpClientEnginePorts = {
    runtimeRegistry: options?.runtimeRegistry ?? DEFAULT_RUNTIME_REGISTRY,
    transport: createSdkTransportAdapter({
      fs,
      createTerminals: (onActivity) =>
        new AcpTerminalManager({
          defaultOutputByteLimit: terminalByteLimit,
          onActivity,
        }),
    }),
    processLauncher: createNodeProcessLauncher(),
    proxyStore: createFsProxySettingsStore(),
    paths: { getDefaultDataDir: getDefaultAgentDataDir },
    resources: createNodeResourceProvisioner(),
    defaultClientVersion: ACP_CLIENT_VERSION,
    defaultMaxReadBytes: ACP_FS_MAX_READ_BYTES,
    generateScopeKey: () => `sdk-${randomUUID()}`,
  }

  return {
    ...defaults,
    ...(options?.overrides ?? {}),
  }
}
