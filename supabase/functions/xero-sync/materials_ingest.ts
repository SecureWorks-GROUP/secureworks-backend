// ════════════════════════════════════════════════════════════
// MATERIALS ACTUALS — BILL INGESTION (U3, mission profit-materials-actuals)
//
// THE LINCHPIN. Every supplier dollar lands on a job — or on a visible queue.
//
// This module is PURE and DETERMINISTIC. It performs NO I/O so it can be
// gold-set replayed: give it a bill + the facts the caller already resolved
// (mirror-membership, ref→job, the supplier's open POs) and it returns exactly
// one decision — a landed FACT, a QUEUE suggestion, or a SKIP. The edge function
// (index.ts) does the DB reads/writes; this file owns the money-path logic and
// is the thing CP2's precision gate replays.
//
// PRECISION CONTRACT (CP2): one wrong auto-assignment fails the gate. So a FACT
// is only ever produced on a deterministic-unique signal; every ambiguity biases
// to the QUEUE. See matchBill().
//
// CP1 rulings baked in (Marnin 2026-07-05):
//   - Option A: facts are DERIVED Supabase rows keyed by xero_invoice_id,
//     reversible by delete; xero_invoices / trade_invoices are NEVER mutated.
//   - Matching bundle: deterministic-unique only; tolerance ±2% or ±$5
//     (whichever greater); date window 45d; exact supplier by xero_contact_id.
//   - Regex unification: one canonical extractJobNumber() used by BOTH the
//     xero-sync reference linker and the reconcile pass (SWMS + division letters).
//   - Hard exclusion: a bill whose xero_invoice_id is a trade-invoice mirror
//     (trade_invoices.xero_bill_id) can NEVER produce a materials fact.
// ════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// Canonical job-number extractor — THE unification fix.
//
// Matches division jobs  SW<letter>-#####   (SWF/SWP/SWD/SWB … live data)
// and make-safe jobs     SWMS-#####
// Requires the hyphen (rejects hyphenless SWF25010 and bare legacy SW1615, which
// the caller routes through xero_projects separately) and 4–5 digits, with a
// (?!\d) guard so a 6+-digit token (e.g. SWF-250100) does NOT silently truncate
// to a valid 5-digit job number. Bare "SW-25010" (no division letter) is REJECTED
// as ambiguous per U1 §3. Case-insensitive; result normalised upper-case.
//
// This replaces the two divergent regexes:
//   - xero-sync :486  /SWMS-\d{4,5}|SW[A-Z]?-?\d{3,5}/i  (loose — already caught
//     SWMS + division; kept for the legacy SW#### xero_projects path)
//   - reconcile :743  /SW[PFDRIM]-\d{5}/i  (strict — MISSED SWMS, SWB, 4-digit)
// so both passes now agree on what a job reference is.
// ─────────────────────────────────────────────────────────────
// 2026-09-10: job numbers are now six digits (SWP-261376, SWMS-261156).
// A whole token only: never inside a longer word, number or product code
// ("SWF-261009XL" is no job number).
export const JOB_NUMBER_RE = /(?<![A-Z0-9])SW(?:MS|[A-Z])-\d{4,6}(?![A-Z0-9])/i;

export function extractJobNumber(
  ref: string | null | undefined,
): string | null {
  if (!ref) return null;
  const m = String(ref).match(JOB_NUMBER_RE);
  return m ? m[0].toUpperCase() : null;
}

// ─────────────────────────────────────────────────────────────
// Config (CP1-approved, tunable).
// ─────────────────────────────────────────────────────────────
export interface MatchConfig {
  tolerancePct: number; // 0.02  → ±2%
  toleranceAbs: number; // 5     → ±$5 (whichever greater wins)
  windowDaysBefore: number; // small grace for date-entry skew
  windowDaysAfter: number; // bill must arrive within N days of the PO
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  tolerancePct: 0.02,
  toleranceAbs: 5,
  windowDaysBefore: 2,
  windowDaysAfter: 45,
};

