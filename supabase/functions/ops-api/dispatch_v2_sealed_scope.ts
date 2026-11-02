// deno-lint-ignore-file no-explicit-any
// T20: Dispatch fills a job's order list from the job's sealed scope revision,
// never from whatever scope the job holds at the moment.
//
// The identity rule is Context's (JP-24 slice 1, #1207,
// _shared/scope_freeze/quote_scope_revision_link.ts), applied to the job as
// Dispatch reads it:
//   * read the job's frozen scope_revisions rows (at most two);
//   * there must be exactly one;
//   * its scope_hash and pricing_hash must BOTH equal the canonicalJsonAndHash
//     hashes of the job's own jobs.scope_json and jobs.pricing_json, the
//     function freeze_scope hashes them with;
//   * the lines are then read from that row's own scope_canonical_text, never
//     from jobs.scope_json.
// Anything else fills nothing and says why in a plain line:
//   no_sealed_revision          no frozen row
//   several_sealed_revisions    two or more frozen rows
//   scope_changed_since_sealed  a hash differs (saved again, not frozen again)
//   sealed_revision_unreadable  the row or its text cannot be read as frozen
// No nearest revision, no timestamp fallback, no reading the current scope.
//
// Reads only: jobs (one job, scope_json and pricing_json) and scope_revisions.

import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";

export type DispatchV2SealRefusalCode =
  | "no_sealed_revision"
  | "several_sealed_revisions"
  | "scope_changed_since_sealed"
  | "sealed_revision_unreadable";

export const DISPATCH_V2_SEAL_REFUSAL_CODES: readonly DispatchV2SealRefusalCode[] = [
  "no_sealed_revision",
  "several_sealed_revisions",
  "scope_changed_since_sealed",
  "sealed_revision_unreadable",
];

const MESSAGES: Record<DispatchV2SealRefusalCode, string> = {
  no_sealed_revision:
    "This job has no sealed scope yet. Save and freeze the scope in the scoping tool, then fill the list.",
  several_sealed_revisions:
    "This job has more than one sealed scope, so Dispatch cannot tell which one to order from. Freeze the scope again in the scoping tool, then fill the list.",
  scope_changed_since_sealed:
    "The job's scope was changed after it was sealed. Freeze it again in the scoping tool, then fill the list.",
  sealed_revision_unreadable:
    "The job's sealed scope could not be read, so nothing was filled in. Freeze the scope again in the scoping tool.",
};

export type DispatchV2SealCheck =
  | {
    kind: "sealed";
    revision_id: string;
    revision_number: number;
    /** The sealed scope, parsed from the row's own text (withScope only). */
    scope: unknown;
  }
  | { kind: "refused"; code: DispatchV2SealRefusalCode; message: string; revision_id: string | null }
  | { kind: "read_failed"; label: string; error: unknown };

const HEX64 = /^[0-9a-f]{64}$/;

function refused(code: DispatchV2SealRefusalCode, revisionId: string | null = null): DispatchV2SealCheck {
  return { kind: "refused", code, message: MESSAGES[code], revision_id: revisionId };
}

// freeze_scope's own precondition: a non-empty plain object.
function isPlainObjectWithKeys(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v as object).length > 0;
}

// The job's one sealed scope revision, by the rule above. withScope also reads
// and parses the row's scope text (the fill); without it only ids and hashes
// are read (the materials panel). Never throws for a refusal; a failed read is
// returned as read_failed, never as "no revision".
export async function checkDispatchV2SealedScope(
  client: any,
  job: { id: string; org_id: string },
  opts: { withScope: boolean },
): Promise<DispatchV2SealCheck> {
  const columns = opts.withScope
    ? "id, job_id, status, revision_number, scope_hash, pricing_hash, scope_canonical_text"
    : "id, job_id, status, revision_number, scope_hash, pricing_hash";
  // limit(2): one row is the answer, a second is enough to know the job is
  // ambiguous. Ordered so the answer is stable.
  const { data: revs, error: revError } = await client.from("scope_revisions")
    .select(columns)
    .eq("job_id", job.id)
    .eq("status", "frozen")
    .order("revision_number", { ascending: false })
    .limit(2);
  if (revError) return { kind: "read_failed", label: "sealed scope read", error: revError };
  if (!Array.isArray(revs)) {
    return { kind: "read_failed", label: "sealed scope read", error: "not a list" };
  }
  if (revs.length === 0) return refused("no_sealed_revision");
  if (revs.length > 1) return refused("several_sealed_revisions");
  const rev = revs[0] ?? {};
  const revId = typeof rev.id === "string" && rev.id ? rev.id : null;
  if (
    !revId || rev.job_id !== job.id || rev.status !== "frozen" ||
    !Number.isInteger(rev.revision_number) ||
    typeof rev.scope_hash !== "string" || !HEX64.test(rev.scope_hash) ||
    typeof rev.pricing_hash !== "string" || !HEX64.test(rev.pricing_hash) ||
    (opts.withScope && typeof rev.scope_canonical_text !== "string")
  ) {
    return refused("sealed_revision_unreadable", revId);
  }

  // The job's own blobs, as freeze_scope reads and hashes them.
  const { data: row, error: jobError } = await client.from("jobs")
    .select("id, scope_json, pricing_json")
    .eq("id", job.id)
    .eq("org_id", job.org_id)
    .maybeSingle();
  if (jobError) return { kind: "read_failed", label: "scope read", error: jobError };
  if (!row) return { kind: "read_failed", label: "scope read", error: "job not found" };
  if (!isPlainObjectWithKeys(row.scope_json) || !isPlainObjectWithKeys(row.pricing_json)) {
    return refused("scope_changed_since_sealed", revId);
  }
  const [{ hash: scopeHash }, { hash: pricingHash }] = await Promise.all([
    canonicalJsonAndHash(row.scope_json),
    canonicalJsonAndHash(row.pricing_json),
  ]);
  if (scopeHash !== rev.scope_hash || pricingHash !== rev.pricing_hash) {
    return refused("scope_changed_since_sealed", revId);
  }

  let scope: unknown = null;
  if (opts.withScope) {
    try {
      scope = JSON.parse(rev.scope_canonical_text);
    } catch {
      return refused("sealed_revision_unreadable", revId);
    }
    // The text is the row's own: it must hash to the row's scope_hash.
    if ((await canonicalJsonAndHash(scope)).hash !== rev.scope_hash) {
      return refused("sealed_revision_unreadable", revId);
    }
  }
  return {
    kind: "sealed",
    revision_id: revId,
    revision_number: rev.revision_number,
    scope,
  };
}
