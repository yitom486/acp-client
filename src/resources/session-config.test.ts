import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionConfigHome } from './session-config'
import { AcpClient } from '../client/acp-client'

function resources() {
  const dir=mkdtempSync(join(tmpdir(),'isolation-test-'))
  writeFileSync(join(dir,'AGENTS.md'),'ONLY_APP_RULES')
  mkdirSync(join(dir,'skills','demo'),{recursive:true})
  writeFileSync(join(dir,'skills','demo','SKILL.md'),'---\nname: demo\ndescription: Demo.\n---\nBODY')
  writeFileSync(join(dir,'skills','demo','note.md'),'REFERENCE')
  writeFileSync(join(dir,'skills','demo','auth.json'),'DO_NOT_COPY')
  return dir
}

describe('child-only native config homes', () => {
  for (const runtime of ['agy','codex-acp','claude','gemini','copilot','cursor-cli','opencode','opencode-v2']) it(runtime+' has its own layout and leaves parent env/resources unchanged',async()=>{
    const dir=resources();let profile
    const before=JSON.stringify(process.env)
    try {
      profile=await createSessionConfigHome(runtime,dir)
      expect(readFileSync(profile.rulesFile,'utf8')).toBe('ONLY_APP_RULES')
      expect(readFileSync(join(dir,'AGENTS.md'),'utf8')).toBe('ONLY_APP_RULES')
      expect(JSON.stringify(process.env)).toBe(before)
      expect(profile.env.HOME).toBeUndefined();expect(profile.env.USERPROFILE).toBeUndefined()
      const nativeDir = runtime==='gemini'?join(profile.env.GEMINI_CLI_HOME!,'.gemini'):runtime.startsWith('opencode')?join(profile.env.XDG_CONFIG_HOME!,'opencode'):Object.values(profile.env)[0]!
      expect(readFileSync(join(nativeDir,'skills','demo','note.md'),'utf8')).toBe('REFERENCE')
      expect(existsSync(join(nativeDir,'skills','demo','auth.json'))).toBe(false)
      await profile.dispose();expect(existsSync(profile.directory)).toBe(false)
    } finally {await profile?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  })
  it('does not invent configuration environment variables for unsupported runtimes',async()=>{
    const dir=resources()
    try {for(const runtime of ['deepseek','unknown']) await expect(createSessionConfigHome(runtime,dir)).rejects.toThrow('not verified')}
    finally {await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  })
  it('separate SDK clients receive distinct homes and clean them on disconnect',async()=>{
    const dir=resources();const clients:AcpClient[]=[];const paths:string[]=[]
    const userConfig=join(dir,'user-claude');mkdirSync(userConfig);writeFileSync(join(userConfig,'CLAUDE.md'),'USER_UNTOUCHED')
    const previous=process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR=userConfig
    try {
      for(let i=0;i<2;i++) {
        const c=new AcpClient({runtime:{id:'claude',name:'mock',description:'no model',command:process.execPath,args:[join(import.meta.dirname,'fixtures/compat-agent.mjs')],requiredEnvKeys:[]},workspaceRoot:dir,dataDir:dir,resources:{directory:dir,configurationScope:'session'}})
        clients.push(c);expect((await c.connect()).ok).toBe(true)
        const opened=await c.createSession();expect(opened.ok).toBe(true);if(!opened.ok)throw Error('session')
        const root=opened.value.resourceReport?.configurationDirectory!;paths.push(root)
        expect(opened.value.resourceReport?.rulesApplied).toBe(false)
        const desc=await c.promptSession(opened.value.sessionId,'__describe__');expect(desc.ok).toBe(true)
        if(desc.ok) {const d=(desc.value as any).describe;expect(d.configEnv.CLAUDE_CONFIG_DIR).toBe(join(root,'config'));expect(d.prompts[0].hasCompatMarker).toBe(false);expect(d.news[0].mcpNames).toContain('app-skills')}
      }
      expect(paths[0]).not.toBe(paths[1]);await clients[0]!.disconnect()
      expect(existsSync(paths[0]!)).toBe(false);expect(existsSync(paths[1]!)).toBe(true)
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(userConfig);expect(readFileSync(join(userConfig,'CLAUDE.md'),'utf8')).toBe('USER_UNTOUCHED')
    } finally {await Promise.all(clients.map(c=>c.disconnect()));if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  }, 20000)
})


describe('isolated lifecycle failures',()=>{
  it('rejects a misspelled isolation scope instead of starting with global config',()=>{
    expect(()=>new AcpClient({workspaceRoot:tmpdir(),resources:{directory:tmpdir(),configurationScope:'sesion' as any}})).toThrow('configurationScope');
  });
  it('cleans configuration after handshake failure',async()=>{
    const dir=resources();let configDir='';
    const c=new AcpClient({runtime:{id:'claude',name:'mock',description:'no model',command:process.execPath,args:[join(import.meta.dirname,'fixtures/compat-agent.mjs')],requiredEnvKeys:[]},workspaceRoot:dir,dataDir:dir,env:{MOCK_FAIL_INITIALIZE:'1'},resources:{directory:dir,configurationScope:'session'},callbacks:{onStderrLine:line=>{if(line.startsWith('TEST_CONFIG_DIR:'))configDir=line.slice('TEST_CONFIG_DIR:'.length)}}});
    try {expect((await c.connect()).ok).toBe(false);expect(configDir).not.toBe('');expect(existsSync(configDir)).toBe(false)}
    finally{await c.disconnect();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  },20000);
  it('does not create two profiles for concurrent connect calls',async()=>{
    const dir=resources();const c=new AcpClient({runtime:{id:'claude',name:'mock',description:'no model',command:process.execPath,args:[join(import.meta.dirname,'fixtures/compat-agent.mjs')],requiredEnvKeys:[]},workspaceRoot:dir,dataDir:dir,resources:{directory:dir,configurationScope:'session'}});
    try {const results=await Promise.all([c.connect(),c.connect()]);expect(results.filter(r=>r.ok)).toHaveLength(1);expect(c.isConnected).toBe(true)}
    finally{await c.disconnect();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  },20000);
});
