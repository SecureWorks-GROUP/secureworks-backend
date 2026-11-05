import { CustomerScopeJobsError, readCustomerScopeJobs, type CustomerJobsStore } from './customer_scope_jobs.ts';
const id = 'fa18407d-9ea7-4910-9f4f-299c3db899df', other = 'b7b1e58e-607b-4c9c-8699-cb4a07e43871';
const row = { id, org_id: 'synthetic-org', ghl_contact_id: 'synthetic-contact', type: 'patio', job_number: 'SYNTHETIC-P', status: 'draft', client_name: 'Synthetic customer', site_address: 'Synthetic site', site_suburb: '' };
const fence = { ...row, id: other, type: 'fencing', job_number: 'SYNTHETIC-F', status: 'archived' };
const args = { jobId: id, mode: 'user_jwt', orgId: row.org_id, role: 'ops_manager' };
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
async function refused(fn: () => Promise<unknown>, code: string) { try { await fn(); throw Error('Expected refusal'); } catch (e) { if (!(e instanceof CustomerScopeJobsError)) throw e; eq(e.code, code); } }
function store(anchor: Record<string, unknown> | null = row, rows: Record<string, unknown>[] = [row, fence], count: number | null = rows.length): CustomerJobsStore {
  return { anchor: async (key, org) => { eq([key, org], [id, row.org_id]); return { data: anchor, error: null }; },
    jobs: async (contact, org) => { eq([contact, org], [row.ghl_contact_id, row.org_id]); return { data: rows, count, error: null }; } };
}
Deno.test('confirmed contact lists patio and fence including archived work, without scope or money', async () => {
  const r = await readCustomerScopeJobs(args, store()); eq(r.complete, true); eq(r.jobs.map((j) => [j.id, j.type, j.status]), [[id, 'patio', 'draft'], [other, 'fencing', 'archived']]);
  eq(Object.keys(r.jobs[0]).sort(), ['id', 'type', 'job_number', 'status', 'client_name', 'site_address', 'site_suburb'].sort());
});
Deno.test('missing confirmed customer link never uses name, phone, email or site inference', async () => {
  const s = store({ ...row, ghl_contact_id: null }); s.jobs = () => { throw Error('Must not infer a contact'); };
  await refused(() => readCustomerScopeJobs(args, s), 'customer_link_missing');
});
Deno.test('foreign anchor, foreign contact, wrong type and duplicate identities fail closed', async () => {
  await refused(() => readCustomerScopeJobs(args, store({ ...row, org_id: 'other' })), 'job_not_found');
  await refused(() => readCustomerScopeJobs(args, store({ ...row, type: 'general' })), 'job_type_unsupported');
  for (const rows of [[row, { ...fence, org_id: 'other' }], [row, { ...fence, ghl_contact_id: 'other' }], [row, { ...fence, type: 'general' }], [row, row]])
    await refused(() => readCustomerScopeJobs(args, store(row, rows)), 'customer_jobs_inconsistent');
});
Deno.test('partial, unreadable and over-limit results never claim complete', async () => {
  await refused(() => readCustomerScopeJobs(args, store(row, [row], 2)), 'customer_jobs_incomplete');
  await refused(() => readCustomerScopeJobs(args, store(row, [row], null)), 'customer_jobs_incomplete');
  await refused(() => readCustomerScopeJobs(args, store(row, [row], 101)), 'customer_jobs_limit');
  await refused(() => readCustomerScopeJobs(args, store(row, [fence])), 'customer_jobs_inconsistent');
  const s = store(); s.jobs = async () => ({ data: null, count: null, error: 'unreadable' });
  await refused(() => readCustomerScopeJobs(args, s), 'customer_jobs_unreadable');
});
Deno.test('only verified staff read customer grouping; arbitrary contact and service keys are not authority', async () => {
  for (const patch of [{ role: 'trade' }, { mode: 'shared_key' }, { mode: 'service_role' }, { orgId: null }]) await refused(() => readCustomerScopeJobs({ ...args, ...patch }, store()), 'customer_jobs_forbidden');
  await refused(() => readCustomerScopeJobs({ ...args, jobId: 'bad' }, store()), 'job_id_required');
});
