// The Jobs board's "has any job changed" stamp (P0-15.1, read only, staff only).
//
// A full board load reads the close-out block for every job (loadCloseoutBlocks,
// job_closeout_read.ts), so an open Jobs tab that reloads every 5 minutes costs
// thousands of close-out reads a day even when nothing moved. This stamp lets the
// screen ask first, in three small reads, and load the board only when it changed:
//
//   stamp = <newest jobs.updated_at for the org>
//         | <newest job_events.created_at>
//         | <newest event or folded base mark for the org>
//
// jobs.updated_at is kept by trg_jobs_updated. Job pages appends marks from its
// 14 source tables to job_change_mark_events. Read that heap through
// pipeline_newest_job_mark, not the job_change_marks aggregate view. The RPC uses
// job_change_mark_events_newest and job_change_marks_base_newest plus jobs_pkey
// to select this org's newest mark, including events the nightly fold removed.
//
// stamp null means "not known: load the board". That is the answer whenever
// any read fails, so a failed stamp can never hide a change.
//
// Nothing is cached on the server and no other table is read.

// deno-lint-ignore no-explicit-any
type Client = any;

export type PipelineStamp = { stamp: string | null };

type NewestRead = { ok: true; value: string } | { ok: false };

async function readNewest(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  column: string,
): Promise<NewestRead> {
  try {
    const { data, error } = await query;
    if (error) return { ok: false };
    const row = Array.isArray(data) ? data[0] : null;
    const value = row && typeof row === "object" ? (row as Record<string, unknown>)[column] : null;
    return { ok: true, value: value == null ? "" : String(value) };
  } catch {
    return { ok: false };
  }
}

export async function readPipelineStamp(client: Client, orgId: string): Promise<PipelineStamp> {
  if (!orgId) return { stamp: null };
  const newestFirst = { ascending: false, nullsFirst: false };
  const [jobs, events, marks] = await Promise.all([
    readNewest(
      client.from("jobs").select("updated_at").eq("org_id", orgId)
        .order("updated_at", newestFirst).limit(1),
      "updated_at",
    ),
    readNewest(
      client.from("job_events").select("created_at")
        .order("created_at", newestFirst).limit(1),
      "created_at",
    ),
    readNewest(
      client.rpc("pipeline_newest_job_mark", { p_org_id: orgId }, { get: true }),
      "last_marked_at",
    ),
  ]);
  if (!jobs.ok || !events.ok || !marks.ok) return { stamp: null };
  return { stamp: [jobs.value, events.value, marks.value].join("|") };
}
