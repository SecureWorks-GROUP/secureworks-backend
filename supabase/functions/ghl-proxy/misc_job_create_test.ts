import { createMiscDraft, MiscJobCreateError, type MiscJobStore } from './misc_job_create.ts';
const id = '9a0d57bf-e3be-4e46-8b5d-4e2081266078';
const input = { requestId: id, clientName: 'Synthetic example', clientPhone: '', clientEmail: 'example@example.invalid', siteAddress: 'Synthetic site' };
const caller = { mode: 'user_jwt', userId: 'staff-a', orgId: 'org-a', role: 'ops_manager' };
function eq(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function refused(fn: () => Promise<unknown>, code: string) { try { await fn(); throw new Error('Expected refusal'); } catch (e) { if (!(e instanceof MiscJobCreateError)) throw e; eq(e.code, code); } }
function harness() {
  const rows = new Map<string, Record<string, unknown>>(); let inserts = 0;
  const store: MiscJobStore = {
    read: async (key) => ({ data: rows.get(key) ?? null, error: null }),
    insert: async (row) => {
      inserts++;
      if (rows.has(String(row.id))) return { data: null, error: { code: '23505' } };
      const saved = { ...row, job_number: 'SYNTHETIC' }; rows.set(String(row.id), saved); return { data: saved, error: null };
    },
  };
  return { rows, store, inserts: () => inserts };
}
Deno.test('one Misc request creates one general draft and replays without replacing it', async () => {
  const h = harness(); const first = await createMiscDraft(input, caller, h.store);
  eq(first, { jobId: id, jobNumber: 'SYNTHETIC', reused: false });
  const row = h.rows.get(id)!; eq(row.type, 'general'); eq(row.status, 'draft'); eq(row.created_by, caller.userId);
  row.scope_json = { tool: 'misc-scoper', retained: true }; row.status = 'quoted';
  eq(await createMiscDraft(input, caller, h.store), { ...first, reused: true });
  eq(h.inserts(), 1); eq(row.scope_json, { tool: 'misc-scoper', retained: true }); eq(row.status, 'quoted');
});
Deno.test('concurrent same-request creates converge through the jobs primary key', async () => {
  const h = harness(); const results = await Promise.all(Array.from({ length: 8 }, () => createMiscDraft(input, caller, h.store)));
  eq(h.rows.size, 1); eq(results.every((r) => r.jobId === id), true); eq(results.filter((r) => !r.reused).length, 1);
});
Deno.test('lost insert reply retries the same row without another create', async () => {
  const h = harness(); const insert = h.store.insert;
  h.store.insert = async (row) => { await insert(row); return { data: null, error: { code: 'timeout' } }; };
  await refused(() => createMiscDraft(input, caller, h.store), 'misc_create_unconfirmed');
  eq((await createMiscDraft(input, caller, h.store)).reused, true); eq(h.inserts(), 1);
});
Deno.test('org, actor, type, customer and site conflicts never overwrite or create', async () => {
  for (const patch of [{ org_id: 'other' }, { created_by: 'other' }, { type: 'patio' }, { client_name: 'changed' }, { site_address: 'changed' }]) {
    const h = harness(); await createMiscDraft(input, caller, h.store); Object.assign(h.rows.get(id)!, patch);
    await refused(() => createMiscDraft(input, caller, h.store), 'misc_request_conflict'); eq(h.inserts(), 1);
  }
});
Deno.test('unreadable requests never become permission to create', async () => {
  const h = harness(); h.store.read = async () => ({ data: null, error: { code: 'unreadable' } });
  await refused(() => createMiscDraft(input, caller, h.store), 'misc_read_unconfirmed'); eq(h.inserts(), 0);
});
Deno.test('missing number stays unconfirmed and cannot create a second job', async () => {
  const h = harness(); await createMiscDraft(input, caller, h.store); h.rows.get(id)!.job_number = null;
  await refused(() => createMiscDraft(input, caller, h.store), 'misc_job_unconfirmed'); eq(h.inserts(), 1);
});
Deno.test('only verified staff can create; supplied scope, pricing, type and identities are rejected', async () => {
  const h = harness();
  for (const c of [{ ...caller, mode: 'shared_key' }, { ...caller, mode: 'service_role' }, { ...caller, role: 'trade' }, { ...caller, userId: null }, { ...caller, orgId: null }])
    await refused(() => createMiscDraft(input, c, h.store), 'misc_create_forbidden');
  for (const patch of [{ toolType: 'patio' }, { orgId: 'other' }, { created_by: 'other' }, { scopeJson: {} }, { pricing_json: {} }])
    await refused(() => createMiscDraft({ ...input, ...patch }, caller, h.store), 'invalid_misc_create');
  for (const patch of [{ clientName: '' }, { siteAddress: '' }, { clientEmail: '' }])
    await refused(() => createMiscDraft({ ...input, ...patch }, caller, h.store), 'misc_customer_missing');
  await refused(() => createMiscDraft({ ...input, requestId: 'bad' }, caller, h.store), 'invalid_misc_request_id'); eq(h.inserts(), 0);
});
