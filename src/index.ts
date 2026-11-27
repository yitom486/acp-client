/**
 * @yitom/acp-client — Headless Agent Client Protocol SDK (Hexagonal Architecture)
 *
 * Layered exports:
 * - domain: pure contracts, auth gates, session/capability parsers, quota cache, health monitor
 * - ports: runtime plugin & registry ports, transport/process/host/resource port interfaces
 * - application: pure AcpClientEngine, session open state machine, MCP recovery, permission coordinator
 * - adapters/driving: AcpClient & AcpSessionHandle SDK facade (and acp-engine sidecar binary)
 * - adapters/driven: Node process/FS/terminal/proxy, @agentclientprotocol/sdk transport, resources, 10 runtime plugins
 * - bootstrap: default Node.js composition root
 */

// ── Version ──
export { ACP_CLIENT_VERSION } from './version'

// ── Domain (pure, zero Node I/O) ──
export * from './domain/contracts'
export * from './domain/auth/auth-method-order'
export * from './domain/auth/connect-auth-decision'
export * from './domain/auth/connect-auth-gate'
export * from './domain/session/available-commands'
export * from './domain/session/code-mode'
export * from './domain/session/compat-guide'
export * from './domain/session/config-options'
export * from './domain/session/permission'
export * from './domain/session/quota'
export * from './domain/session/session-capabilities'
export * from './domain/transport/config-text'
export * from './domain/transport/connection-health'
export * from './domain/transport/terminal-output-buffer'

// ── Ports ──
export * from './ports'

// ── Application (pure orchestration) ──
export * from './application'

// ── Driving Adapters (SDK facade) ──
export * from './adapters/driving/sdk/acp-client'

// ── Composition Root ──
export * from './bootstrap/default-ports'

// ── Driven Adapters (Node / SDK / Resources / Runtime Plugins) ──
export * from './adapters/driven/transport/sdk-client'
export * from './adapters/driven/transport/client-handlers'
export * from './adapters/driven/process/process-manager'
export * from './adapters/driven/host/acp-fs'
export * from './adapters/driven/host/acp-paths'
export * from './adapters/driven/host/acp-proxy-service'
export * from './adapters/driven/host/acp-terminal'
export * from './adapters/driven/resources/app-resources'
export * from './adapters/driven/resources/app-skills-mcp'
export * from './adapters/driven/resources/resource-provisioner'
export * from './adapters/driven/resources/runtime-bindings'
export * from './adapters/driven/resources/session-config'
export * from './adapters/driven/runtimes'
