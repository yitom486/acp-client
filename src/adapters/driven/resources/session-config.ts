import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SessionConfigLayoutSpec } from '../../../domain/contracts'
import type { ProvisionedSessionConfigHome } from '../../../ports'
import { readAppRulesText } from './app-resources'

export type SessionConfigHome = ProvisionedSessionConfigHome

/**
 * Layout-driven child-process configuration root creator.
 *
 * Runtime plugins declare their own `SessionConfigLayoutSpec` rather than
 * adding hardcoded `if (runtimeId === ...)` branches here.
 */
export async function createSessionConfigHomeFromLayout(input: {
  resourcesDir: string
  layout: SessionConfigLayoutSpec
}): Promise<SessionConfigHome> {
  const { resourcesDir, layout } = input
  if (!isAbsolute(resourcesDir)) throw new Error('Resources must be an absolute path')
  const text = readAppRulesText(resourcesDir)
  if (!text) throw new Error('Session configuration requires nonempty AGENTS.md')

  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'acp-session-config-'))
  const checkRoot = () => {
    if (
      resolve(directory) === parent ||
      !resolve(directory).startsWith(parent + sep) ||
      !relative(parent, directory).startsWith('acp-session-config-')
    ) {
      throw new Error('Unsafe configuration cleanup target')
    }
  }
  const dispose = async () => {
    checkRoot()
    let failure: unknown
    for (let i = 0; i < 30; i += 1) {
      try {
        await rm(directory, { recursive: true, force: true })
        return
      } catch (error) {
        failure = error
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    throw failure
  }

  try {
    const config = join(directory, 'config')
    await mkdir(config, { recursive: true, mode: 0o700 })

    let env: Record<string, string | undefined>
    let rulesFile: string
    let skillsRoot = join(config, 'skills')
    const nativeRules = layout.nativeRules

    if (layout.kind === 'simple-config') {
      rulesFile = join(config, layout.rulesFileName)
      env = layout.buildEnv({ configDir: config, skillsDir: skillsRoot })
      for (const extra of layout.extraRulesFileNames ?? []) {
        await writeFile(join(config, extra), text, { mode: 0o600 })
      }
    } else if (layout.kind === 'nested-home') {
      const homeDir = join(directory, layout.homeSubdir)
      const nestedConfig = join(homeDir, layout.configSubdir)
      await mkdir(nestedConfig, { recursive: true, mode: 0o700 })
      rulesFile = join(nestedConfig, layout.rulesFileName)
      skillsRoot = join(nestedConfig, 'skills')
      env = layout.buildEnv({ homeDir, configDir: nestedConfig, skillsDir: skillsRoot })
    } else {
      const xdgConfig = join(directory, 'xdg-config')
      const root = join(xdgConfig, 'opencode')
      await mkdir(root, { recursive: true, mode: 0o700 })
      rulesFile = join(root, 'AGENTS.md')
      skillsRoot = join(root, 'skills')
      env = {
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: join(directory, 'xdg-data'),
        XDG_CACHE_HOME: join(directory, 'xdg-cache'),
        XDG_STATE_HOME: join(directory, 'xdg-state'),
      }
      if (layout.includeConfigDirEnv) env.OPENCODE_CONFIG_DIR = root
      const skills = layout.skillsShape === 'object' ? { paths: [skillsRoot] } : [skillsRoot]
      await writeFile(join(root, 'opencode.json'), JSON.stringify({ instructions: [rulesFile], skills }), {
        mode: 0o600,
      })
    }

    await writeFile(rulesFile, text, { mode: 0o600 })

    // Copy only regular Markdown resource documents, never credentials or symlinks.
    const inputSkills = join(resourcesDir, 'skills')
    try {
      const info = await lstat(inputSkills)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Skill root must be a regular directory')
      }
      const physical = await realpath(inputSkills)
      const copy = async (from: string, to: string): Promise<void> => {
        await mkdir(to, { recursive: true, mode: 0o700 })
        for (const entry of await readdir(from, { withFileTypes: true })) {
          const src = join(from, entry.name)
          const stat = await lstat(src)
          if (stat.isSymbolicLink()) throw new Error('Skill symlink is not allowed')
          const actual = await realpath(src)
          const rel = relative(physical, actual)
          if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
            throw new Error('Skill path escapes resources')
          }
          if (stat.isDirectory()) await copy(src, join(to, entry.name))
          else if (stat.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            await writeFile(join(to, entry.name), await readFile(src), { mode: 0o600 })
          }
        }
      }
      await copy(inputSkills, skillsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(inputSkills)) throw error
    }

    return { directory, env, rulesFile, nativeRules, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
