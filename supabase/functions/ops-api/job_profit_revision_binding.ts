// deno-lint-ignore-file no-explicit-any
// Whether the frozen revision a patio job's profit read compares is the one
// the customer accepted (JP-23 slice 2, the reader chain).
//
// Rule R0 to R8 from cfo/receipts/cfo-jp23-r2-reconcile-20261021.md section 2,
// accepted by Sales r3. It reads the chain accepted document -> released
// quote_revisions row -> scope_revision_id and checks it names the frozen row
// compared and the baseline's revision. It never reads by time and never
// infers from a price. `accepted` is true only when every rule holds; anything
// else is null with the first failing basis, never false.
//
// The link column, quote_revisions.scope_revision_id, is slice 1 (JP-24) and
// does not exist yet. Until it does, its read answers 400 (42703) and every
// job reads chain_unreadable, exactly as unknown as before this slice.

import type { RevisionAcceptance } from "./job_profit_patio_expected.ts";

export const JOB_ACCEPTANCE_NOT_TRUE: RevisionAcceptance = {
  accepted: null,
  basis: "job_acceptance_not_true",
};

// The baseline's revision, read as one projected path (never the whole
// expected_costs blob).
export const BASELINE_REVISION_PROJECTION =
  "ec_rev:expected_costs->>scope_revision_id";

// Variations that count as accepted for R6 (variation semantics are open).
const ACCEPTED_VARIATION_STATUSES = new Set(["accepted", "invoiced"]);

export type RevisionChain = {
  /** job_documents ids, type quote, with accepted_at set */
  acceptedDocumentIds: string[];
  /** every run_acceptances row on the job */
  runs: Array<{ status: string | null; job_document_id: string | null }>;
  /** released quote_revisions rows of the accepted documents */
  releases: Array<{
    job_document_id: string | null;
    scope_revision_id: string | null;
  }>;
  /** every job_variations row on the job */
  variations: Array<{ accepted_at: string | null; status: string | null }>;
  /** jobs.expected_costs.scope_revision_id, null when absent */
  baselineRevisionId: string | null;
  /** the frozen scope_revisions row this read compares */
  frozenRevisionId: string | null;
  /** any read above errored */
  unreadable: boolean;
};

const unknown = (basis: string): RevisionAcceptance => ({
  accepted: null,
  basis,
});

/** R1 to R8, first failing rule wins. Assumes R0 (job acceptance) holds. */
export function decideRevisionAcceptance(
  chain: RevisionChain,
): RevisionAcceptance {
  // R8: a failed read is not known, never no.
  if (chain.unreadable) return unknown("chain_unreadable");
  // R1.1: at least one accepted document (retired or superseded included).
  const accepted = new Set(chain.acceptedDocumentIds);
  for (const r of chain.runs) {
    if (r.status === "accepted" && r.job_document_id) {
      accepted.add(r.job_document_id);
    }
  }
  if (accepted.size === 0) return unknown("no_accepted_document");
  // R1.2: every accepted document has at least one released row.
  const released = new Set(chain.releases.map((r) => r.job_document_id));
  for (const id of accepted) {
    if (!released.has(id)) return unknown("accepted_document_not_released");
  }
  // R1.3: an accepted run must name its document.
  if (chain.runs.some((r) => r.status === "accepted" && !r.job_document_id)) {
    return unknown("run_acceptance_without_document");
  }
  // R2: every release row of every accepted document names a revision.
  const rows = chain.releases.filter((r) =>
    r.job_document_id !== null && accepted.has(r.job_document_id)
  );
  if (rows.some((r) => !r.scope_revision_id)) {
    return unknown("release_names_no_revision");
  }
  // R3: one revision only, every release row counted, none picked by time.
  const named = new Set(rows.map((r) => r.scope_revision_id));
  if (named.size !== 1) return unknown("releases_name_different_revisions");
  const revision = [...named][0];
  // R4: it is the frozen row compared.
  if (!chain.frozenRevisionId || revision !== chain.frozenRevisionId) {
    return unknown("release_not_compared_revision");
  }
  // R5: it is the baseline's revision; an absent path does not satisfy it.
  if (chain.baselineRevisionId !== revision) {
    return unknown("baseline_names_other_revision");
  }
  // R6: an accepted variation keeps it unknown until variation semantics
  // are ruled.
  if (
    chain.variations.some((v) =>
      v.accepted_at || ACCEPTED_VARIATION_STATUSES.has(String(v.status))
    )
  ) {
    return unknown("variation_accepted_semantics_open");
  }
  // R7: every party quoted on the job has accepted.
  if (chain.runs.some((r) => r.status !== "accepted")) {
    return unknown("party_not_accepted");
  }
  return { accepted: true, basis: null };
}

/**
 * Reads the chain for one job and decides it. Call only when the job has a
 * frozen row and its job-level acceptance (R0) is already true. Every read
 * checks `error`; a null `data` with no error is no rows.
 */
export async function readRevisionAcceptance(
  client: any,
  jobId: string,
  frozenRevisionId: string | null,
): Promise<RevisionAcceptance> {
  const [docs, runs, variations, baseline] = await Promise.all([
    client.from("job_documents").select("id").eq("job_id", jobId)
      .eq("type", "quote").not("accepted_at", "is", null),
    client.from("run_acceptances").select("status, job_document_id")
      .eq("job_id", jobId),
    client.from("job_variations").select("accepted_at, status")
      .eq("job_id", jobId),
    client.from("jobs").select(BASELINE_REVISION_PROJECTION).eq("id", jobId)
      .limit(1),
  ]);
  let unreadable = Boolean(
    docs.error || runs.error || variations.error || baseline.error,
  );
  const acceptedDocumentIds = docs.error
    ? []
    : (docs.data ?? []).map((d: any) => String(d.id));
  const runRows = runs.error ? [] : (runs.data ?? []);
  const ids = new Set(acceptedDocumentIds);
  for (const r of runRows) {
    if (r.status === "accepted" && r.job_document_id) {
      ids.add(String(r.job_document_id));
    }
  }
  let releases: RevisionChain["releases"] = [];
  if (!unreadable && ids.size > 0) {
    // 42703 here means slice 1's column does not exist yet: not known.
    const rel = await client.from("quote_revisions")
      .select("job_document_id, scope_revision_id")
      .in("job_document_id", [...ids]).not("sent_at", "is", null);
    if (rel.error) unreadable = true;
    else releases = rel.data ?? [];
  }
  const ec = baseline.error ? null : baseline.data?.[0]?.ec_rev;
  return decideRevisionAcceptance({
    acceptedDocumentIds,
    runs: runRows.map((r: any) => ({
      status: r.status ?? null,
      job_document_id: r.job_document_id ?? null,
    })),
    releases: releases.map((r: any) => ({
      job_document_id: r.job_document_id ?? null,
      scope_revision_id: r.scope_revision_id ?? null,
    })),
    variations: (variations.error ? [] : (variations.data ?? [])).map((
      v: any,
    ) => ({ accepted_at: v.accepted_at ?? null, status: v.status ?? null })),
    baselineRevisionId: typeof ec === "string" && ec ? ec : null,
    frozenRevisionId,
    unreadable,
  });
}