// Open PO = not yet consumed by a bill. Anything billed/cancelled/void/deleted,
// or already carrying an xero_bill_id, is NOT an open candidate.
export const CLOSED_PO_STATUSES = new Set([
  "billed",
  "cancelled",
  "canceled",
  "voided",
  "deleted",
]);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface BillInput {
  xero_invoice_id: string;
  invoice_number: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  reference: string | null;
  sub_total: number | null; // ex-GST — the money fact
  total: number | null; // inc-GST — convenience
  invoice_date: string | null; // 'YYYY-MM-DD'
  status: string | null;
  invoice_type: string | null; // must be 'ACCPAY'
}

export interface POCandidate {
  id: string;
  po_number: string | null;
  xero_contact_id: string | null;
  status: string | null;
  subtotal: number | null; // ex-GST — compared to bill.sub_total
  total: number | null;
  job_id: string | null;
  job_number: string | null;
  po_date: string | null; // caller supplies the anchor date (created_at or delivery_date)
  xero_bill_id: string | null;
}

export interface JobRef {
  id: string;
  job_number: string;
}

export type MatchOutcome =
  | "skip_mirror"
  | "skip_non_accpay"
  | "fact"
  | "queue";

export type Confidence = "high" | "medium" | "high_manual";
export type AutomationSource =
  | "xero_ref_link"
  | "po_deterministic"
  | "manual_queue";
export type SuggestionReason =
  | "no_ref_no_po"
  | "ref_no_job"
  | "no_po_match"
  | "ambiguous_po_competitor"
  // An automatic fact was removed because the bill now contradicts it: held for
  // a person. Neither the reference path nor the agent places this bill again.
  | "fact_contradicted"
  // Xero links the bill to a job that the bill's own job number does not name.
  | "xero_link_conflict"
  // The same supplier document is entered more than once in Xero (CFO-16).
  | "duplicate_document"
  // An installer bill (subcontractor labour, account 306 or 301): a person
  // confirms each placement (JP-12), so no automatic path places it.
  | "installer_confirm";

