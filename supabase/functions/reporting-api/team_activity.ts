// deno-lint-ignore-file no-explicit-any
// team_activity: recent job_events for the reports screen.
//
// job_events has no org_id column (schema 20250301000001; the livefire
// migration only makes job_id nullable). Filtering the table on org_id is a
// PostgREST 400 (42703). The handler used to keep only `data`, so that 400
// came back as an empty activity list.
//
// Org scope lives on jobs.org_id. The table's own RLS policy already joins
// job_events to jobs on that column, and this function runs as the service
// role, which bypasses RLS. The event read therefore inner-joins jobs and
// filters jobs.org_id. An event whose job_id is null (ON DELETE SET NULL)
// has no org and is not this org's activity. Dropping the filter would also
// return another org's events the day a second org exists; that choice needs
// a measured single-org census, which this change does not claim.
//
// A Supabase error on the event read or the follow-up job-name read is a
// failure. An empty event read is an empty list.

export interface TeamActivityEvent {
  type: string;
  job: string;
  who: string;
  when: string;
  detail: string;
}

export type TeamActivityResult =
  | {
    ok: true;
    events: TeamActivityEvent[];
    total: number;
    period: string;
  }
  | {
    ok: false;
    error: string;
    code: string | null;
    status: number;
  };

export interface TeamActivityHttp {
  status: number;
  body: Record<string, unknown>;
}

interface QueryError {
  message?: string;
  code?: string;
}

interface EventRow {
  job_id: string | null;
  event_type: string;
  detail_json: unknown;
  created_at: string;
  users?: { name?: string | null } | null;
}

interface JobRow {
  id: string;
  client_name: string | null;
  job_number: string | null;
}

const EVENT_SELECT =
  "id, job_id, event_type, detail_json, created_at, users:user_id(name), jobs!inner(org_id)";

function failure(
  error: QueryError | null,
  fallback: string,
): TeamActivityResult {
  return {
    ok: false,
    error: error?.message || fallback,
    code: error?.code ?? null,
    status: 500,
  };
}

function detailOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 200);
  return JSON.stringify(value ?? {}).slice(0, 200);
}

/** Recent job events since `since` (ISO), scoped to `orgId` through jobs.org_id. */
export async function loadTeamActivity(
  sb: any,
  since: string,
  orgId: string,
): Promise<TeamActivityResult> {
  if (!orgId) return failure(null, "org_id required");

  const { data: events, error } = await sb.from("job_events")
    .select(EVENT_SELECT)
    .eq("jobs.org_id", orgId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return failure(error, "job_events_unreadable");

  const rows = (events ?? []) as EventRow[];
  const jobIds = [
    ...new Set(rows.map((e) => e.job_id).filter((id): id is string => !!id)),
  ];
  const jobNames: Record<string, string> = {};
  if (jobIds.length > 0) {
    const { data: jobs, error: jobsError } = await sb.from("jobs")
      .select("id, client_name, job_number")
      .eq("org_id", orgId)
      .in("id", jobIds.slice(0, 100));
    if (jobsError) return failure(jobsError, "jobs_unreadable");
    for (const j of (jobs ?? []) as JobRow[]) {
      jobNames[j.id] = `${j.job_number} (${j.client_name})`;
    }
  }

  const mapped = rows.map((e) => ({
    type: e.event_type,
    job: (e.job_id && jobNames[e.job_id]) || e.job_id || "",
    who: e.users?.name || "System",
    when: e.created_at,
    detail: detailOf(e.detail_json),
  }));
  return {
    ok: true,
    events: mapped,
    total: mapped.length,
    period: `Since ${since}`,
  };
}

/** HTTP body for a team_activity result. A read failure is non-200. */
export function teamActivityResponse(
  result: TeamActivityResult,
): TeamActivityHttp {
  if (!result.ok) {
    return {
      status: result.status,
      body: { error: result.error, code: result.code },
    };
  }
  return {
    status: 200,
    body: {
      events: result.events,
      total: result.total,
      period: result.period,
    },
  };
}
