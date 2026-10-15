import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readdir, readFile, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { readAppRulesText } from './app-resources'

export interface SessionConfigHome {
  directory: string
  env: NodeJS.ProcessEnv
  rulesFile: string
  nativeRules: boolean
  dispose(): Promise<void>
}

/** Child-process configuration roots, NOT a replacement of process.env/HOME/cwd. */
export async function createSessionConfigHome(runtime: string, resources: string): Promise<SessionConfigHome> {
  if (!isAbsolute(resources)) throw new Error('Resources must be an absolute path')
  const id = runtime === 'cursor' ? 'cursor-cli' : runtime
  const supported = ['agy','codex-acp','claude','gemini','copilot','cursor-cli','opencode','opencode-v2']
  if (!supported.includes(id)) throw new Error('Session configuration home is not verified for runtime: ' + runtime)
  const text = readAppRulesText(resources)
  if (!text) throw new Error('Session configuration requires nonempty AGENTS.md')
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'acp-session-config-'))
  const checkRoot = () => {
    if (resolve(directory) === parent || !resolve(directory).startsWith(parent + sep) || !relative(parent,directory).startsWith('acp-session-config-')) throw new Error('Unsafe configuration cleanup target')
  }
  const dispose = async () => {
    checkRoot()
    let failure: unknown
    for (let i=0;i<30;i++) {
      try { await rm(directory,{recursive:true,force:true});return }
      catch(error) {failure=error;await new Promise(r=>setTimeout(r,100))}
    }
    throw failure
  }
  try {
    const config = join(directory,'config')
    await mkdir(config,{recursive:true,mode:0o700})
    let env: NodeJS.ProcessEnv
    let rulesFile: string
    let skillsRoot = join(config,'skills')
    let nativeRules = true
    if (id === 'agy') {
      rulesFile=join(config,'AGENTS.md');env={AGY_ACP_RESOURCES_DIR:config};nativeRules=false
    } else if (id === 'gemini') {
      const root=join(directory,'home','.gemini')
      await mkdir(root,{recursive:true,mode:0o700})
      rulesFile=join(root,'GEMINI.md');skillsRoot=join(root,'skills')
      env={GEMINI_CLI_HOME:join(directory,'home')}
    } else if(id==='claude') {
      rulesFile=join(config,'CLAUDE.md');env={CLAUDE_CONFIG_DIR:config}
    } else if(id==='codex-acp') {
      rulesFile=join(config,'AGENTS.md');env={CODEX_HOME:config}
    } else if(id==='copilot') {
      rulesFile=join(config,'copilot-instructions.md')
      env={COPILOT_HOME:config,COPILOT_CUSTOM_INSTRUCTIONS_DIRS:config,COPILOT_SKILLS_DIRS:skillsRoot}
      await writeFile(join(config,'AGENTS.md'),text,{mode:0o600})
    } else if(id==='cursor-cli') {
      rulesFile=join(config,'AGENTS.md');env={CURSOR_CONFIG_DIR:config};nativeRules=false
      // This root is verified for CLI config only, not arbitrary rule discovery.
    } else {
      const root=join(directory,'xdg-config','opencode')
      await mkdir(root,{recursive:true,mode:0o700})
      rulesFile=join(root,'AGENTS.md');skillsRoot=join(root,'skills')
      env={XDG_CONFIG_HOME:join(directory,'xdg-config'),XDG_DATA_HOME:join(directory,'xdg-data'),XDG_CACHE_HOME:join(directory,'xdg-cache'),XDG_STATE_HOME:join(directory,'xdg-state')}
      if(id==='opencode') env.OPENCODE_CONFIG_DIR=root
      const skills = id==='opencode' ? {paths:[skillsRoot]} : [skillsRoot]
      await writeFile(join(root,'opencode.json'),JSON.stringify({instructions:[rulesFile],skills}),{mode:0o600})
    }
    await writeFile(rulesFile,text,{mode:0o600})
    // Copy only regular Markdown resource documents, never credentials or symlinks.
    const input=join(resources,'skills')
    try {
      const info=await lstat(input)
      if(info.isSymbolicLink() || !info.isDirectory()) throw new Error('Skill root must be a regular directory')
      const physical=await realpath(input)
      const copy=async (from:string,to:string):Promise<void> => {
        await mkdir(to,{recursive:true,mode:0o700})
        for(const entry of await readdir(from,{withFileTypes:true})) {
          const src=join(from,entry.name)
          const info=await lstat(src)
          if(info.isSymbolicLink()) throw new Error('Skill symlink is not allowed')
          const actual=await realpath(src)
          const rel=relative(physical,actual)
          if(rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel)) throw new Error('Skill path escapes resources')
          if(info.isDirectory()) await copy(src,join(to,entry.name))
          else if(info.isFile() && entry.name.toLowerCase().endsWith('.md')) await writeFile(join(to,entry.name),await readFile(src),{mode:0o600})
        }
      }
      await copy(input,skillsRoot)
    } catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(input)) throw error }
    return {directory,env,rulesFile,nativeRules,dispose}
  } catch(error) {await dispose();throw error}
}
