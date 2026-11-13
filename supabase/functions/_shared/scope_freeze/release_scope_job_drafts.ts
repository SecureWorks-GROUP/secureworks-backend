import { acceptedRevisionForOrders } from "../expected_costs/accepted_quote_cost_source.ts";
import { readTakenQuoteOptions } from "../quote_options/taken_options.ts";

export type ScopeDraftReleaseOutcome =
  | { state: "not_prepared" | "already_released" | "released" }
  /** Acceptance retained; the issue waits for the owner-approved price and
   * work order on the accepted revision (20261109040000). Not a fault. */
  | { state: "held_for_owner_approval"; missing: string[] }
  /** Ruling 14 step 1: the job's option record could not be read, so the
   * drafts cannot be shown to carry what the customer took. Held; the
   * acceptance, job price and deposit stand, and the next release retries. */
  | { state: "held_for_quote_options"; reason: "quote_options_unreadable" }
  | { state: "release_unavailable" };

/** TK-S28: a job status write that should release (or retry releasing) the
 * scope draft work order. Every open status past acceptance counts, the rule
 * the job work order already follows (job_work_order_open_statuses); partial
 * acceptance never releases. release_scope_job_drafts applies the same rule
 * (20261110200000), so this only decides when to ask. */
export function releasesScopeDraftOnStatus(
  status: unknown,
  openStatuses: ReadonlySet<string>,
): boolean {
  return typeof status === "string" && status !== "partially_accepted" &&
    openStatuses.has(status);
}

/** No acceptance decision here. Both /accept branches and the office status
 * writer call this only after their existing full-job decision. The RPC checks
 * that persisted status again, locks the job, retains the acceptance and
 * releases and issues only when both owner approvals exist. A fault holds the
 * work order without undoing the customer's acceptance. */
export async function releaseScopeJobDraftsOnAcceptance(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
): Promise<ScopeDraftReleaseOutcome> {
  try {
    const { data: draft, error } = await client.from("scope_job_draft_sets")
      .select("scope_revision_id, released_at").eq("job_id", jobId)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return { state: "not_prepared" };
    if (draft.released_at) return { state: "already_released" };
    // The work order, payer invoices and payment stages were sealed at the
    // base price. Taken options are added to them first (below); an option
    // record that cannot be read holds them, never releases them short.
    const options = await readTakenQuoteOptions(client, jobId);
    if (options.state === "unreadable") {
      try {
        await client.from("job_events").insert({
          job_id: jobId,
          event_type: "scope_job_draft_release_held",
          detail_json: { reason: "quote_options_unreadable" },
        });
      } catch { /* The hold stands even if the diagnostic cannot be saved. */ }
      return { state: "held_for_quote_options", reason: "quote_options_unreadable" };
    }
    const source = await acceptedRevisionForOrders(client, jobId);
    if (source.kind === "unknown") {
      throw new Error("scope_drafts_accepted_source_unproven");
    }
    let revision = source.kind === "bound"
      ? source.revision_id
      : draft.scope_revision_id;
    if (source.kind === "legacy") {
      const job = await client.from("jobs").select("expected_costs").eq(
        "id",
        jobId,
      ).single();
      if (job.error) throw job.error;
      revision = job.data?.expected_costs?.scope_revision_id || revision;
    }
    // Ruling 14 step 1 (contract 4.4): each taken crew option's labour line
    // joins the work order and its total the agreed labour; the payer
    // amounts and payment stages become the accepted combination's. One
    // transaction, checked against the frozen revision; a repeat replays.
    if (options.state === "taken") {
      const applied = await client.rpc("apply_quote_options_to_scope_drafts", {
        p_job_id: jobId,
        p_scope_revision_id: revision,
      });
      if (applied.error) throw applied.error;
    }
    const release = await client.rpc("release_scope_job_drafts", {
      p_job_id: jobId,
      p_scope_revision_id: revision,
      p_legacy: source.kind === "legacy",
    });
    if (release.error) throw release.error;
    if (release.data?.held === true) {
      // The database wrote the held audit with what is missing.
      const missing = Array.isArray(release.data?.missing)
        ? release.data.missing.map(String)
        : [];
      return { state: "held_for_owner_approval", missing };
    }
    return { state: "released" };
  } catch (e) {
    // No request bodies, people, money or provider secrets in the audit: only
    // the database's own refusal code (scope_drafts_* / scope_options_*).
    const code = String((e as { message?: unknown })?.message ?? "");
    const reason = /^scope_(drafts|options)_[a-z_]{1,80}$/.test(code)
      ? code
      : "accepted_source_or_release_unavailable";
    console.error(
      "[scope-job-drafts] acceptance retained; work-order release held",
      reason,
    );
    try {
      await client.from("job_events").insert({
        job_id: jobId,
        event_type: "scope_job_draft_release_held",
        detail_json: { reason },
      });
    } catch { /* Acceptance stands even if the diagnostic cannot be saved. */ }
    return { state: "release_unavailable" };
  }
}
