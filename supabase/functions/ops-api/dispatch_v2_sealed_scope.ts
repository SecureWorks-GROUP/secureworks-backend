// deno-lint-ignore-file no-explicit-any
// T20: Dispatch v2 fills a job's order list from the job's frozen scope
// revision, never from the scope the job holds at the moment.
//
// Which revision is Context's rule for a material take (D1 fix F3, #1238),
// the one the older Materials panel uses (dispatch_materials_store.ts), so
// both Dispatch screens order from the same revision:
//   * the revision recorded at acceptance (jobs.expected_costs.scope_revision_id);
//   * else the one the acceptance chain names;
//   * else, with nothing accepted yet, the job's latest frozen revision.
// An unproven chain, no frozen revision, or a sealed record whose text does
// not match its scope_hash refuses there, in its own plain line
// (accepted_quote_unproven, no_frozen_scope, scope_identity_unverified). The
// lines come from that row's own scope_canonical_text.
//
// One check is added here: whether the job's working scope was changed after
// that revision was frozen (canonicalJsonAndHash of jobs.scope_json against
// the frozen scope). The lines still come from the frozen revision; the fill
// says so in a note. The pricing is never read.
//
// Reads only: jobs (one job) and scope_revisions (through readFrozenScope).

import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import {
  acceptedRevisionForMaterialTake,
  DispatchMaterialsError,
  readFrozenScope,
} from "./dispatch_materials_store.ts";

export type DispatchV2FrozenScope = {
  revision_id: string;
  revision_number: number;
  scope: any;
  /** true: the working scope differs from the frozen one; null: not known. */
  changed_since_frozen: boolean | null;
};

function isPlainObjectWithKeys(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v as object).length > 0;
}

export async function readDispatchV2FrozenScope(
  client: any,
  job: { id: string; org_id: string; job_number: string | null; work_type: string },
): Promise<DispatchV2FrozenScope> {
  // One single-job read: the working scope (for the changed-since check) and
  // the revision recorded at acceptance. Never the pricing.
  const { data: row, error } = await client.from("jobs")
    .select("id, scope_json, accepted_scope_revision_id:expected_costs->>scope_revision_id")
    .eq("id", job.id)
    .eq("org_id", job.org_id)
    .maybeSingle();
  if (error) {
    console.error("[dispatch_v2] scope read failed:", error);
    throw new DispatchMaterialsError(500, "read_failed", "The job's scope could not be read");
  }
  const accepted = typeof row?.accepted_scope_revision_id === "string" &&
      row.accepted_scope_revision_id
    ? row.accepted_scope_revision_id
    : null;
  const revisionId = await acceptedRevisionForMaterialTake(client, {
    ...job,
    accepted_scope_revision_id: accepted,
  });
  const frozen = await readFrozenScope(client, job.id, revisionId);
  if (!isPlainObjectWithKeys(frozen.scope)) {
    throw new DispatchMaterialsError(
      409,
      "scope_unreadable",
      "The job's frozen scope could not be read",
    );
  }
  let changed: boolean | null = null;
  if (isPlainObjectWithKeys(row?.scope_json)) {
    const [live, sealed] = await Promise.all([
      canonicalJsonAndHash(row.scope_json),
      canonicalJsonAndHash(frozen.scope),
    ]);
    changed = live.hash !== sealed.hash;
  }
  return {
    revision_id: frozen.revision_id,
    revision_number: frozen.revision,
    scope: frozen.scope,
    changed_since_frozen: changed,
  };
}

// The materials read's light view (no scope text): the job's latest frozen
// revision, so the screen's own fill waits until there is one. The fill itself
// applies the whole rule above, and may use the accepted revision instead.
export async function readDispatchV2LatestFrozen(
  client: any,
  jobId: string,
): Promise<
  | { state: "frozen"; revision_id: string; revision_number: number }
  | { state: "no_frozen_scope" | "unknown"; revision_id: null; revision_number: null }
> {
  const { data, error } = await client.from("scope_revisions")
    .select("id, revision_number")
    .eq("job_id", jobId)
    .eq("status", "frozen")
    .order("revision_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[dispatch_v2] frozen scope read failed:", error);
    return { state: "unknown", revision_id: null, revision_number: null };
  }
  if (!data || typeof data.id !== "string") {
    return { state: "no_frozen_scope", revision_id: null, revision_number: null };
  }
  return {
    state: "frozen",
    revision_id: data.id,
    revision_number: Number(data.revision_number),
  };
}
