// deno-lint-ignore-file no-explicit-any
// The crew scope of works a Trade App crew sees on a Scope Engine patio job
// (director, 12 Nov 2026: "the backend's trade view returns the sealed crew
// scope of works of the ACCEPTED, released revision (the one the accepted
// quote document is bound to), never the latest saved scope, with no money
// field; ... where the accepted binding cannot be proved it says why and
// shows nothing").
//
// The page is the one the Scope Engine kept when it sealed the revision:
// scope_json.sealed.seal.documents['installer-sow'], checked against its
// stamp (seal.stamps, kind 'installer-sow', contentHash = sha256 of the page
// as a JSON string; scope-engine-v2 shared/hash.ts canonicalHash of a string,
// shared/identity/frozen.ts stampOutput). It is the page the office sees as
// "Crew scope of works". It carries no prices by design.
//
// Which revision: the accepted quote document's released quote_revisions row
// names one scope_revisions row (readAcceptedQuoteCostSource, kind 'bound').
// The page is read from THAT row's own frozen text, verified against its
// scope_hash, never from jobs.scope_json: a newer revision saved after the
// acceptance never reaches the crew. Anything short of a proved binding
// returns no page and the reason.
//
// Nothing else from the seal leaves this module: no frozen record, no price,
// no payment stages, no other document. Reads only: the acceptance chain and
// one scope_revisions row. Only for jobs whose working scope is a Scope
// Engine patio record (tool 'patio-scoper'); every other job gets null and
// no extra read, so older-tool jobs are unchanged.

import { readAcceptedQuoteCostSource } from "../_shared/expected_costs/accepted_quote_cost_source.ts";

export const CREW_SCOPE_KIND = "installer-sow";

// The response shape (trade_job_detail.crew_scope_of_works), matched to the
// Trade App reader (secureworks-ux PR 682, modules/sealed-crew-scope.js):
// page, content_hash and revision only when status is 'accepted'; reason
// (plain words) and reason_code only when 'not_proved'. No money field.
export type TradeCrewScopeOfWorks = {
  status: "accepted" | "not_proved";
  /** The accepted revision's kept crew page, byte for byte. */
  page: string | null;
  /** The seal's stamp: sha256 hex of JSON.stringify(page). */
  content_hash: string | null;
  /** n: the Scope Engine's revision number; frozen_revision_id: the seal's. */
  revision: { n: number | null; frozen_revision_id: string } | null;
  /** One plain line saying why nothing is shown. */
  reason: string | null;
  /** The same reason as a short code, for logs and support. */
  reason_code: string | null;
};

const REASON_TEXT: Record<string, string> = {
  no_accepted_document: "No quote has been accepted on this job yet.",
  accepted_quote_not_bound_to_revision:
    "The accepted quote is not linked to a sealed scope revision.",
  acceptance_chain_unreadable: "The accepted quote could not be read.",
  accepted_document_not_released:
    "The accepted quote has no sent revision on record.",
  release_names_no_revision:
    "The accepted quote is not linked to a sealed scope revision.",
  releases_name_different_revisions:
    "The accepted quotes name different scope revisions.",
  run_acceptance_without_document:
    "An acceptance on this job names no quote document.",
  variation_accepted_semantics_open:
    "A variation was accepted, so the accepted scope is not settled.",
  party_not_accepted: "Not every party on this job has accepted yet.",
  accepted_revision_unreadable:
    "The accepted scope revision could not be read.",
  accepted_revision_missing: "The accepted scope revision is not on record.",
  accepted_revision_unverified:
    "The accepted scope revision does not match its saved fingerprint.",
  accepted_revision_not_scope_engine:
    "The accepted scope revision was not made in the Scope Engine.",
  accepted_revision_has_no_seal: "The accepted scope revision kept no seal.",
  accepted_revision_has_no_crew_page:
    "The accepted scope revision kept no crew scope of works.",
  crew_page_has_no_stamp:
    "The crew scope of works has no seal stamp, so it cannot be checked.",
  crew_page_does_not_match_stamp:
    "The crew scope of works is not the page that was sealed.",
  crew_page_shows_dollar_amount:
    "The crew scope of works shows a dollar amount, so it is not shown.",
};

function obj(v: unknown): Record<string, any> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, any>
    : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

function notShown(reason: string): TradeCrewScopeOfWorks {
  return {
    status: "not_proved",
    page: null,
    content_hash: null,
    revision: null,
    reason: REASON_TEXT[reason] ??
      "Which revision the customer accepted could not be confirmed.",
    reason_code: reason,
  };
}

function parseScope(scopeJson: unknown): Record<string, any> | null {
  if (typeof scopeJson === "string") {
    try {
      return obj(JSON.parse(scopeJson));
    } catch {
      return null;
    }
  }
  return obj(scopeJson);
}

