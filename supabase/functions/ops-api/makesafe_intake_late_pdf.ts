// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — TWO-EMAIL LATE WORK-ORDER-PDF LANDING (M-A2 / W2-B)
// Mission: makesafe-system wave-2-hardening-2026-07-07 (section W2-B)
// ════════════════════════════════════════════════════════════
//
// THE PROBLEM
// -----------
// MLB (and similar builders) sometimes ANNOUNCE a work order in a first email
// with NO PDF — the intake draft is correctly created but dirty
// (missing_work_order_pdf) — and then send the actual WO PDF in a LATER "PO"
// email. Before this module the scan handled that second email in one of two
// broken ways (see scanSesMakesafes refDup block in index.ts):
//   * work_order_identity_needs_review  -> fell through and MINTED A SECOND
//     needs_review draft (a duplicate card for the same work order), or
//   * external_ref+company              -> was skipped as a duplicate, so the
//     late PDF was STRANDED and the original draft stayed dirty forever.
// Neither ever landed the PDF on the EXISTING draft.
//
// THE FIX (this module — the PURE decision + merge)
// -------------------------------------------------
// selectLatePdfLandingTarget() finds the SINGLE existing dirty draft this late
// PDF belongs to (matched on normalised external_ref + requesting company +
// job family, then disambiguated by builder work-order / PO identity). It FAILS
// CLOSED: if two candidate drafts could match, it returns { kind: "ambiguous" }
// and the caller must route to human review — never guess.
//
// mergeLateWorkOrderPdfIntoDraft() lands the captured PDF on the chosen draft:
// it keeps the existing draft's IDENTITY (ref / company / subject / report_type),
// adds the servable WO PDF, fills ONLY the client fields the announcement left
// null, drops the now-resolved blocking markers (missing_work_order_pdf + the
// dedup-review markers), and recomputes the draft status. The caller then re-runs
// the UNCHANGED strict auto-approve gate on the merged row.
//
// Both functions are PURE (no I/O). The orchestration that fetches the drafts,
// UPDATEs the chosen row in place, and calls approveIntakeDraft lives in index.ts
// (landLateWorkOrderPdfOntoDraft) so it can reuse the scan's helpers and stay
// immune to the (org_id, graph_message_id) unique key (it UPDATEs, never INSERTs).

import {
  normaliseCompany,
  normaliseJobFamily,
  normaliseRef,
  workOrderIdentityKey,
} from "./makesafe_intake_dedup.ts";

/** A live intake-draft row as the landing logic needs to see it. */
export interface LatePdfDraftRow {
  id: string;
  status?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  makesafe_job_family?: string | null;
  builder_work_order_number?: string | null;
  builder_po_number?: string | null;
  // deno-lint-ignore no-explicit-any
  attachments_json?: any;
  // deno-lint-ignore no-explicit-any
  extraction_json?: any;
  // deno-lint-ignore no-explicit-any
  missing_fields?: any;
  client_name?: string | null;
  client_phone?: string | null;
  site_address?: string | null;
  site_suburb?: string | null;
  description?: string | null;
  safety_requirements?: string | null;
  confidence?: string | null;
  report_type?: string | null;
  subject?: string | null;
}

/** The late-PDF candidate (the SECOND email, already extracted WITH its PDF). */
export interface LatePdfCandidate {
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  makesafe_job_family?: string | null;
  builder_work_order_number?: string | null;
  builder_po_number?: string | null;
  graph_message_id?: string | null;
  confidence?: string | null;
  /** The candidate's captured attachments (must include a servable WO PDF). */
  // deno-lint-ignore no-explicit-any
  attachments: any[];
  /** The candidate's extraction (client fields may come from the PDF). */
  // deno-lint-ignore no-explicit-any
  extraction: Record<string, any>;
  /** The candidate's missing_fields (real review markers are carried into the merge). */
  // deno-lint-ignore no-explicit-any
  missingFields?: any[];
}

export type LatePdfSelection =
  | { kind: "target"; target: LatePdfDraftRow }
  | { kind: "ambiguous"; candidates: LatePdfDraftRow[] }
  | { kind: "none" };

