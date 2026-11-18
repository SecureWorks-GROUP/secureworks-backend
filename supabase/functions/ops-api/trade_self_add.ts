// P1-16.12: discovery carries no contact data; only an accepted booking grants access.
import { readFlag } from './job_work_orders.ts';
import { perthToday } from './trade_invoice_time_entry.ts';

export const SELF_ADDED_CONTACT_ACCESS_FILTER =
  'added_by.is.null,added_by.neq.self,self_added_status.eq.accepted';

export function bookingGrantsContactAccess(row: any): boolean {
  return row?.added_by !== 'self' || row?.self_added_status === 'accepted';
}

export class SelfAddError extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

async function requireSwitch(client: any) {
  if (!(await readFlag(client, 'trade_self_add_v1'))) {
    throw new SelfAddError('self_add_switch_off', 'Adding yourself to a job is not available.');
  }
}

function live(job: any): boolean {
  return !!job && !!job.status && !['cancelled', 'lost', 'draft', 'quoted'].includes(job.status);
}

type Actor = { id: string; orgId: string };
type Dependencies = {
  today?: string;
  createAssignment: (body: any) => Promise<any>;
  isUserDateConflict: (error: any) => boolean;
  enrollGroup: (jobId: string, userId: string) => Promise<void>;
};

export async function addMyselfToJob(client: any, body: any, actor: Actor, deps: Dependencies) {
  await requireSwitch(client);
  const today = deps.today || perthToday();
  const day = body.day ?? today;
  const start = new Date(`${today}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ||
      day < start.toISOString().slice(0, 10) || day > today) {
    throw new SelfAddError('self_add_day_invalid', 'Pick today or an earlier day this week.', 400);
  }
  // jobs_pkey: one explicit job, fenced by the signed-in caller's organisation.
  const { data: job, error } = await client.from('jobs')
    .select('id, org_id, job_number, status').eq('id', body.job_id).eq('org_id', actor.orgId).maybeSingle();
  if (error) throw error;
  if (!live(job)) throw new SelfAddError('self_add_job_not_live', 'That job is not open for work.');
  const find = async () => {
    // job_assignments_job_user_date_key bounds this to one row, including NULL statuses.
    const { data, error } = await client.from('job_assignments')
      .select('id, status, is_ghost').eq('job_id', job.id).eq('user_id', actor.id)
      .eq('scheduled_date', day).maybeSingle();
    if (error) throw error;
    return data && data.status !== 'cancelled' && data.is_ghost !== true ? data : null;
  };
  let assignment = await find();
  let alreadyOn = !!assignment;
  if (!assignment) {
    try {
      const result = await deps.createAssignment({
        jobId: job.id, userId: actor.id, scheduledDate: day, role: 'installer',
        assignmentType: 'install', confirmationStatus: 'confirmed', keep_job_status: true,
        suppress_notifications: true, allocated_by_user_id: actor.id, self_added: true,
      });
      assignment = result.assignment;
      alreadyOn = result.deduped === true;
    } catch (error) {
      if (!deps.isUserDateConflict(error)) throw error;
      assignment = await find();
      if (!assignment) throw error;
      alreadyOn = true;
    }
  }
  // Duplicate presses write nothing. A failed additive enrollment never undoes the booking.
  try { if (!alreadyOn) await deps.enrollGroup(job.id, actor.id); }
  catch { console.error('[self_add] group enrollment unavailable'); }
  return {
    ok: true, assignment_id: assignment.id, job_id: job.id, job_number: job.job_number,
    day, already_on: alreadyOn,
    words: `You are on job ${job.job_number} for ${day}. The office and the crew lead can see you added yourself.`,
  };
}

// Only named discovery fields cross this boundary, even if the database adds new columns.
export function contactFreeJob(job: any) {
  return { id: job.id, job_number: job.job_number, site_suburb: job.site_suburb, type: job.type };
}

export async function jobsNearMe(client: any, params: URLSearchParams, actor: Actor) {
  await requireSwitch(client);
  const rawLat = params.get('lat'), rawLng = params.get('lng');
  const lat = Number(rawLat), lng = Number(rawLng);
  if (!rawLat?.trim() || !rawLng?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new SelfAddError('position_required', 'Your position is required.', 400);
  }
  // idx_jobs_org bounds the company read. The ticket requires the coordinate box, no new index.
  // Page the box so PostgREST's row ceiling cannot silently omit the nearest job.
  const candidates: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from('jobs')
      .select('id, org_id, job_number, site_suburb, type, status, site_lat, site_lng')
      .eq('org_id', actor.orgId).not('status', 'in', '(cancelled,lost,draft,quoted)')
      .gte('site_lat', lat - 0.01).lte('site_lat', lat + 0.01)
      .gte('site_lng', lng - 0.01).lte('site_lng', lng + 0.01)
      .order('id').range(offset, offset + 499);
    if (error) throw error;
    for (const job of data || []) {
      if (job.org_id !== actor.orgId || !live(job) || job.site_lat == null || job.site_lng == null) continue;
      const rad = Math.PI / 180;
      const a = Math.sin((Number(job.site_lat) - lat) * rad / 2) ** 2 +
        Math.cos(lat * rad) * Math.cos(Number(job.site_lat) * rad) *
        Math.sin((Number(job.site_lng) - lng) * rad / 2) ** 2;
      const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
      if (Number.isFinite(distance) && distance <= 1000) {
        candidates.push({ ...contactFreeJob(job), distance_m: Math.round(distance), distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)));
    candidates.splice(5);
    if ((data || []).length < 500) break;
  }
  return { jobs: candidates.map(({ distance: _distance, ...row }) => row) };
}
