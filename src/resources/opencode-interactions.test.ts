import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeOpenCodeQuestionConfig, mergeOpenCodeAppConfig, resolveOpenCodeQuestionMode, prepareOpenCodeResources } from './runtime-bindings'

describe('OpenCode ACP question compatibility', () => {
  it('uses exact verified versions, without assuming native support on new releases', () => {
    expect(resolveOpenCodeQuestionMode('1.18.35\n')).toBe('fallback')
    expect(resolveOpenCodeQuestionMode('opencode v2.0.6\n')).toBe('fallback')
    for (const v of ['', '1.18.34', '1.18.36', '2.0.7', '1.18.35-dev']) expect(resolveOpenCodeQuestionMode(v)).toBe('unverified')
  })
  it('preserves provider, MCP, model and granular permission settings without mutation', () => {
    const input = { model:'local/model', provider:{local:{options:{baseURL:'http://localhost'}}}, mcp:{host:{enabled:true}},
      permission:{bash:{'*':'ask','git status':'allow'},edit:'deny',question:'allow'} }
    const raw = JSON.stringify(input)
    const output = JSON.parse(mergeOpenCodeQuestionConfig(raw))
    expect(output).toEqual({...input,permission:{...input.permission,question:'deny'}})
    expect(JSON.stringify(input)).toBe(raw)
    expect(mergeOpenCodeQuestionConfig(JSON.stringify(output))).toBe(JSON.stringify(output))
  })
  it('keeps shorthand permission defaults, including deny, and blocks only native question', () => {
    for (const policy of ['allow','ask','deny']) expect(JSON.parse(mergeOpenCodeQuestionConfig(JSON.stringify({permission:policy})))).toEqual({permission:{'*':policy,question:'deny'}})
    expect(JSON.parse(mergeOpenCodeQuestionConfig(undefined))).toEqual({permission:{question:'deny'}})
  })
  it('rejects malformed overlays rather than replacing user settings', () => {
    for (const raw of ['[]','null','{bad','{"permission":null}','{"permission":42}','{"permission":[]}','{"permission":"bad"}']) expect(()=>mergeOpenCodeQuestionConfig(raw)).toThrow()
  })
  it('composes with resources in paths with spaces without writing workspace configuration', () => {
    const dir=mkdtempSync(join(tmpdir(),'acp questions spaces '))
    const rules=join(dir,'AGENTS.md');writeFileSync(rules,'HOST RULES')
    try {
      const raw=mergeOpenCodeQuestionConfig('{"instructions":["USER.md"],"skills":{"paths":["user-skills"]}}')
      const output=JSON.parse(mergeOpenCodeAppConfig(raw,dir))
      expect(output.instructions).toEqual(['USER.md',rules])
      expect(output.skills.paths).toEqual(['user-skills',join(dir,'skills')])
      expect(output.permission.question).toBe('deny')
      expect(readFileSync(rules,'utf8')).toBe('HOST RULES')
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('does not claim preparation when executable is missing or its version is unknown', async () => {
    const dir=mkdtempSync(join(tmpdir(),'acp-question-probe-'));writeFileSync(join(dir,'AGENTS.md'),'HOST RULES')
    try {
      for (const command of [undefined, process.execPath, join(dir,'missing-executable')]) {
        const prep=await prepareOpenCodeResources({directory:dir,command,env:{...process.env,OPENCODE_CONFIG_CONTENT:'{"model":"keep"}'}})
        expect(prep.env).toBeUndefined()
        expect(prep.report.openCodeQuestions?.mode).toBe('unverified')
        expect(prep.report.openCodeQuestions?.configuration).toBe('unchanged')
        expect(prep.report.rulesApplied).toBe(false)
      }
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
})

// Opt-in local binary check: --version only, never authenticates or invokes a model.
it.skipIf(!process.env.ACP_TEST_OPENCODE_BINARY)('prepares a v2 question overlay without claiming v1 rules or skills', async () => {
  const dir=mkdtempSync(join(tmpdir(),'acp-v2-question-'))
  writeFileSync(join(dir,'AGENTS.md'),'HOST RULES')
  try {
    const prep=await prepareOpenCodeResources({directory:dir,command:process.env.ACP_TEST_OPENCODE_BINARY,
      env:{...process.env,OPENCODE_CONFIG_CONTENT:'{"permission":{"bash":"ask"},"model":"keep"}'}})
    expect(prep.report.openCodeQuestions).toEqual({version:'2.0.6',mode:'fallback',configuration:'prepared',reason:'acp-question-not-forwarded'})
    expect(prep.report.rulesPrepared).toBe(false)
    expect(prep.report.rulesApplied).toBe(false)
    expect(JSON.parse(prep.env!.OPENCODE_CONFIG_CONTENT!)).toEqual({permission:{bash:'ask',question:'deny'},model:'keep'})
    expect(Object.keys(prep.env!)).toEqual(['OPENCODE_CONFIG_CONTENT'])
  } finally {rmSync(dir,{recursive:true,force:true})}
})
