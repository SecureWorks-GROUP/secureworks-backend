import { contextAccuracyVerdict, contextReviewWeek, contextAccuracySample, ContextPipelineError } from './context_pipeline.ts'
import { isCurrentContextFact } from './context_visibility.ts'
function eq(actual: unknown, expected: unknown) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
Deno.test('default review selects previous completed Perth week and validates dates', () => {
 eq(contextReviewWeek(null,new Date('2026-09-13T17:00:00Z')),'2026-09-07')
 for (const week of ['2026-09-08','2026-02-30','bad']) { let threw=false;try { contextReviewWeek(week) } catch { threw=true } eq(threw,true) }
})
Deno.test('service key cannot turn a body human name into an authenticated verdict', async () => {
 let writes=0
 try { await contextAccuracyVerdict({rpc:()=>{writes++;}}, {judged_by:'Named Operator'},null,'org') } catch (error) { eq((error as ContextPipelineError).code,'human_auth_required') }
 eq(writes,0)
})
Deno.test('verdict actor is authenticated identity and body name is never forwarded', async () => {
 let sent:any
 const client={rpc:(_name:string,args:any)=>{sent=args;return Promise.resolve({data:{complete:false},error:null})}}
 await contextAccuracyVerdict(client,{week_start:'2026-09-07',fact_id:'11111111-1111-1111-1111-111111111111',fact_store:'job_context',verdict:'false',invented_payment:true,judged_by:'Impersonated'}, {id:'real-user',orgId:'org'},'org')
 eq(sent.p_actor_id,'real-user');eq(sent.judged_by,undefined);eq(sent.p_invented_payment,true)
})
Deno.test('sample read does not draw and reports actual missing count', async () => {
 const client={from:(name:string)=> {const result={data:name==='context_accuracy_weeks'?null:[],error:null};const q:any={select:()=>q,eq:()=>q,order:()=>q,maybeSingle:()=>Promise.resolve(result),then:(resolve:any)=>resolve(result)};return q}}
 eq((await contextAccuracySample(client,'2026-09-07')).state,'not_drawn')
 eq((await contextAccuracySample(client,'2026-09-07')).missing,40)
})
Deno.test('reader defense respects top-level retirement and expiry on permanent proposals', () => {
 eq(isCurrentContextFact({kind:'note',_context_store:'job_context',lifecycle:'retracted'}),false)
 eq(isCurrentContextFact({kind:'proposal',_context_store:'job_context',expires_at:'2020-01-01T00:00:00Z'}),false)
 eq(isCurrentContextFact({kind:'client_preference',_context_store:'job_context',expires_at:null}),true)
})