// Blocking markers the LANDING itself resolves — stripped from the merged draft.
// missing_work_order_pdf: the whole point of landing the PDF.
// The *_needs_review markers: the scan's refDup block adds these because it cannot
// prove the second email is a duplicate; landing the PDF onto the matched draft IS
// that proof, so they must not linger and block the re-gate.
const LANDING_RESOLVED_MARKERS: ReadonlySet<string> = new Set([
  "work_order_pdf",
  "missing_work_order_pdf",
  "work_order_identity_needs_review",
  "unknown_family_needs_review",
  "job_work_order_identity_needs_review",
  "job_unknown_family_needs_review",
]);

// Client/site fields the merge is allowed to fill from the candidate's extraction
// (identity fields — ref / company / report_type — are NEVER overwritten).
const FILLABLE_FIELDS = [
  "client_name",
  "client_phone",
  "site_address",
  "site_suburb",
  "description",
  "safety_requirements",
] as const;

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function cleanStr(value: unknown): string {
  return String(value ?? "").trim();
}

function normaliseMarker(value: unknown): string {
  return cleanStr(value).toLowerCase().replace(/[\s-]+/g, "_");
}

/** Mirror of index.ts availableIntakeAttachments — a servable (openable) PDF entry. */
// deno-lint-ignore no-explicit-any
function availablePdfs(attachmentsJson: any): any[] {
  const arr = Array.isArray(attachmentsJson) ? attachmentsJson : [];
  return arr.filter((a) =>
    a && !a.pdf_unavailable && (a.pdf_url || a.storage_url)
  );
}

/** A draft is WO-PDF-dirty when it has NO servable PDF — the exact condition that
 * makes the auto-approve gate report `missing_work_order_pdf`. */
// deno-lint-ignore no-explicit-any
export function draftIsWorkOrderPdfDirty(attachmentsJson: any): boolean {
  return availablePdfs(attachmentsJson).length === 0;
}

/** Builder work-order / PO identity for a draft row (extraction-aware fallbacks). */
function rowIdentity(
  row: {
    external_ref?: string | null;
    builder_work_order_number?: string | null;
    builder_po_number?: string | null;
  },
): string {
  return workOrderIdentityKey(
    row.builder_work_order_number || row.external_ref,
    row.builder_po_number,
  );
}

function refCompanyMatch(
  candidate: {
    external_ref?: string | null;
    requesting_company_slug?: string | null;
    requesting_company_name?: string | null;
  },
  draft: LatePdfDraftRow,
): boolean {
  const cRef = normaliseRef(candidate.external_ref);
  const cCompany = normaliseCompany(
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
  );
  if (!cRef || !cCompany) return false; // need BOTH — same safety invariant as refCompanyKey
  return (
    normaliseRef(draft.external_ref) === cRef &&
    normaliseCompany(
        draft.requesting_company_slug,
        draft.requesting_company_name,
      ) === cCompany
  );
}

function familyCompatible(a: string, b: string): boolean {
  // Unknown on either side is compatible; two KNOWN but different families are not
  // the same work order (assessment vs temp-fence under one claim ref).
  return !a || !b || a === b;
}

/**
 * Choose the SINGLE existing dirty draft a late WO PDF belongs to, or fail closed.
 *
 * Eligible = same ref+company, live (draft|needs_review), WO-PDF-dirty, family-
 * compatible. Then, given the candidate's builder WO/PO identity:
 *   - exactly one eligible draft with the SAME identity        -> that draft
 *   - >=2 eligible drafts with the same identity               -> ambiguous
 *   - no identity match, exactly one identity-less announcement
 *     and no different-identity eligible drafts                -> that announcement
 *   - no identity match, all eligible carry a DIFFERENT identity-> none (genuinely new)
 *   - anything else (multiple announcements / mixed)           -> ambiguous
 * When the candidate has NO parseable identity: land only if exactly one eligible
 * draft exists, else ambiguous.
 */
