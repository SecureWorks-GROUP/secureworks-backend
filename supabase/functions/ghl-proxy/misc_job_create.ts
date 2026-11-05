// A walk-up Misc draft has one durable identity before its first network call.
// Replaying the request UUID reads that row; it never upserts or replaces a job.
export class MiscJobCreateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export interface MiscJobCaller { mode: string; userId: string | null; orgId: string | null; role: string | null }
type Row = Record<string, unknown>;
export interface MiscJobStore {
  read(id: string): Promise<{ data: Row | null; error: unknown }>;
  insert(row: Row): Promise<{ data: Row | null; error: { code?: string } | null }>;
}
const FIELDS = ['requestId', 'clientName', 'clientPhone', 'clientEmail', 'siteAddress'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMNS = { clientName: 'client_name', clientPhone: 'client_phone', clientEmail: 'client_email', siteAddress: 'site_address' } as const;

export async function createMiscDraft(body: unknown, caller: MiscJobCaller, store: MiscJobStore) {
  if (caller.mode !== 'user_jwt' || !caller.userId || !caller.orgId || !['admin', 'estimator', 'sales', 'ops_manager', 'division_ops'].includes(caller.role ?? ''))
    throw new MiscJobCreateError(403, 'misc_create_forbidden', 'Sign in with a staff account that can start jobs.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MiscJobCreateError(400, 'invalid_misc_create', 'A request object is required.');
  const input = body as Row;
  if (Object.keys(input).some((k) => !(FIELDS as readonly string[]).includes(k)) || FIELDS.some((k) => typeof input[k] !== 'string'))
    throw new MiscJobCreateError(400, 'invalid_misc_create', 'Only the request identity, customer and site are accepted.');
  const requestId = String(input.requestId).toLowerCase();
  if (!UUID.test(requestId)) throw new MiscJobCreateError(400, 'invalid_misc_request_id', 'A permanent request UUID is required.');
  const expected: Row = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = String(input[key]).trim();
    if (value.length > (key === 'siteAddress' ? 1000 : 300)) throw new MiscJobCreateError(400, 'invalid_misc_create', 'A customer or site field is too long.');
    expected[column] = key === 'clientEmail' ? value.toLowerCase() : value;
  }
  if (!expected.client_name || !expected.site_address || (!expected.client_phone && !expected.client_email))
    throw new MiscJobCreateError(400, 'misc_customer_missing', 'Enter a customer name, mobile or email, and site address.');

  const confirm = (row: Row | null, reused: boolean) => {
    if (!row || row.id !== requestId || row.org_id !== caller.orgId || row.created_by !== caller.userId || row.type !== 'general'
      || Object.entries(expected).some(([k, v]) => row[k] !== v))
      throw new MiscJobCreateError(409, 'misc_request_conflict', 'This request belongs to a different or changed job. Open it from the office job list; no new job was made.');
    if (typeof row.job_number !== 'string' || !row.job_number.trim())
      throw new MiscJobCreateError(503, 'misc_job_unconfirmed', 'The job exists but its number could not be confirmed. Keep this request and retry.');
    return { jobId: requestId, jobNumber: row.job_number, reused };
  };
  const existing = await store.read(requestId);
  if (existing.error) throw new MiscJobCreateError(503, 'misc_read_unconfirmed', 'The request could not be checked. No create was attempted.');
  if (existing.data) return confirm(existing.data, true);
  const result = await store.insert({ id: requestId, org_id: caller.orgId, created_by: caller.userId,
    type: 'general', status: 'draft', legacy: false, ...expected });
  if (!result.error) return confirm(result.data, false);
  // Another request may have inserted the same primary key after our read.
  // Read only on that conflict. A timeout/error remains unknown and is retried
  // with the same UUID, even if the provider committed before losing its reply.
  if (result.error.code === '23505') {
    const raced = await store.read(requestId);
    if (!raced.error && raced.data) return confirm(raced.data, true);
  }
  throw new MiscJobCreateError(503, 'misc_create_unconfirmed', 'The create outcome is unknown. Keep this request and retry it; do not start a second job.');
}

export function miscJobStore(client: any): MiscJobStore {
  const fields = 'id,org_id,created_by,type,status,job_number,client_name,client_phone,client_email,site_address';
  return {
    read: (id) => client.from('jobs').select(fields).eq('id', id).maybeSingle(),
    insert: (row) => client.from('jobs').insert(row).select(fields).single(),
  };
}
