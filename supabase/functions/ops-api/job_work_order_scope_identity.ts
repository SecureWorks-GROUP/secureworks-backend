// INT-23 / R-02: a work order's original Scope line identities, read from
// the exact revision it names. This is the revision's demand manifest, not
// a guessed mapping from material demand to derived labour tasks.
import { sha256HexOfText } from "../_shared/scope_freeze/get_scope_revision_for_viewer.ts";

export type WorkOrderScopeIdentity = {
  job_id: string;
  scope_revision_id: string | null;
  status: "known" | "unknown";
  reason: string;
  scope_hash: string | null;
  revision_status: "frozen" | "superseded" | null;
  scope_line_ids: string[] | null;
  /** Does not claim that each derived labour task maps to one material line. */
  basis: "named_revision_manifest";
};

/** Read only. Never falls back to the job's current scope or newest revision.
 * Unknown provenance must not hide the work order or its existing obligations.
 * The caller has already checked staff access to the job. */
export async function readWorkOrderScopeIdentity(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
  revisionId: string | null,
): Promise<WorkOrderScopeIdentity> {
  const unknown = (reason: string): WorkOrderScopeIdentity => ({
    job_id: jobId,
    scope_revision_id: revisionId,
    status: "unknown",
    reason,
    scope_hash: null,
    revision_status: null,
    scope_line_ids: null,
    basis: "named_revision_manifest",
  });
  if (!revisionId) return unknown("work_order_revision_missing");
  try {
    const { data: row, error } = await client.from("scope_revisions")
      .select("id, job_id, status, frozen_at, scope_canonical_text, scope_hash")
      .eq("id", revisionId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (error) return unknown("scope_revision_unreadable");
    if (!row) return unknown("scope_revision_missing");
    if (row.id !== revisionId || row.job_id !== jobId) {
      return unknown("scope_revision_identity_mismatch");
    }
    if (
      !["frozen", "superseded"].includes(row.status) ||
      typeof row.frozen_at !== "string" || !row.frozen_at
    ) return unknown("scope_revision_not_frozen");
    if (
      typeof row.scope_canonical_text !== "string" ||
      typeof row.scope_hash !== "string" ||
      await sha256HexOfText(row.scope_canonical_text) !== row.scope_hash
    ) return unknown("scope_hash_mismatch");
    let scope: unknown;
    try {
      scope = JSON.parse(row.scope_canonical_text);
    } catch {
      return unknown("scope_unreadable");
    }
    if (
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      !("lines" in scope) || !Array.isArray(scope.lines)
    ) return unknown("scope_lines_missing");
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const line of scope.lines) {
      if (
        !line || typeof line !== "object" || Array.isArray(line) ||
        typeof line.id !== "string" || !line.id.trim()
      ) return unknown("scope_line_id_missing");
      // Keep the exact producer ID. No generated ID, trimming or deduplication
      // may silently turn a malformed manifest into apparently known identity.
      if (line.id !== line.id.trim()) return unknown("scope_line_id_malformed");
      if (seen.has(line.id)) return unknown("scope_line_ids_ambiguous");
      seen.add(line.id);
      ids.push(line.id);
    }
    return {
      job_id: jobId,
      scope_revision_id: revisionId,
      status: "known",
      reason: "verified_scope_manifest",
      scope_hash: row.scope_hash,
      revision_status: row.status,
      scope_line_ids: ids,
      basis: "named_revision_manifest",
    };
  } catch {
    return unknown("scope_revision_unreadable");
  }
}