export function selectLatePdfLandingTarget(
  candidate: LatePdfCandidate,
  drafts: LatePdfDraftRow[],
): LatePdfSelection {
  const candFamily = normaliseJobFamily(candidate.makesafe_job_family);
  const eligible = (drafts || []).filter((d) => {
    const s = cleanStr(d.status).toLowerCase();
    if (s !== "draft" && s !== "needs_review") return false;
    if (!refCompanyMatch(candidate, d)) return false;
    if (!draftIsWorkOrderPdfDirty(d.attachments_json)) return false;
    return familyCompatible(
      candFamily,
      normaliseJobFamily(d.makesafe_job_family),
    );
  });
  if (eligible.length === 0) return { kind: "none" };

  const candIdentity = workOrderIdentityKey(
    candidate.builder_work_order_number || candidate.external_ref,
    candidate.builder_po_number,
  );

  if (candIdentity) {
    const identityMatches = eligible.filter((d) =>
      rowIdentity(d) === candIdentity
    );
    if (identityMatches.length === 1) {
      return { kind: "target", target: identityMatches[0] };
    }
    if (identityMatches.length > 1) {
      return { kind: "ambiguous", candidates: identityMatches };
    }
    // No identity match. Split the rest into identity-less announcements vs drafts
    // that carry a DIFFERENT (known) identity.
    const announcements = eligible.filter((d) => !rowIdentity(d));
    const differentIdentity = eligible.filter((d) =>
      rowIdentity(d) && rowIdentity(d) !== candIdentity
    );
    if (announcements.length === 1 && differentIdentity.length === 0) {
      return { kind: "target", target: announcements[0] };
    }
    if (announcements.length === 0 && differentIdentity.length >= 1) {
      // Every eligible draft is a DIFFERENT work order under the same claim ref —
      // this PDF is a genuinely new WO, mint it normally.
      return { kind: "none" };
    }
    return { kind: "ambiguous", candidates: eligible };
  }

  // Candidate carries a PDF but no parseable WO/PO identity: only safe when there
  // is exactly one eligible dirty draft to receive it.
  if (eligible.length === 1) return { kind: "target", target: eligible[0] };
  return { kind: "ambiguous", candidates: eligible };
}

export interface LatePdfMerge {
  // deno-lint-ignore no-explicit-any
  attachments_json: any[];
  // deno-lint-ignore no-explicit-any
  extraction_json: Record<string, any>;
  missing_fields: string[];
  confidence: string;
  client_name: string | null;
  client_phone: string | null;
  site_address: string | null;
  site_suburb: string | null;
  description: string | null;
  safety_requirements: string | null;
  /** Field names filled from the candidate (never previously present on the draft). */
  filled_fields: string[];
  /** availableWoCount of the merged attachments (for computeIntakeDraftStatus). */
  available_wo_count: number;
}

/**
 * Merge the late PDF (+ any client fields the announcement lacked) onto an existing
 * dirty draft. PURE. Keeps the draft's identity; fills only null fillable fields;
 * unions the servable attachments (candidate's WO PDF wins); strips the landing-
 * resolved markers while carrying any GENUINE candidate review markers (e.g.
 * reply_forward_risk) so a risky PO email still can't auto-approve.
 */
