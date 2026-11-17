// deno-lint-ignore-file no-explicit-any
// P4-10.2: staff sessions read and grade the retained weekly sample.
type WeeklyCheckRequest = {
  action: string;
  method: string;
  query: URLSearchParams;
  body: any;
  authMode: string;
  user?: { id: string } | null;
  staff: boolean;
};
const SCORE_COLUMNS =
  "week,drawn,read,things,wrong,score,story_wrong,notes_wrong,missing_count,stories_with_miss,jobs_with_miss,complete,candidate_rows,word_closes_read,word_closes_wrong,word_close_accuracy,record_closes_read,record_closes_wrong,record_close_accuracy";
const SAMPLE_COLUMNS =
  "job_id,job:jobs!inner(job_number),as_at:page->as_at,story,notes,story_source,notes_source,read_at,marks,missing";
const RECORD_ERRORS: Record<string, [number, string]> = {
  weekly_record_bad_mark: [
    400,
    "That sentence or note is not on this job's list.",
  ],
  weekly_record_bad_missing: [
    400,
    "Each missing line needs 3 to 300 characters, at most 20 lines.",
  ],
  weekly_record_not_staff: [403, "Only office staff can record a weekly read."],
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

export async function weeklyCheckAction(
  client: any,
  input: WeeklyCheckRequest,
): Promise<{ status: number; body: any }> {
  const answer = (status: number, body: any) => ({ status, body });
  if (input.authMode !== "jwt" || !input.user?.id) {
    return answer(401, { error: "Sign in to read the weekly sample." });
  }
  if (!input.staff) {
    return answer(403, { error: RECORD_ERRORS.weekly_record_not_staff[1] });
  }
  const listing = input.action === "weekly_check_list";
  if (input.method !== (listing ? "GET" : "POST")) {
    return answer(405, { error: listing ? "Use GET." : "Use POST." });
  }
  if (!listing) {
    if (
      !validDate(input.body?.week) ||
      typeof input.body?.job_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        input.body.job_id,
      )
    ) {
      return answer(400, { error: "A week and job id are required." });
    }
    const { data, error } = await client.rpc("job_truth_weekly_record", {
      p_week: input.body.week,
      p_job_id: input.body.job_id,
      p_user: input.user.id,
      p_marks: input.body.marks ?? [],
      p_missing: input.body.missing ?? [],
    });
    if (error) {
      const code = Object.keys(RECORD_ERRORS).find((key) =>
        String(error.message).includes(key)
      );
      if (code) {
        return answer(RECORD_ERRORS[code][0], {
          error: RECORD_ERRORS[code][1],
          code,
        });
      }
      return answer(500, { error: "Could not save. Try again." });
    }
    return answer(200, data);
  }
  const requestedWeek = input.query.get("week");
  if (requestedWeek !== null && !validDate(requestedWeek)) {
    return answer(400, { error: "Use a date for the week." });
  }
  // Weekly sample PK (week, job_id) bounds both week lookup and sample rows.
  // Scores aggregate only this small retained sample, never the business tables.
  const scores = await client.from("job_truth_weekly_scores").select(
    SCORE_COLUMNS,
  )
    .order("week", { ascending: false }).limit(8);
  if (scores.error) return answer(500, { error: "Could not load. Try again." });
  const week = requestedWeek ?? scores.data?.[0]?.week ?? null;
  let jobs: any[] = [];
  let thisWeek = null;
  if (week) {
    const [samples, score] = await Promise.all([
      client.from("job_truth_weekly_samples").select(SAMPLE_COLUMNS).eq(
        "week",
        week,
      )
        .order("job_id").limit(20),
      client.from("job_truth_weekly_scores").select(`${SCORE_COLUMNS},misses`)
        .eq("week", week).maybeSingle(),
    ]);
    if (samples.error || score.error) {
      return answer(500, { error: "Could not load. Try again." });
    }
    // Allowlist the response as well as the query. Never return the retained page.
    jobs = (samples.data || []).map((row: any) => ({
      job_id: row.job_id,
      job_number: row.job?.job_number ?? null,
      as_at: row.as_at,
      story: row.story,
      notes: row.notes,
      story_source: row.story_source,
      notes_source: row.notes_source,
      read: row.read_at != null,
      read_at: row.read_at,
      marks: row.marks,
      missing: row.missing,
    }));
    thisWeek = score.data;
  }
  const shares = await client.rpc("context_ledger_close_shares_now");
  // An optional later migration owns this RPC. Other read errors stay visible.
  if (shares.error && !["PGRST202", "42883"].includes(shares.error.code)) {
    return answer(500, { error: "Could not load. Try again." });
  }
  return answer(200, {
    week,
    jobs,
    scores: scores.data || [],
    this_week: thisWeek,
    close_shares: shares.data ?? null,
  });
}
