import { createClient as lockedCreateClient } from 'https://esm.sh/@supabase/supabase-js@2';
void lockedCreateClient;
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
// Capture the actual std serve handler using the same no-socket harness as
// send_sms_response_test.ts. Every fetch is replaced before the entry loads.
function server() {
  const waiters: Array<(v: any) => void> = [], queued: any[] = [];
  const listener = { addr: { transport: 'tcp', hostname: '127.0.0.1', port: 8123 }, close() {},
    accept: () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiters.push(resolve)) };
  return { listener, serveHttp(connection: any) { let served = false; return { close() {}, nextRequest() {
    if (served) return Promise.resolve(null); served = true; return Promise.resolve({ request: connection.request, respondWith: connection.respond });
  } }; }, request(request: Request): Promise<Response> { return new Promise((respond) => {
    const connection = { request, respond, localAddr: listener.addr, remoteAddr: { ...listener.addr, port: 8124 } };
    const waiter = waiters.shift(); if (waiter) waiter(connection); else queued.push(connection);
  }); } };
}
Deno.test('actual customer_scope_jobs handler reads only exact verified org/contact and refuses writes', async (t) => {
  const env = { SUPABASE_URL: 'https://customer-jobs.test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SW_API_KEY: 'synthetic-shared', GHL_API_TOKEN: 'synthetic-ghl', GHL_LOCATION_ID: 'synthetic-location' };
  const names = [...Object.keys(env), 'GHL_TEST_PIPELINE_ID', 'GHL_TEST_LOCATION_ID', 'SUPABASE_TEST_ORG_ID', 'GHL_PROXY_REQUIRE_USER_JWT_FOR_BROWSER_ACTIONS'];
  const before = new Map(names.map((k) => [k, Deno.env.get(k)]));
  for (const k of names) Deno.env.delete(k); for (const [k,v] of Object.entries(env)) Deno.env.set(k,v);
  const h=server(), listen=Object.getOwnPropertyDescriptor(Deno,'listen'), serve=Object.getOwnPropertyDescriptor(Deno,'serveHttp'), originalFetch=globalThis.fetch;
  Object.defineProperty(Deno,'listen',{configurable:true,value:()=>h.listener}); Object.defineProperty(Deno,'serveHttp',{configurable:true,value:h.serveHttp});
  const id='fa18407d-9ea7-4910-9f4f-299c3db899df';
  const anchor={id,org_id:'synthetic-org',ghl_contact_id:'synthetic-contact',type:'patio',job_number:'SYNTHETIC-P',status:'draft',client_name:'Synthetic customer',site_address:'Synthetic site',site_suburb:''};
  const fence={...anchor,id:'b7b1e58e-607b-4c9c-8699-cb4a07e43871',type:'fencing',job_number:'SYNTHETIC-F',status:'archived'};
  let role='ops_manager', org='synthetic-org', count='2', dbReads=0;
  globalThis.fetch=async(input,init)=>{
    const req=new Request(input,init),u=new URL(req.url); eq(req.method,'GET');
    if(u.origin!==env.SUPABASE_URL)throw Error('Unexpected provider call');
    if(u.pathname==='/auth/v1/user')return Response.json({id:'synthetic-staff',email:'staff@example.invalid'});
    if(u.pathname==='/rest/v1/users')return Response.json({id:'synthetic-staff',org_id:org,role});
    if(u.pathname==='/rest/v1/jobs'){
      dbReads++;eq(u.searchParams.get('org_id'),'eq.'+org);
      if(u.searchParams.has('id'))return Response.json(org===anchor.org_id?anchor:null);
      eq(u.searchParams.get('ghl_contact_id'),'eq.synthetic-contact');eq(u.searchParams.get('type'),'in.(patio,fencing)');eq(u.searchParams.get('limit'),'101');
      if(!String(req.headers.get('prefer')).includes('count=exact'))throw Error('Exact completion count missing');
      return Response.json([anchor,fence],{headers:count?{'content-range':'0-1/'+count}:{}});
    }
    throw Error('Unexpected database request');
  };
  const request=(headers:Record<string,string>={authorization:'Bearer synthetic-user'},method='GET')=>h.request(new Request('https://proxy.test.invalid/?action=customer_scope_jobs&jobId='+id,{method,headers}));
  try{
    const entrypoint='./index'+'.ts';await import(entrypoint);
    await t.step('staff GET lists separate exact-contact patio/fence jobs including archive without money',async()=>{const r=await request();eq(r.status,200);const b=await r.json();eq(b.complete,true);eq(b.jobs.length,2);eq(b.jobs[1].status,'archived');eq('pricing_json' in b.jobs[0],false);});
    await t.step('POST and shared/service credentials make no database read or write',async()=>{const before=dbReads;eq((await request(undefined,'POST')).status,405);for(const key of [env.SW_API_KEY,env.SUPABASE_SERVICE_ROLE_KEY])eq((await request({'x-api-key':key})).status,403);eq(dbReads,before);});
    await t.step('trade and foreign-org callers cannot group the anchor',async()=>{role='trade';eq((await request()).status,403);role='ops_manager';org='other';eq((await request()).status,404);org='synthetic-org';});
    await t.step('missing or partial exact count never declares the list complete',async()=>{for(const value of ['', '3']){count=value;eq((await request()).status,503);}count='2';});
    await t.step('missing confirmed contact never falls back to names',async()=>{anchor.ghl_contact_id='';eq((await request()).status,409);});
  }finally{
    globalThis.fetch=originalFetch;if(listen)Object.defineProperty(Deno,'listen',listen);if(serve)Object.defineProperty(Deno,'serveHttp',serve);
    for(const[k,v]of before){if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v);}
  }
});