/** Whether a job's working scope is a Scope Engine patio record. */
export function isScopeEnginePatioScope(scopeJson: unknown): boolean {
  return parseScope(scopeJson)?.tool === "patio-scoper";
}

/**
 * The sealed crew page inside one frozen scope (already verified as the
 * accepted revision's own text). Pure apart from hashing.
 */
export async function crewPageFromFrozenScope(
  scope: Record<string, any>,
): Promise<TradeCrewScopeOfWorks> {
  if (scope.tool !== "patio-scoper") {
    return notShown("accepted_revision_not_scope_engine");
  }
  const rev = obj(scope.revision) ?? {};
  const seal = obj(obj(scope.sealed)?.seal);
  const frozenId = str(obj(seal?.frozen)?.id);
  // The seal must be this revision's own (the Trade App reads the same rule).
  if (
    !seal || !frozenId || (str(rev.frozenId) && str(rev.frozenId) !== frozenId)
  ) {
    return notShown("accepted_revision_has_no_seal");
  }
  const docs = obj(seal.documents);
  const page = docs && typeof docs[CREW_SCOPE_KIND] === "string" &&
      docs[CREW_SCOPE_KIND].length > 0
    ? docs[CREW_SCOPE_KIND] as string
    : null;
  if (!page) return notShown("accepted_revision_has_no_crew_page");
  const stamps = (Array.isArray(seal.stamps) ? seal.stamps : []).filter((
    s: any,
  ) =>
    obj(s) && s.kind === CREW_SCOPE_KIND && str(s.frozenRevisionId) === frozenId
  );
  const contentHash = stamps.length === 1 ? str(stamps[0].contentHash) : "";
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    return notShown("crew_page_has_no_stamp");
  }
  if (await sha256Hex(JSON.stringify(page)) !== contentHash) {
    return notShown("crew_page_does_not_match_stamp");
  }
  // The page carries no prices by design. A dollar amount means it is not
  // the crew page it claims to be: show nothing rather than strip it (a
  // stripped page no longer matches its stamp).
  if (/\$\s?\d/.test(page)) {
    return notShown("crew_page_shows_dollar_amount");
  }
  return {
    status: "accepted",
    page,
    content_hash: contentHash,
    revision: {
      n: typeof rev.n === "number" && Number.isFinite(rev.n) ? rev.n : null,
      frozen_revision_id: frozenId,
    },
    reason: null,
    reason_code: null,
  };
}

/**
 * The crew scope of works for one job, or null when the job's working scope
 * is not a Scope Engine patio record (older tools: unchanged, no read).
 * Never throws: a failed read is a reason, never a page.
 */
export async function readTradeCrewScopeOfWorks(
  client: any,
  jobId: string,
  workingScopeJson: unknown,
): Promise<TradeCrewScopeOfWorks | null> {
  if (!isScopeEnginePatioScope(workingScopeJson)) return null;
  try {
    const source = await readAcceptedQuoteCostSource(client, jobId);
    if (source.kind === "legacy") {
      return notShown("accepted_quote_not_bound_to_revision");
    }
    if (source.kind === "unknown") return notShown(source.reason);
    const { data: row, error } = await client.from("scope_revisions")
      .select("id, job_id, status, scope_canonical_text, scope_hash")
      .eq("job_id", jobId)
      .eq("id", source.revision_id)
      .in("status", ["frozen", "superseded"])
      .maybeSingle();
    if (error) return notShown("accepted_revision_unreadable");
    if (!row) return notShown("accepted_revision_missing");
    if (
      row.job_id !== jobId || row.id !== source.revision_id ||
      typeof row.scope_canonical_text !== "string" ||
      typeof row.scope_hash !== "string" ||
      await sha256Hex(row.scope_canonical_text) !== row.scope_hash
    ) {
      return notShown("accepted_revision_unverified");
    }
    const scope = parseScope(row.scope_canonical_text);
    if (!scope) return notShown("accepted_revision_unverified");
    return await crewPageFromFrozenScope(scope);
  } catch (e) {
    console.error(
      "[ops-api] trade crew scope of works read failed:",
      (e as Error)?.message,
    );
    return notShown("acceptance_chain_unreadable");
  }
}

/**
 * What an allocated crew's copy of scope_json keeps of the seal: nothing.
 * The sealed page reaches the crew only through crew_scope_of_works, so the
 * rest of the seal (frozen record, payments, other documents) never does.
 */
export function withoutSealForTrade(scopeJson: any): any {
  if (!scopeJson || typeof scopeJson !== "object" || Array.isArray(scopeJson)) {
    return scopeJson;
  }
  if (scopeJson.tool !== "patio-scoper" || !("sealed" in scopeJson)) {
    return scopeJson;
  }
  const { sealed: _sealed, ...rest } = scopeJson;
  return rest;
}
