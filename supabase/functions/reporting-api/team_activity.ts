// team_activity: recent job_events for the reports screen.
//
// job_events has no org_id column. A filter on it is a PostgREST 400
// (42703). The old reader kept only `data`, so that 400 came back as an
// empty activity list. This reader returns the Supabase error instead.

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

interface QueryError {
  message?: string;
  code?: string;
}

// deno-lint-ignore no-explicit-any
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
  return JSON.stringify(value || {}).slice(0, 200);
}

/** Recent job events since `since` (ISO). Does not filter job_events by org_id. */
// deno-lint-ignore no-explicit-any
export async function loadTeamActivity(
  sb: any,
  since: string,
): Promise<TeamActivityResult> {
  const { data: events, error } = await sb.from("job_events")
    .select(
      "id, job_id, event_type, detail_json, created_at, users:user_id(name)",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return failure(error, "job_events_unreadable");

  const rows = (events ?? []) as Array<{
    job_id: string;
    event_type: string;
    detail_json: unknown;
    created_at: string;
    users?: { name?: string | null } | null;
  }>;
  const jobIds = [...new Set(rows.map((e) => e.job_id).filter(Boolean))];
  const jobNames: Record<string, string> = {};
  if (jobIds.length > 0) {
    const { data: jobs, error: jobsError } = await sb.from("jobs")
      .select("id, client_name, job_number")
      .in("id", jobIds.slice(0, 100));
    if (jobsError) return failure(jobsError, "jobs_unreadable");
    for (
      const j of (jobs ?? []) as Array<{
        id: string;
        client_name: string;
        job_number: string;
      }>
    ) {
      jobNames[j.id] = `${j.job_number} (${j.client_name})`;
    }
  }

  const mapped = rows.map((e) => ({
    type: e.event_type,
    job: jobNames[e.job_id] || e.job_id,
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
