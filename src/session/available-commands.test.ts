import { describe, expect, it } from 'vitest'
import { AvailableCommandsCache, extractAvailableCommands, formatCommandPrompt } from './available-commands'
import { AcpClient } from '../client/acp-client'

const upd = (sessionId: string, availableCommands: unknown) => ({
  sessionId,
  update: { sessionUpdate: 'available_commands_update', availableCommands },
})

describe('available_commands_update', () => {
  it('keeps name, description and input.hint', () => {
    const hit = extractAvailableCommands(
      upd('s1', [
        { name: 'review', description: 'Review', input: { hint: 'branch' }, _meta: { x: 1 } },
        { name: 'init' },
        { description: 'no name' },
        null,
      ]),
    )
    expect(hit).toEqual({
      sessionId: 's1',
      commands: [
        { name: 'review', description: 'Review', input: { hint: 'branch' }, _meta: { x: 1 } },
        { name: 'init', description: '' },
      ],
    })
    expect(extractAvailableCommands({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } })).toBeNull()
    expect(extractAvailableCommands(upd('s1', undefined))?.commands).toEqual([])
  })

  it('caches per session and replaces on update', () => {
    const c = new AvailableCommandsCache()
    expect(c.observe({ sessionId: 's1', update: { sessionUpdate: 'plan' } })).toBe(false)
    c.observe(upd('s1', [{ name: 'a', description: '' }]))
    c.observe(upd('s2', [{ name: 'b', description: '' }]))
    c.observe(upd('s1', [{ name: 'c', description: '' }]))
    expect(c.get('s1')?.map((x) => x.name)).toEqual(['c'])
    expect(c.get('s2')?.map((x) => x.name)).toEqual(['b'])
    c.delete('s2')
    expect(c.get('s2')).toBeUndefined()
  })

  it('wait() resolves with commands arriving after the session opened, or undefined on timeout', async () => {
    const c = new AvailableCommandsCache()
    const p = c.wait('s1', 500)
    setTimeout(() => c.observe(upd('s1', [{ name: 'late', description: '' }])), 20)
    expect((await p)?.[0].name).toBe('late')
    expect(await c.wait('s1', 0)).toEqual([{ name: 'late', description: '' }])
    expect(await c.wait('nope', 30)).toBeUndefined()
  })

  it('formats commands as plain prompt text', () => {
    expect(formatCommandPrompt('review', ' main ')).toBe('/review main')
    expect(formatCommandPrompt('/init')).toBe('/init')
  })

  it('AcpClient exposes cached commands by sessionId', () => {
    const client = new AcpClient({ workspaceRoot: process.cwd() })
    const handler = (client as any).commandsCache as AvailableCommandsCache
    const params = upd('s9', [{ name: 'x', description: 'd', input: { hint: 'h' } }])
    handler.observe(params)
    expect(client.getAvailableCommands('s9')).toEqual([{ name: 'x', description: 'd', input: { hint: 'h' } }])
  })
})
