import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'

export const ACP_FS_MAX_READ_BYTES = 2 * 1024 * 1024

export function assertPathInsideWorkspace(filePath: string, workspaceRoot: string): string {
  const root = resolve(workspaceRoot)
  const target = resolve(filePath)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`路径不在工作区内: ${filePath}`)
  }
  return target
}

export async function acpReadTextFile(params: {
  path: string
  workspaceRoot: string
  line?: number
  limit?: number
  maxReadBytes?: number
  blockedExtensions?: ReadonlySet<string>
}): Promise<{ content: string }> {
  if (params.blockedExtensions?.has(extname(params.path).toLowerCase())) {
    throw new Error(`拒绝按文本读取受限扩展名文件：${params.path}`)
  }
  const abs = assertPathInsideWorkspace(params.path, params.workspaceRoot)
  await access(abs)
  let content = await readFile(abs, 'utf-8')
  const maxBytes =
    typeof params.maxReadBytes === 'number' && params.maxReadBytes > 0
      ? params.maxReadBytes
      : ACP_FS_MAX_READ_BYTES
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    content = content.slice(0, Math.floor(maxBytes / 2))
    content += '\n\n…[截断：文件过大]…'
  }

  if (typeof params.line === 'number' && params.line > 0) {
    const lines = content.split('\n')
    const start = params.line - 1
    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : lines.length
    content = lines.slice(start, start + limit).join('\n')
  }

  return { content }
}

export async function acpWriteTextFile(params: {
  path: string
  content: string
  workspaceRoot: string
}): Promise<Record<string, never>> {
  const abs = assertPathInsideWorkspace(params.path, params.workspaceRoot)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, params.content, 'utf-8')
  return {}
}
