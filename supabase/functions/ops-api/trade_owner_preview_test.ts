import { deepStrictEqual as assertEquals, rejects as assertRejects, throws as assertThrows } from 'node:assert/strict'
import { assertTradePreviewOwner, assertTradePreviewRead, readTradePreviewProfile, tradePreviewContext, TradePreviewError } from './trade_owner_preview.ts'

const owner = { id: 'owner', orgId: 'org-a', email: 'marnin@secureworkswa.com.au', role: 'admin' }
const trade = { id: '11111111-1111-4111-8111-111111111111', org_id: 'org-a', name: 'Synthetic trade', role: 'crew', email: 'trade@example.test', managed_verticals: [], trade_sees_all_jobs: false, trade_details: { gstRegistered: true, bankAccount: 'private' } }
function clientFor(rows: any[]) {
  let calls = 0
  return { get calls() { return calls }, from() {
    calls++
    const filters: Record<string, unknown> = {}
    const result = () => rows.filter(r => Object.entries(filters).every(([k,v]) => r[k] === v))
    const q: any = { select() { return q }, eq(k: string,v: unknown) { filters[k] = v; return q },
      order() { return q }, maybeSingle() { return Promise.resolve({ data: result()[0] || null, error: null }) },
      then(resolve: any) { return Promise.resolve({ data: result(), error: null }).then(resolve) } }
    return q
  } }
}

Deno.test('preview requires the actual owner JWT, not an office role or API key', () => {
  assertTradePreviewOwner(owner)
  for (const caller of [null, {...owner,email:'office@example.test'}, {...owner,role:'crew'}, {...owner,orgId:''}]) {
    assertThrows(() => assertTradePreviewOwner(caller), TradePreviewError)
  }
  assertThrows(() => assertTradePreviewOwner(owner,'api_key'), TradePreviewError)
})

Deno.test('unknown actions and writes are refused, including GET-shaped writes', () => {
  assertTradePreviewRead('my_hours','GET')
  assertTradePreviewRead('group_work_order_my_share','POST')
  for (const action of ['generate_trade_invoice','freeze_group_work_order','set_trade_rate_ops','clock_event','new_future_action']) {
    for (const method of ['GET','POST']) assertThrows(() => assertTradePreviewRead(action,method), TradePreviewError)
  }
  assertThrows(() => assertTradePreviewRead('my_hours','POST'), TradePreviewError)
})

Deno.test('selected profile uses its own permissions and omits private bank details', async () => {
  const client = clientFor([trade])
  const result = await readTradePreviewProfile(client,owner,trade.id)
  assertEquals(result.id,trade.id)
  assertEquals(result.role,'crew')
  assertEquals(result.trade_sees_all_jobs,false)
  assertEquals(result.trade_details,{gstRegistered:true})
})

Deno.test('another tenant, an office target and an invalid id are refused', async () => {
  for (const row of [{...trade,org_id:'org-b'},{...trade,role:'admin'}]) {
    await assertRejects(() => readTradePreviewProfile(clientFor([row]),owner,trade.id), TradePreviewError)
  }
  const client = clientFor([trade])
  await assertRejects(() => readTradePreviewProfile(client,owner,'not-an-id'), TradePreviewError)
  assertEquals(client.calls,0)
})

Deno.test('non-owner cannot query target data and the selector stays in the owner tenant', async () => {
  const client = clientFor([trade,{...trade,id:'other',org_id:'org-b'}])
  await assertRejects(() => tradePreviewContext(client,{...owner,email:'trade@example.test'}),TradePreviewError)
  assertEquals(client.calls,0)
  const result = await tradePreviewContext(client,owner)
  assertEquals('trades' in result ? result.trades.map((r:any)=>r.id) : [],[trade.id])
})

Deno.test('mixed office/trade profile can be previewed without changing its role', async () => {
  const henry = {...trade,role:'ops_manager',invoice_type:'per_metre'}
  const profile = await readTradePreviewProfile(clientFor([henry]),owner,trade.id)
  assertEquals(profile.role,'ops_manager')
  assertEquals(profile.invoice_type,'per_metre')
  await assertRejects(() => readTradePreviewProfile(clientFor([{...henry,invoice_type:null}]),owner,trade.id),TradePreviewError)
  const selector = await tradePreviewContext(clientFor([henry]),owner)
  assertEquals('trades' in selector ? selector.trades.map((p:any)=>p.id) : [],[trade.id])
})
