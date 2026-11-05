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
Deno.test('actual create_misc_draft handler authenticates, creates once, replays and refuses foreign identity', async (t) => {
  const env = { SUPABASE_URL: 'https://misc-create.test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', SW_API_KEY: 'synthetic-shared', GHL_API_TOKEN: 'synthetic-ghl', GHL_LOCATION_ID: 'synthetic-location' };
  const names = [...Object.keys(env), 'GHL_TEST_PIPELINE_ID', 'GHL_TEST_LOCATION_ID', 'SUPABASE_TEST_ORG_ID', 'GHL_PROXY_REQUIRE_USER_JWT_FOR_BROWSER_ACTIONS'];
  const before = new Map(names.map((k) => [k, Deno.env.get(k)]));
  for (const k of names) Deno.env.delete(k); for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const h = server(), listen = Object.getOwnPropertyDescriptor(Deno, 'listen'), serve = Object.getOwnPropertyDescriptor(Deno, 'serveHttp'), fetch = globalThis.fetch;
  Object.defineProperty(Deno, 'listen', { configurable: true, value: () => h.listener });
  Object.defineProperty(Deno, 'serveHttp', { configurable: true, value: h.serveHttp });
  const rows = new Map<string, Record<string, unknown>>(); let inserts = 0, role = 'ops_manager', actor = 'synthetic-staff', org = 'synthetic-org';
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), u = new URL(req.url);
    if (u.origin !== env.SUPABASE_URL) throw Error('Unexpected external provider request');
    if (u.pathname === '/auth/v1/user') return Response.json({ id: actor, email: 'staff@example.invalid' });
    if (u.pathname === '/rest/v1/users') return Response.json({ id: actor, org_id: org, role });
    if (u.pathname === '/rest/v1/jobs') {
      if (req.method === 'GET') return Response.json(rows.get((u.searchParams.get('id') ?? '').replace(/^eq\./, '')) ?? null);
      if (req.method === 'POST') {
        const row = await req.json(); inserts++;
        if (rows.has(row.id)) return Response.json({ code: '23505', message: 'duplicate primary key' }, { status: 409 });
        const saved = { ...row, job_number: 'SYNTHETIC' }; rows.set(row.id, saved); return Response.json(saved, { status: 201 });
      }
    }
    throw Error('Unexpected database action: ' + req.method + ' ' + u.pathname);
  };
  const body = { requestId: '6ced150a-a5e8-44e8-80ed-af91d68bbf41', clientName: 'Synthetic example', clientPhone: '', clientEmail: 'example@example.invalid', siteAddress: 'Synthetic site' };
  const request = (payload: unknown = body, headers: Record<string, string> = { authorization: 'Bearer synthetic-user' }, method = 'POST') => h.request(new Request('https://proxy.test.invalid/?action=create_misc_draft', {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
  }));
  try {
    const entrypoint = './index' + '.ts'; await import(entrypoint);
    await t.step('JWT staff creates a general draft with verified org/actor only', async () => {
      const response = await request(); eq(response.status, 200); const data = await response.json(); eq(data.jobId, body.requestId);
      const row = rows.get(body.requestId)!; eq([row.type, row.status, row.org_id, row.created_by], ['general', 'draft', org, actor]); eq(inserts, 1);
    });
    await t.step('same UUID retries return the same row without updating it', async () => {
      rows.get(body.requestId)!.scope_json = { untouched: true }; eq((await request()).status, 200); eq(inserts, 1); eq(rows.get(body.requestId)!.scope_json, { untouched: true });
    });
    await t.step('shared and service credentials cannot create', async () => { for (const key of [env.SW_API_KEY, env.SUPABASE_SERVICE_ROLE_KEY]) eq((await request(body, { 'x-api-key': key })).status, 403); eq(inserts, 1); });
    await t.step('trade JWT cannot create', async () => { role = 'trade'; eq((await request()).status, 403); role = 'ops_manager'; });
    await t.step('different org and actor cannot reuse a known UUID', async () => {
      org = 'other-org'; eq((await request()).status, 409); org = 'synthetic-org'; actor = 'other-staff'; eq((await request()).status, 409); actor = 'synthetic-staff'; eq(inserts, 1);
    });
    await t.step('GET and caller pricing are refused without a row write', async () => { eq((await request(body, undefined, 'GET')).status, 405); eq((await request({ ...body, pricing_json: {} })).status, 400); eq(inserts, 1); });
  } finally {
    globalThis.fetch = fetch; if (listen) Object.defineProperty(Deno, 'listen', listen); if (serve) Object.defineProperty(Deno, 'serveHttp', serve);
    for (const [k, v] of before) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
});
