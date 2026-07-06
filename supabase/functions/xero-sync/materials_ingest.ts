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
export const JOB_NUMBER_RE = /SW(?:MS|[A-Z])-\d{4,5}(?!\d)/i;

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
  | "ambiguous_po_competitor";

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
