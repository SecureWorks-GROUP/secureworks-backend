import { acceptedRevisionForOrders } from "../expected_costs/accepted_quote_cost_source.ts";

export type ScopeDraftReleaseOutcome =
  | { state: "not_prepared" | "already_released" | "released" }
  /** Acceptance retained; the issue waits for the owner-approved price and
   * work order on the accepted revision (20261109040000). Not a fault. */
  | { state: "held_for_owner_approval"; missing: string[] }
  | { state: "release_unavailable" };

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
  } catch {
    // No request bodies, people, money or provider secrets in the audit.
    console.error(
      "[scope-job-drafts] acceptance retained; work-order release held",
    );
    try {
      await client.from("job_events").insert({
        job_id: jobId,
        event_type: "scope_job_draft_release_held",
        detail_json: { reason: "accepted_source_or_release_unavailable" },
      });
    } catch { /* Acceptance stands even if the diagnostic cannot be saved. */ }
    return { state: "release_unavailable" };
  }
}