/** Is a bill amount a known number (not null, blank or NaN)? */
export function amountIsKnown(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

/** Queue reasons that hold a bill for a person: no automatic placement while open. */
export const HELD_QUEUE_REASONS = new Set<string>([
  "fact_contradicted",
  "xero_link_conflict",
  "duplicate_document",
  "installer_confirm",
  // A person undid the AI bill reader's placement (20261028173000): no
  // automatic path places that bill again; a person does.
  "ai_undone",
]);

// Installer bills: any money line on subcontractor labour (306, 301). The same
// rule as ops-api laneOfBillLines.
export const INSTALLER_ACCOUNT_CODES = new Set(["306", "301"]);
export function isInstallerBill(lines: unknown): boolean {
  if (!Array.isArray(lines)) return false;
  return lines.some((l: any) =>
    Number(l?.LineAmount ?? 0) !== 0 && INSTALLER_ACCOUNT_CODES.has(String(l?.AccountCode ?? ""))
  );
}

export interface MatchResult {
  outcome: MatchOutcome;
  // fact fields
  jobId?: string;
  jobNumber?: string | null;
  confidence?: Confidence;
  automationSource?: AutomationSource;
  matchedPoId?: string | null;
  matchReason?: string;
  // queue fields
  suggestedJobId?: string | null;
  suggestedJobNumber?: string | null;
  suggestionConfidence?: "low" | "medium";
  suggestionReason?: SuggestionReason;
}

// ─────────────────────────────────────────────────────────────
// Deterministic predicates (pure)
// ─────────────────────────────────────────────────────────────
export function amountWithinTolerance(
  billAmt: number | null | undefined,
  poAmt: number | null | undefined,
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): boolean {
  if (billAmt == null || poAmt == null) return false;
  if (Number.isNaN(billAmt) || Number.isNaN(poAmt)) return false;
  const tol = Math.max(cfg.toleranceAbs, Math.abs(poAmt) * cfg.tolerancePct);
  return Math.abs(billAmt - poAmt) <= tol + 1e-9;
}

export function dateWithinWindow(
  billDate: string | null | undefined,
  poDate: string | null | undefined,
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): boolean {
  if (!billDate || !poDate) return false;
  const b = Date.parse(billDate.slice(0, 10) + "T00:00:00Z");
  const p = Date.parse(poDate.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(b) || Number.isNaN(p)) return false;
  const dayMs = 86_400_000;
  const lo = p - cfg.windowDaysBefore * dayMs;
  const hi = p + cfg.windowDaysAfter * dayMs;
  return b >= lo && b <= hi;
}

export function isOpenPO(po: POCandidate): boolean {
  const s = (po.status || "").toLowerCase();
  return !CLOSED_PO_STATUSES.has(s) && !po.xero_bill_id;
}

// Returns the single deterministic-unique open PO for this bill's supplier, or a
// competitor count when 2+ match, or null when none match. NEVER guesses.
export function findUniquePOMatch(
  bill: BillInput,
  pos: POCandidate[],
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): { po: POCandidate } | { competitors: number } | null {
  if (!bill.xero_contact_id) return null; // no supplier identity → no PO match
  const supplierOpen = pos.filter(
    (po) =>
      po.xero_contact_id &&
      po.xero_contact_id === bill.xero_contact_id &&
      isOpenPO(po) &&
      po.job_id, // a PO with no job can't attribute a cost
  );
  const matches = supplierOpen.filter(
    (po) =>
      amountWithinTolerance(bill.sub_total, po.subtotal, cfg) &&
      dateWithinWindow(bill.invoice_date, po.po_date, cfg),
  );
  if (matches.length === 1) return { po: matches[0] };
  if (matches.length > 1) return { competitors: matches.length };
  return null;
}

// Does this supplier have ANY open, job-bearing PO? (distinguishes
// "no_po_match" from "no_ref_no_po" in the queue reason.)
function supplierHasOpenPO(bill: BillInput, pos: POCandidate[]): boolean {
  return pos.some(
    (po) =>
      po.xero_contact_id &&
      po.xero_contact_id === bill.xero_contact_id &&
      isOpenPO(po) &&
      po.job_id,
  );
}

// ─────────────────────────────────────────────────────────────
// THE decision function — pure, gold-set replayable.
//
// Order: mirror-exclude → non-ACCPAY guard → (1) reference→job (high) →
//        (2) deterministic-unique open PO (medium) → (3) queue suggestion.
// ─────────────────────────────────────────────────────────────
export function matchBill(
  bill: BillInput,
  ctx: {
    isMirror: boolean;
    jobFromRef: JobRef | null; // caller resolves extractJobNumber(bill.reference) → job
    refToken?: string | null; // the extracted token (may exist even when no job found)
    pos: POCandidate[]; // POs to consider (caller may pre-filter to supplier; we re-filter defensively)
    config?: MatchConfig;
    installer?: boolean; // the bill has an installer (306/301) money line
  },
): MatchResult {
  const cfg = ctx.config || DEFAULT_MATCH_CONFIG;

  // HARD EXCLUSION — a trade-invoice mirror can never become a materials fact.
  if (ctx.isMirror) return { outcome: "skip_mirror" };
  // Only supplier bills (ACCPAY) are in scope.
  if ((bill.invoice_type || "").toUpperCase() !== "ACCPAY") {
    return { outcome: "skip_non_accpay" };
  }

  const token = ctx.refToken ?? extractJobNumber(bill.reference);

  // An installer bill is never placed automatically (JP-12): it waits in Bills
  // to place for a person, with the job its reference names as the suggestion.
  if (ctx.installer) {
    return {
      outcome: "queue",
      suggestedJobId: ctx.jobFromRef?.id ?? null,
      suggestedJobNumber: ctx.jobFromRef?.job_number ?? null,
      suggestionConfidence: ctx.jobFromRef ? "medium" : "low",
      suggestionReason: "installer_confirm",
    };
  }

  // (1) Reference → existing job. Highest confidence.
  if (ctx.jobFromRef) {
    return {
      outcome: "fact",
      jobId: ctx.jobFromRef.id,
      jobNumber: ctx.jobFromRef.job_number,
      confidence: "high",
      automationSource: "xero_ref_link",
      matchedPoId: null,
      matchReason: `ref:${ctx.jobFromRef.job_number}`,
    };
  }

  // (2) Deterministic-unique open-PO fallback.
  const poResult = findUniquePOMatch(bill, ctx.pos, cfg);
  if (poResult && "po" in poResult) {
    const po = poResult.po;
    return {
      outcome: "fact",
      jobId: po.job_id as string,
      jobNumber: po.job_number ?? null,
      confidence: "medium",
      automationSource: "po_deterministic",
      matchedPoId: po.id,
      matchReason: `po:${po.po_number || po.id} unique amt±${
        cfg.tolerancePct * 100
      }%/$${cfg.toleranceAbs} win-${cfg.windowDaysAfter}d`,
    };
  }

  // (3) Queue suggestion — NEVER a fact.
  let reason: SuggestionReason;
  let sConf: "low" | "medium" = "low";
  if (token && !ctx.jobFromRef) {
    reason = "ref_no_job"; // a job-shaped ref that matches no job on record
  } else if (poResult && "competitors" in poResult) {
    reason = "ambiguous_po_competitor"; // 2+ open POs matched — must stay manual
    sConf = "medium";
  } else if (supplierHasOpenPO(bill, ctx.pos)) {
    reason = "no_po_match"; // supplier has open POs but none matched amount/window
  } else {
    reason = "no_ref_no_po"; // the common case today
  }
  return {
    outcome: "queue",
    suggestedJobId: null,
    suggestedJobNumber: null,
    suggestionConfidence: sConf,
    suggestionReason: reason,
  };
}

// ─────────────────────────────────────────────────────────────
// Row builders — DERIVED rows keyed by xero_invoice_id (reversible by delete).
// ─────────────────────────────────────────────────────────────
export function buildMaterialsFactRow(
  bill: BillInput,
  m: MatchResult,
  orgId: string,
  opts?: { assignedBy?: string | null; nowIso?: string },
): Record<string, unknown> {
  const now = opts?.nowIso ?? new Date().toISOString();
  return {
    org_id: orgId,
    xero_invoice_id: bill.xero_invoice_id,
    invoice_number: bill.invoice_number,
    xero_contact_id: bill.xero_contact_id,
    contact_name: bill.contact_name,
    job_id: m.jobId,
    job_number: m.jobNumber ?? null,
    lane: "materials",
    kind: "actual",
    amount_ex_gst: bill.sub_total ?? 0,
    amount_inc_gst: bill.total ?? null,
    confidence: m.confidence,
    automation_source: m.automationSource,
    matched_po_id: m.matchedPoId ?? null,
    match_reason: m.matchReason ?? null,
    fact_date: bill.invoice_date,
    assigned_by: opts?.assignedBy ?? null,
    updated_at: now,
  };
}

export function buildQueueRow(
  bill: BillInput,
  m: MatchResult,
  orgId: string,
  opts?: { nowIso?: string },
): Record<string, unknown> {
  const now = opts?.nowIso ?? new Date().toISOString();
  return {
    org_id: orgId,
    xero_invoice_id: bill.xero_invoice_id,
    xero_contact_id: bill.xero_contact_id,
    contact_name: bill.contact_name,
    invoice_number: bill.invoice_number,
    sub_total: bill.sub_total ?? null,
    total: bill.total ?? null,
    invoice_date: bill.invoice_date,
    suggested_job_id: m.suggestedJobId ?? null,
    suggested_job_number: m.suggestedJobNumber ?? null,
    suggestion_confidence: m.suggestionConfidence ?? "low",
    suggestion_reason: m.suggestionReason ?? null,
    status: "open",
    updated_at: now,
  };
}

// ─────────────────────────────────────────────────────────────
// Existing automatic facts on the older ingest path (19 Oct 2026 reviews).
// This path never MOVES a fact to another job. It keeps its own fact
// (xero_ref_link or po_deterministic) unless the bill now hard-contradicts it,
// and then removes it so a person decides. Pre-match and human facts are not
// this path's to change.
// ─────────────────────────────────────────────────────────────
export const OWN_FACT_SOURCES = new Set(["xero_ref_link", "po_deterministic"]);

// Detection grammar, the same as the pre-match (bill_prematch.ts
// JOB_NUMBER_RE_GLOBAL): hyphen optional, so "SWF26999" in a line is seen as a
// job number. Placement still needs the hyphenated reference (JOB_NUMBER_RE);
// this wider grammar only stops a bill that names a second job being placed.
const JOB_NUMBER_ANY_RE = /(?<![A-Z0-9])SW(MS|[A-Z])(?:-(\d{4,6})|[ \t]?-?[ \t]?(\d{5,6}))(?![A-Z0-9])/gi;

/** Every distinct job number in a text, whole tokens only, normalised to SWX-12345. */
export function jobNumbersInText(text: string | null | undefined): Set<string> {
  const re = new RegExp(JOB_NUMBER_ANY_RE.source, "gi");
  return new Set(
    [...String(text || "").matchAll(re)].map((m) => `SW${m[1].toUpperCase()}-${m[2] ?? m[3]}`),
  );
}

export function existingFactVerdict(input: {
  source: string | null | undefined; // the fact's automation_source
  factJobId: string | null | undefined;
  factJobNumber?: string | null; // the fact's job number, to compare with a job number the bill names
  factJobBlocked: boolean; // the fact's job is not won, or is a holding job
  refTokens: Set<string>; // job numbers in the bill's reference
  lineTokens: Set<string>; // job numbers in the bill's line descriptions
  jobFromRefId: string | null; // the reference's job when it resolved and passed every guard
  xeroJobId?: string | null; // xero_invoices.job_id: the job Xero links the bill to
  namedPoJobIds?: Array<string | null>; // the job of each PO the bill names
  amountKnown?: boolean; // false when the bill's ex-GST subtotal is now missing
}): "none" | "not_ours" | "keep" | "remove" {
  if (!input.source) return "none";
  if (!OWN_FACT_SOURCES.has(input.source)) return "not_ours";
  const all = new Set([...input.refTokens, ...input.lineTokens]);
  if (input.factJobBlocked) return "remove";
  if (input.amountKnown === false) return "remove"; // the amount can no longer be stated
  if (input.xeroJobId && input.xeroJobId !== input.factJobId) return "remove"; // Xero links another job
  // A PO the bill names that is on another job, or on no job.
  if ((input.namedPoJobIds ?? []).some((j) => j !== input.factJobId)) return "remove";
  if (all.size > 1) return "remove"; // the bill names several jobs: a split for a person
  if (input.source === "xero_ref_link") {
    if (input.refTokens.size === 0) return "remove"; // the reference that placed it is gone
    if (!input.jobFromRefId) return "remove"; // the reference is now refused
  }
  if (input.jobFromRefId && input.jobFromRefId !== input.factJobId) return "remove"; // names another job
  // One job number on the bill (reference or lines) that is not the fact's job.
  if (all.size === 1) {
    const only = [...all][0];
    if (!input.factJobNumber || only !== String(input.factJobNumber).toUpperCase()) return "remove";
  }
  return "keep";
}

/** May this path place a bill that has no fact yet? Only on one consistent job number, or none at all. */
export function newPlacementAllowed(input: {
  refTokens: Set<string>;
  lineTokens: Set<string>;
  jobFromRefId: string | null;
  xeroJobId?: string | null; // xero_invoices.job_id: the job Xero links the bill to
  held?: boolean; // the open queue row holds the bill for a person
  amountKnown?: boolean; // false when the bill's ex-GST subtotal is missing
  namedPoJobIds?: Array<string | null>; // the job of each PO the bill names
}): { reference: boolean; poFallback: boolean } {
  // A bill that names a PO is left to the pre-match, which weighs the PO, unless
  // every PO it names is on the very job its reference resolves to.
  const poJobs = input.namedPoJobIds ?? [];
  if (poJobs.length > 0) {
    const agrees = !!input.jobFromRefId && poJobs.every((j) => j === input.jobFromRefId);
    if (!agrees) return { reference: false, poFallback: false };
  }
  if (input.held) return { reference: false, poFallback: false };
  // Unknown cost is never placed as $0: wait until the amount is known.
  if (input.amountKnown === false) return { reference: false, poFallback: false };
  const all = new Set([...input.refTokens, ...input.lineTokens]);
  if (all.size > 1) return { reference: false, poFallback: false };
  // A Xero job link this path cannot confirm is left to the pre-match, which
  // weighs it; the reference may place only on the very job Xero names.
  if (input.xeroJobId) {
    return { reference: !!input.jobFromRefId && input.jobFromRefId === input.xeroJobId && input.refTokens.size === 1, poFallback: false };
  }
  if (all.size === 1) {
    // One number: only the reference path, and only when it resolved and the
    // lines (if they name a job) name the same one. Never the PO fallback.
    return { reference: !!input.jobFromRefId && input.refTokens.size === 1, poFallback: false };
  }
  return { reference: false, poFallback: true };
}