export function mergeLateWorkOrderPdfIntoDraft(
  draft: LatePdfDraftRow,
  candidate: LatePdfCandidate,
): LatePdfMerge {
  const draftExtraction: Record<string, unknown> =
    (draft.extraction_json && typeof draft.extraction_json === "object")
      ? { ...draft.extraction_json }
      : {};
  const candExtraction = candidate.extraction || {};
  const draftFamily = normaliseJobFamily(
    draft.makesafe_job_family ||
      cleanStr(draftExtraction["makesafe_job_family"]),
  );
  const candidateFamily = normaliseJobFamily(
    candidate.makesafe_job_family ||
      cleanStr(candExtraction["makesafe_job_family"]),
  );
  const familyNeedsReview = !draftFamily || !candidateFamily ||
    draftFamily !== candidateFamily;

  // Fill only the client/site fields the draft left empty (identity stays put).
  const filled: string[] = [];
  const outFields: Record<string, string | null> = {};
  for (const f of FILLABLE_FIELDS) {
    const existing = cleanStr(
      (draft as unknown as Record<string, unknown>)[f] ?? draftExtraction[f],
    );
    if (existing) {
      outFields[f] = existing;
      continue;
    }
    const fromCandidate = cleanStr(candExtraction[f]);
    if (fromCandidate) {
      outFields[f] = fromCandidate;
      draftExtraction[f] = fromCandidate;
      filled.push(f);
    } else {
      outFields[f] = null;
    }
  }

  // Carry the builder WO/PO identity + family onto the draft so a later re-scan of
  // the same PO email dedups on identity (never re-lands, never re-mints).
  for (
    const k of [
      "builder_work_order_number",
      "builder_po_number",
      "builder_claim_ref",
    ]
  ) {
    if (!cleanStr(draftExtraction[k]) && cleanStr(candExtraction[k])) {
      draftExtraction[k] = candExtraction[k];
    }
  }
  if (
    !familyNeedsReview &&
    !cleanStr(draftExtraction["makesafe_job_family"]) &&
    cleanStr(candExtraction["makesafe_job_family"])
  ) {
    draftExtraction["makesafe_job_family"] =
      candExtraction["makesafe_job_family"];
    if (cleanStr(candExtraction["makesafe_job_family_label"])) {
      draftExtraction["makesafe_job_family_label"] =
        candExtraction["makesafe_job_family_label"];
    }
  }
  // Portal links only appearing in the PO email/PDF should reach the draft too.
  if (
    !Array.isArray(draftExtraction["portal_links"]) &&
    Array.isArray(candExtraction["portal_links"])
  ) {
    draftExtraction["portal_links"] = candExtraction["portal_links"];
    if (
      !cleanStr(draftExtraction["portal_link"]) &&
      cleanStr(candExtraction["portal_link"])
    ) {
      draftExtraction["portal_link"] = candExtraction["portal_link"];
    }
  }

  // Landing provenance (auditable; never overwrites existing extraction identity).
  draftExtraction["late_pdf_landed"] = true;
  draftExtraction["late_pdf_source_graph_message_id"] =
    candidate.graph_message_id || null;
  draftExtraction["late_pdf_landed_at"] = new Date().toISOString();

  // Attachments: existing servable + candidate servable, deduped by storage/url/name.
  const merged: unknown[] = [];
  const seen = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const pushAtt = (a: any) => {
    const key = cleanStr(a?.storage_url) || cleanStr(a?.pdf_url) ||
      cleanStr(a?.file_name || a?.name);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    merged.push(a);
  };
  for (const a of availablePdfs(draft.attachments_json)) pushAtt(a);
  for (const a of availablePdfs(candidate.attachments)) pushAtt(a);
  const availableWoCount = merged.length;

  // Missing fields: union of the draft's + the candidate's REAL markers, minus the
  // landing-resolved markers and any field the merge just filled.
  const filledSet = new Set<string>(filled.map(normaliseMarker));
  const outMissing: string[] = [];
  const seenMarker = new Set<string>();
  const draftMarkers = Array.isArray(draft.missing_fields)
    ? draft.missing_fields
    : [];
  const candMarkers = Array.isArray(candidate.missingFields)
    ? candidate.missingFields
    : [];
  for (const raw of [...draftMarkers, ...candMarkers]) {
    const m = normaliseMarker(raw);
    if (!m) continue;
    if (LANDING_RESOLVED_MARKERS.has(m)) continue;
    if (filledSet.has(m)) continue;
    if (seenMarker.has(m)) continue;
    seenMarker.add(m);
    outMissing.push(m);
  }
  if (
    familyNeedsReview &&
    !seenMarker.has("work_order_family_needs_review")
  ) {
    outMissing.push("work_order_family_needs_review");
  }

  // Confidence: the higher of the two (the PDF-bearing candidate is usually higher,
  // and reaching 'high' is required for the auto-approve gate).
  const dc = cleanStr(draft.confidence).toLowerCase();
  const cc = cleanStr(candidate.confidence).toLowerCase();
  const confidence = (CONFIDENCE_RANK[cc] ?? -1) > (CONFIDENCE_RANK[dc] ?? -1)
    ? (cc || dc || "low")
    : (dc || cc || "low");

  return {
    attachments_json: merged,
    extraction_json: draftExtraction,
    missing_fields: outMissing,
    confidence,
    client_name: outFields.client_name,
    client_phone: outFields.client_phone,
    site_address: outFields.site_address,
    site_suburb: outFields.site_suburb,
    description: outFields.description,
    safety_requirements: outFields.safety_requirements,
    filled_fields: filled,
    available_wo_count: availableWoCount,
  };
}
