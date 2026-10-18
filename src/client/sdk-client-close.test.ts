import {test,expect} from 'vitest'
import {closeAcpSessions} from './sdk-client'
test('closes each owned session once and waits for acknowledgements',async()=>{
 const closed:string[]=[]
 const agent={request:async(method:string,p:{sessionId:string})=>{expect(method).toBe('session/close');await Promise.resolve();closed.push(p.sessionId);return {}}}
 expect(await closeAcpSessions(agent as any,['a','b','a'])).toEqual([])
 expect(closed.sort()).toEqual(['a','b'])
})
test('close failure stays bounded so process teardown can continue',async()=>{
 const agent={request:async()=>{throw Error('connection closed')}}
 expect(await closeAcpSessions(agent as any,['a'])).toEqual(['a'])
})
