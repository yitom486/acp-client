import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 跨平台默认 ACP 数据与配置存储目录（纯 Node 运行环境）：
 * - 优先环境变量 ACP_DATA_DIR
 * - Windows: %LOCALAPPDATA%\acp-client (或 %APPDATA%\acp-client)
 * - macOS: ~/Library/Application Support/acp-client
 * - Linux: $XDG_DATA_HOME/acp-client (或 ~/.local/share/acp-client)
 */
export function getDefaultAgentDataDir(): string {
  if (process.env.ACP_DATA_DIR) {
    return process.env.ACP_DATA_DIR
  }
  if (process.platform === 'win32') {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      join(homedir(), 'AppData', 'Local', 'acp-client')
    )
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'acp-client')
  }
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share', 'acp-client')
}
