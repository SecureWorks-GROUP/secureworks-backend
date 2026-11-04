// SE-59 A (adopted 22 Oct): separate jobs for one verified GHL contact,
// displayed together. No fuzzy identity joins and no composite money writer.
export class CustomerScopeJobsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
type Row = Record<string, unknown>;
export interface CustomerJobsStore {
  anchor(id: string, org: string): Promise<{ data: Row | null; error: unknown }>;
  jobs(contact: string, org: string): Promise<{ data: Row[] | null; count: number | null; error: unknown }>;
}
export async function readCustomerScopeJobs(args: { jobId: string; mode: string; orgId: string | null; role: string | null }, store: CustomerJobsStore) {
  if (args.mode !== 'user_jwt' || !args.orgId || !['admin', 'ops_manager', 'division_ops', 'estimator', 'sales'].includes(args.role ?? ''))
    throw new CustomerScopeJobsError(403, 'customer_jobs_forbidden', 'Sign in with a staff account to view customer jobs.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.jobId))
    throw new CustomerScopeJobsError(400, 'job_id_required', 'Open a linked patio or fence job first.');
  const anchor = await store.anchor(args.jobId, args.orgId);
  if (anchor.error) throw new CustomerScopeJobsError(503, 'customer_job_unreadable', 'This job could not be checked. Try again.');
  if (!anchor.data || anchor.data.org_id !== args.orgId || anchor.data.id !== args.jobId)
    throw new CustomerScopeJobsError(404, 'job_not_found', 'This job was not found in your organisation.');
  if (!['patio', 'fencing'].includes(String(anchor.data.type))) throw new CustomerScopeJobsError(422, 'job_type_unsupported', 'Customer grouping starts from a patio or fence job.');
  const contact = typeof anchor.data.ghl_contact_id === 'string' ? anchor.data.ghl_contact_id.trim() : '';
  if (!contact) throw new CustomerScopeJobsError(409, 'customer_link_missing', 'This job has no confirmed customer link. Ask the office to link it before combining its view.');
  const result = await store.jobs(contact, args.orgId);
  if (result.error || !Array.isArray(result.data)) throw new CustomerScopeJobsError(503, 'customer_jobs_unreadable', 'The customer jobs could not all be read. Try again.');
  if (result.count !== null && result.count > 100) throw new CustomerScopeJobsError(422, 'customer_jobs_limit', 'This customer has more than 100 jobs. Open the required jobs separately in the office job list.');
  if (!Number.isInteger(result.count) || result.count !== result.data.length)
    throw new CustomerScopeJobsError(503, 'customer_jobs_incomplete', 'The customer jobs could not all be read. No combined cover was prepared.');
  const ids = new Set<string>();
  const jobs = result.data.map((row) => {
    if (typeof row.id !== 'string' || ids.has(row.id) || row.org_id !== args.orgId || row.ghl_contact_id !== contact || !['patio', 'fencing'].includes(String(row.type)))
      throw new CustomerScopeJobsError(503, 'customer_jobs_inconsistent', 'The customer job links could not be confirmed. No combined cover was prepared.');
    ids.add(row.id);
    const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
    return { id: row.id, type: String(row.type), job_number: text(row.job_number), status: text(row.status),
      client_name: text(row.client_name), site_address: text(row.site_address), site_suburb: text(row.site_suburb) };
  });
  if (!ids.has(args.jobId)) throw new CustomerScopeJobsError(503, 'customer_jobs_inconsistent', 'The starting job is missing from the customer result. No combined cover was prepared.');
  return { anchor_job_id: args.jobId, contact_id: contact, complete: true, jobs };
}
export function customerJobsStore(client: any): CustomerJobsStore {
  const fields = 'id,org_id,ghl_contact_id,type,job_number,status,client_name,site_address,site_suburb';
  return {
    anchor: (id, org) => client.from('jobs').select(fields).eq('id', id).eq('org_id', org).maybeSingle(),
    jobs: (contact, org) => client.from('jobs').select(fields, { count: 'exact' }).eq('org_id', org).eq('ghl_contact_id', contact).in('type', ['patio', 'fencing']).order('created_at', { ascending: true }).limit(101),
  };
}
