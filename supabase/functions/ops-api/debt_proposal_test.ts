import { debtProposalSave, debtProposalMark } from './debt_picture.ts'
function assert(value: unknown, message = 'assertion failed'): asserts value { if (!value) throw new Error(message) }
const xid = '11111111-1111-4111-8111-111111111111'
function fake(extra: Record<string, unknown> = {}) {
  const row: any = { xero_invoice_id: xid, org_id: 'org', invoice_type: 'ACCREC', status: 'AUTHORISED', amount_due: 100, debt_proposal_status: 'approved', debt_proposal_at: null, debt_proposal_approved_by: 'previous', ...extra }
  const writes: any[] = [], logs: any[] = []
  const client = { from(table: string) {
    assert(['xero_invoices','payment_chase_logs'].includes(table), 'Unexpected side effect table')
    let update: any; const filters: Array<(r: any)=>boolean> = []
    const q: any = {
      select() { return q }, eq(k: string,v: unknown) { filters.push(r=>r[k]===v); return q }, is(k: string,v: unknown) { filters.push(r=>(r[k]??null)===v);return q }, gt(k: string,v: number) {filters.push(r=>r[k]>v);return q},
      update(value: any) {update=value;return q},
      maybeSingle() {if (!filters.every(f=>f(row))) return Promise.resolve({data:null,error:null}); if(update){writes.push(update);Object.assign(row,update)} return Promise.resolve({data:{...row},error:null})},
      insert(value: any) {logs.push(value);return Promise.resolve({error:null})},
    }; return q
  } }
  return { client, row, writes, logs }
}
const request = {xero_invoice_id:xid,kind:'sms',text:'Please review the invoice balance.',to:'+61491570156'}
async function rejects(fn:()=>Promise<unknown>) { let rejected=false; try { await fn() } catch {rejected=true} assert(rejected,'Expected refusal') }
Deno.test('pending proposal saves exact text, resets approval and repeats without writes', async()=>{
  const f=fake(); const first=await debtProposalSave(f.client,request,'org','staff'); assert(first.status==='pending' && first.changed); assert(f.row.debt_proposal_text===request.text); assert(f.row.debt_proposal_approved_by===null);assert(f.row.debt_proposal_sent_ref===null)
  const second=await debtProposalSave(f.client,request,'org','staff');assert(second.changed===false);assert(f.writes.length===1 && f.logs.length===1)
})
Deno.test('email subject and complete body persist as one reviewable proposal',async()=>{
 const f=fake();await debtProposalSave(f.client,{...request,kind:'email',subject:'Invoice question',to:'accounts@example.test'},'org','staff'); assert(f.row.debt_proposal_text==='Subject: Invoice question\n\n'+request.text)
})
Deno.test('cannot approve, mark sent, spoof organisation or save a closed invoice',async()=>{
 for(const field of ['status','approved_by','sent_ref','org_id']) {const f=fake();await rejects(()=>debtProposalSave(f.client,{...request,[field]:'approved'},'org','staff'));assert(!f.writes.length)}
 for(const status of ['approved','sent','pending']) {const f=fake(); await rejects(()=>debtProposalMark(f.client,{xero_invoice_id:xid,status,operator_email:'marnin@example.test'}));assert(!f.writes.length)}
 for(const extra of [{status:'PAID'},{invoice_type:'ACCPAY'},{amount_due:0},{org_id:'other'}]) {const f=fake(extra);await rejects(()=>debtProposalSave(f.client,request,'org','staff'));assert(!f.writes.length)}
 await rejects(()=>debtProposalSave(fake().client,request,'','staff'))
})
Deno.test('route refuses non-staff and GET; authenticated identity overrides body email',async()=>{
 const source=Deno.readTextFileSync(new URL('./index.ts',import.meta.url));const route=source.slice(source.indexOf("case 'debt_proposal_save':"),source.indexOf("case 'list_debt_picture':"));
 const run = new Function('req','authMode','authUser','body','client','debtProposalSave', 'DebtPictureError', `return (async()=>{ const action='debt_proposal_save'; const DEFAULT_ORG_ID='org'; const json=(body,status=200)=>({body,status}); const _opsApiCallerIsStaffOperator=(mode,user)=>mode==='api_key'||(mode==='jwt'&&user?.role==='admin'); switch(action){${route}} })()`)
 const {DebtPictureError}=await import('./debt_picture.ts')
 const f=fake(); const user={role:'admin',email:'verified@example.test',orgId:'org'}
 const invoke=(method:string,actor:any,body:any={...request,operator_email:'spoof@example.test'})=>run({method},'jwt',actor,body,f.client,debtProposalSave,DebtPictureError)
 assert((await invoke('GET',user)).status===405);assert((await invoke('POST',{...user,role:'installer'})).status===403);assert(!f.writes.length)
 const result=await invoke('POST',user);assert(result.status===200 && result.body.status==='pending');assert(f.logs[0].chased_by==='verified@example.test')
 assert((await invoke('POST',{...user,orgId:'different'})).status===404)
})
