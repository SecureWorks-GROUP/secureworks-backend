// Council mark audit (Kevin Beaver patio follow-up, 12 Nov 2026): every change of
// jobs.council_required through update_job_field records who changed it, from
// what, to what and when, as one job_events row `council_required_set`.

/** The words for a council mark: true, false, or blank (never answered). */
export function councilMarkLabel(value: unknown): string {
  if (value === true) return "needs council";
  if (value === false) return "no council";
  return "not answered";
}

export interface CouncilMarkChange {
  jobId: string;
  value: unknown;
  operatorId: string | null;
  actor: string | null;
  source: string;
}

/** Reads the old mark, writes the new one, and records the change. Returns
 * the stored value. A job_events failure is logged and never undoes the write. */
export async function setCouncilRequired(
  // deno-lint-ignore no-explicit-any
  client: any,
  change: CouncilMarkChange,
): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; error: string }
> {
  const { data: before, error: readErr } = await client.from("jobs")
    .select("council_required").eq("id", change.jobId).maybeSingle();
  if (readErr) return { ok: false, status: 500, error: readErr.message };
  if (!before) return { ok: false, status: 404, error: "job not found" };
  const { data: after, error: writeErr } = await client.from("jobs")
    .update({
      council_required: change.value,
      updated_at: new Date().toISOString(),
    })
    .eq("id", change.jobId).select("council_required").maybeSingle();
  if (writeErr) return { ok: false, status: 500, error: writeErr.message };
  const from = before.council_required ?? null;
  const to = after ? (after.council_required ?? null) : (change.value ?? null);
  const { error: eventErr } = await client.from("job_events").insert({
    job_id: change.jobId,
    user_id: change.operatorId,
    event_type: "council_required_set",
    detail_json: {
      from,
      to,
      from_label: councilMarkLabel(from),
      to_label: councilMarkLabel(to),
      operator_id: change.operatorId,
      actor: change.actor,
      source: change.source,
    },
  });
  if (eventErr) {
    console.error(
      "[council_required_set] event write failed:",
      eventErr.message,
    );
  }
  return { ok: true, value: to };
}
