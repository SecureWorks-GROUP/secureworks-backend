import { DebtPictureError, debtProposalSave, debtProposalMark } from './debt_picture.ts'
function assert(value: unknown, message = 'assertion failed'): asserts value { if (!value) throw new Error(message) }
const xid = '11111111-1111-4111-8111-111111111111'
function fake(extra: Record<string, unknown> = {}, beforeUpdate?: (row: any) => void) {
  const row: any = { xero_invoice_id: xid, org_id: 'org', invoice_type: 'ACCREC', status: 'AUTHORISED', amount_due: 100, debt_proposal_status: 'approved', debt_proposal_at: null, debt_proposal_approved_by: 'previous', ...extra }
  const writes: any[] = [], logs: any[] = []
  const client = { from(table: string) {
    assert(['xero_invoices','payment_chase_logs'].includes(table), 'Unexpected side effect table')
    let update: any; const filters: Array<(r: any)=>boolean> = []
    const q: any = {
      select() { return q }, eq(k: string,v: unknown) { filters.push(r=>r[k]===v); return q }, is(k: string,v: unknown) { filters.push(r=>(r[k]??null)===v);return q }, gt(k: string,v: number) {filters.push(r=>r[k]>v);return q},
      update(value: any) {update=value;return q},
      maybeSingle() {if (update) beforeUpdate?.(row); if (!filters.every(f=>f(row))) return Promise.resolve({data:null,error:null}); if(update){writes.push(update);Object.assign(row,update)} return Promise.resolve({data:{...row},error:null})},
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

Deno.test('pending proposal audit preserves the authenticated tenant and actor', async () => {
  const orgId = '22222222-2222-4222-8222-222222222222'
  const f = fake({ org_id: orgId })
  await debtProposalSave(f.client, { ...request, operator_email: 'spoof@example.test' }, orgId, 'verified@example.test')
  assert(f.writes.length === 1 && f.logs.length === 1)
  assert(f.row.org_id === orgId && f.logs[0].org_id === orgId)
  assert(f.logs[0].xero_invoice_id === xid && f.logs[0].chased_by === 'verified@example.test')
})

Deno.test('concurrent proposal decisions and content changes refuse stale saves', async () => {
  const observed = {
    debt_proposal_at: '2026-09-11T00:00:00.000Z',
    debt_proposal_status: 'pending', debt_proposal_kind: 'sms',
    debt_proposal_text: 'Original draft', debt_proposal_to: '+61400000000',
  }
  const changes = [
    { debt_proposal_status: 'declined' }, { debt_proposal_status: 'expired' },
    { debt_proposal_kind: 'email' }, { debt_proposal_text: 'Concurrent edit' },
    { debt_proposal_to: 'new@example.test' }, { debt_proposal_at: '2026-09-11T00:01:00.000Z' },
  ]
  for (const change of changes) {
    const f = fake(observed, row => Object.assign(row, change))
    const expected = { ...f.row, ...change }
    let error: unknown
    try { await debtProposalSave(f.client, request, 'org', 'staff') } catch (e) { error = e }
    assert(error instanceof DebtPictureError && error.status === 409, 'Expected stale proposal conflict')
    assert(JSON.stringify(f.row) === JSON.stringify(expected), 'Concurrent state must survive')
    assert(f.writes.length === 0 && f.logs.length === 0, 'Conflict must not persist or audit a save')
  }
})

Deno.test('nullable proposal fields allow unchanged saves and reject concurrent initialization', async () => {
  for (const field of ['debt_proposal_at', 'debt_proposal_status', 'debt_proposal_kind', 'debt_proposal_text', 'debt_proposal_to']) {
    const initial = { [field]: null }
    const unchanged = fake(initial)
    assert((await debtProposalSave(unchanged.client, request, 'org', 'staff')).changed)
    const concurrent = fake(initial, row => { row[field] = 'concurrently initialized' })
    let error: unknown
    try { await debtProposalSave(concurrent.client, request, 'org', 'staff') } catch (e) { error = e }
    assert(error instanceof DebtPictureError && error.status === 409)
    assert(concurrent.row[field] === 'concurrently initialized')
    assert(concurrent.writes.length === 0 && concurrent.logs.length === 0)
  }
})
