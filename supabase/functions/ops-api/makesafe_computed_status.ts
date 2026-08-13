// deno-lint-ignore-file no-explicit-any
// Make-safe board-truth M1 shadow engine.
//
// This module is deliberately pure. It consumes the durable records produced by
// the reporting workflow and returns an explainable status. It does not move a
// card, mirror substatus, create evidence, or change either board projection.

// Type-only. `ses_family_matrix.ts` imports nothing, so this cannot cycle, and
// the import is erased at runtime.
import type { SesFamilyId } from "./ses_family_matrix.ts";
// Type-only, same reason: `makesafe_terminal_proof.ts` imports nothing.
import type { MakesafeTerminalProofFact } from "./makesafe_terminal_proof.ts";

export const MAKESAFE_COMPLETION_PHOTO_FLOOR = 5;

// F4 — the truthful report-only waiting state. A roof / assessment card is
// instructed and live, and is waiting on proof that the builder's portal report
// was completed. Written at intake INSTEAD of the old `ready_to_invoice` (which
// the legacy ladder read as submitted-report evidence and derived to Report
// Ready before anybody had done the report).
//
// This constant is defined HERE, once, and imported by every consumer:
// index.ts's legacy ladder, makesafe_state_projection.ts's v2 canonical
// vocabulary, the intake approval path, and the stage-parity harness. Both
// stage engines map it to `allocated`.
//
// It is a PRE-report substatus: it is deliberately NOT in
// PORTAL_GUARDED_ADVANCE_SUBSTATUSES, so a card is free to sit here, and every
// advance OUT of it into a report-complete substatus stays guarded by the
// existing portal-verification rule. The only sanctioned way past Allocated is
// the explicit portal-completion evidence event
// (`mark_makesafe_portal_report_done`, index.ts:14068).
export const MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION =
  "awaiting_portal_completion";
export const MAKESAFE_COMPUTED_STATUSES = [
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  "completed",
  "archive",
  "cancelled",
] as const;
export type MakesafeComputedStatus =
  (typeof MAKESAFE_COMPUTED_STATUSES)[number];
export type MakesafeJobKind =
  | "physical_makesafe"
  | "roof_report"
  | "assessment_report_quote";

export interface MakesafeStatusHold {
  id?: string | null;
  reason_code: string;
  note: string;
  held_by?: string | null;
  created_at?: string | null;
  cycle_number?: number | null;
}

export interface MakesafePortalCapture {
  status?: string | null;
  role?: string | null;
  kind?: string | null;
  url?: string | null;
  signal?: string | null;
  locked?: boolean | null;
  screenshot?: string | null;
  screenshot_path?: string | null;
  cycle_number?: number | null;
  revision_id?: string | null;
  captured_at?: string | null;
  /**
   * Set ONLY by `portalCapturesFromLedger` against a validated append-only
   * revision written by the approved trade-attestation producer (captain,
   * 2026-08-02). It is what lets a screenshot-less capture count as done: the
   * trade rendered no page, so the proof is a named authenticated confirmer
   * rather than an image. Card-derived capture entries are stripped of it.
   */
  attested_producer?: string | null;
  attested_by?: string | null;
}

/**
 * The approved trade attestation producer, restated here rather than imported
 * so the pure status engine keeps its zero-dependency shape. The single
 * consumer is `donePortalRoles`; the constant it must agree with is
 * `SES_TRADE_PORTAL_CONFIRMATION_PRODUCER` in `ses_portal_capture_contract.ts`,
 * and `makesafe_computed_status_test.ts` pins the two together.
 */
export const MAKESAFE_ATTESTED_PORTAL_PRODUCER = "trade_portal_confirmation/v1";

export interface MakesafeStatusEvidence {
  assignments?: any[];
  serviceReports?: any[];
  completionPhotoCount?: number;
  portalCaptures?: MakesafePortalCapture[];
  packState?: string | null;
  pack?: {
    status?: string | null;
    report_doc_id?: string | null;
    invoice_doc_id?: string | null;
    swms_doc_id?: string | null;
    sent_at?: string | null;
  } | null;
  invoiceStatus?: string | null;
  /** Shared exact-job/type/status/reference prerequisite from the board loader. */
  invoiceQualifiesAsCurrentDraft?: boolean;
  invoiceDate?: string | null;
  invoiceCreatedAt?: string | null;
  packSent?: boolean;
  documents?: {
    report?: boolean;
    ownRoofReportDocumentIds?: Set<string>;
    invoice?: boolean;
    swms?: boolean;
  };
  swmsRequired?: boolean;
  hold?: MakesafeStatusHold | null;
  /**
   * R5 — the current-cycle own-template roof report draft, when the card is an
   * own-template roof. `computeMakesafeStatus` IGNORES this: M1 proves a roof
   * card through Prime portal captures only, and its published value must stay
   * byte-identical. The corrected shadow engine reads it because an
   * own-template roof produces OUR report, so there is no Prime form to observe
   * and a portal capture can never arrive for one.
   */
  ownRoofDraft?: {
    status?: string | null;
    cycle_number?: number | null;
    report_doc_id?: string | null;
  } | null;
  /**
   * The card's `makesafe_terminal_proofs` rows and the attendance-cycle set
   * they are checked against. `computeMakesafeStatus` IGNORES both: M1's
   * published value is what today's certificates grade against and must stay
   * byte-identical. The corrected shadow engine reads them because a terminal
   * proof is the recorded, producer-attributed evidence that a card's work is
   * finished, and it is the only such record for a closeout that happened
   * outside the release flow.
   */
  terminalProofs?: MakesafeTerminalProofFact[] | null;
  attendanceCycleIds?: string[] | null;
  currentAttendanceCycleId?: string | null;
}

export interface MakesafeStatusInput {
  job?: {
    status?: string | null;
    completed_at?: string | null;
    archived_at?: string | null;
    updated_at?: string | null;
    metadata?: any;
  } | null;
  detail?: {
    report_type?: string | null;
    cycle_number?: number | null;
    report_sent_at?: string | null;
    invoice_ready_at?: string | null;
    external_links?: any[];
    // R4 — read only when the caller did not supply `ses_family` and the
    // shadow engine has to derive the family from the card itself. The board
    // read model already reads this same field off the detail row.
    report_delivery?: string | null;
    // F4 — read ONLY to recognise MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION.
    // This engine still derives every other stage from durable evidence; it does
    // not mirror the substatus ladder.
    substatus?: string | null;
  } | null;
  evidence?: MakesafeStatusEvidence;
  displayedStatus?: string | null;
  /**
   * R4 — the canonical SES family from `canonicalSesFamilyFromCard`, supplied
   * by the caller that already computed it. THIS ENGINE DELIBERATELY IGNORES
   * IT: `computeMakesafeStatus` keeps classifying with its own three-kind
   * `classifyMakesafeJobType` guess so its published output stays byte-identical
   * to what today's certificates grade against. The field exists so the
   * corrected shadow engine can read a real family instead of re-guessing one,
   * off the same single input object. Optional on purpose — a caller that omits
   * it makes the shadow engine derive the family from the card itself.
   */
  ses_family?: SesFamilyId | null;
  nowIso?: string;
}

export interface MakesafeStatusResult {
  status: MakesafeComputedStatus;
  job_type: MakesafeJobKind;
  reasons: string[];
  missing: string[];
  hold: MakesafeStatusHold | null;
  closeout_satisfied?: boolean;
}

const normalizedToken = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function classifyMakesafeJobType(
  detail: MakesafeStatusInput["detail"],
  job: MakesafeStatusInput["job"],
): MakesafeJobKind {
  const reportType = normalizedToken(detail?.report_type);
  const family = normalizedToken(job?.metadata?.makesafe_job_family);
  const token = reportType || family;
  if (token === "roof_report") return "roof_report";
  if (token === "assessment_report" || token === "assessment_report_quote") {
    return "assessment_report_quote";
  }
  return "physical_makesafe";
}

function currentCycleReports(input: MakesafeStatusInput): any[] {
  const cycle = Number(input.detail?.cycle_number ?? 1);
  return (input.evidence?.serviceReports || []).filter((report) =>
    Number(report?.cycle_number ?? 1) === cycle
  );
}

function submittedPhysicalReport(input: MakesafeStatusInput): boolean {
  return currentCycleReports(input).some((report) =>
    ["submitted", "approved"].includes(
      String(report?.status || "").toLowerCase(),
    )
  );
}

export function captureRole(capture: MakesafePortalCapture): string {
  const role = normalizedToken(capture.role || capture.kind);
  if (["roof", "roof_report"].includes(role)) return "roof_report";
  if (["assessment", "assessment_report"].includes(role)) {
    return "assessment_report";
  }
  if (["photos", "photo_schedule", "photo_evidence"].includes(role)) {
    return "photos";
  }
  if (["quote", "quotation", "scope", "scope_of_works"].includes(role)) {
    return "quote";
  }
  return role;
}

export function donePortalRoles(input: MakesafeStatusInput): Set<string> {
  const cycle = Number(input.detail?.cycle_number ?? 1);
  const requiresTypedAssessmentIdentity =
    classifyMakesafeJobType(input.detail, input.job) ===
      "assessment_report_quote";
  const typedLinks = Array.isArray(input.detail?.external_links)
    ? input.detail.external_links
    : [];
  return new Set(
    (input.evidence?.portalCaptures || [])
      .filter((capture) => {
        const role = captureRole(capture);
        const captureUrl = String(capture?.url || "").trim().toLowerCase();
        // Two producers, one fact (captain, 2026-08-02). The deterministic
        // reader proves what it saw with a stored screenshot; a trade
        // attestation proves who said so. Either is evidence; neither is
        // inferred from a substatus.
        const proven =
          !!String(capture?.screenshot || capture?.screenshot_path || "")
            .trim() ||
          capture?.attested_producer === MAKESAFE_ATTESTED_PORTAL_PRODUCER;
        return (
          String(capture?.status || "").toLowerCase() === "done" &&
          proven &&
          (capture?.cycle_number == null ||
            Number(capture.cycle_number) === cycle) &&
          (!requiresTypedAssessmentIdentity || (
            capture?.locked === true &&
            !!captureUrl &&
            typedLinks.some((link: any) =>
              captureRole({ role: link?.role, kind: link?.kind }) === role &&
              String(link?.url || "").trim().toLowerCase() === captureUrl
            )
          ))
        );
      })
      .map(captureRole)
      .filter(Boolean),
  );
}

export function externalPortalRoles(input: MakesafeStatusInput): Set<string> {
  return new Set(
    (Array.isArray(input.detail?.external_links)
      ? input.detail.external_links
      : [])
      .map((link: any) =>
        captureRole({
          role: link?.role,
          kind: link?.kind,
        })
      )
      .filter(Boolean),
  );
}

function portalRoleLabel(role: string): string {
  if (role === "assessment_report") return "assessment";
  if (role === "photos") return "photos";
  if (role === "quote") return "quote/scope";
  return "roof report";
}

function portalWaitingSentence(
  input: MakesafeStatusInput,
  role: string,
): string {
  const label = portalRoleLabel(role);
  const links = externalPortalRoles(input);
  if (!links.has(role)) {
    return `The work order email contains no ${label} link - ask the builder to send it.`;
  }
  const cycle = Number(input.detail?.cycle_number ?? 1);
  const capture = (input.evidence?.portalCaptures || []).find((item) =>
    captureRole(item) === role &&
    (item.cycle_number == null || Number(item.cycle_number) === cycle)
  );
  const signal = String(capture?.signal || "");
  if (
    String(capture?.status || "").toLowerCase() === "unreachable" &&
    /expired|no longer active|no longer available/i.test(signal)
  ) {
    return `The builder's ${label} link is expired - ask the builder to send a fresh ${label} link.`;
  }
  if (String(capture?.status || "").toLowerCase() === "not_done") {
    return `The builder's ${label} form is not submitted and locked - ask the trade to finish it in Prime.`;
  }
  return `The ${label} link still needs a headless capture proving the Prime form is submitted and locked.`;
}

export function reportInEvidence(input: MakesafeStatusInput): {
  satisfied: boolean;
  missing: string[];
} {
  const kind = classifyMakesafeJobType(input.detail, input.job);
  if (kind === "physical_makesafe") {
    const missing: string[] = [];
    if (!submittedPhysicalReport(input)) {
      missing.push("current-cycle submitted service report");
    }
    const count = Number(input.evidence?.completionPhotoCount || 0);
    if (count < MAKESAFE_COMPLETION_PHOTO_FLOOR) {
      missing.push(
        `${MAKESAFE_COMPLETION_PHOTO_FLOOR} completion photos (found ${count})`,
      );
    }
    return { satisfied: missing.length === 0, missing };
  }

  const done = donePortalRoles(input);
  const required = kind === "roof_report"
    ? ["roof_report"]
    : ["assessment_report", "photos", "quote"];
  const links = externalPortalRoles(input);
  const missing = required.filter((role) => !done.has(role) || !links.has(role))
    .map((role) => portalWaitingSentence(input, role));
  return { satisfied: missing.length === 0, missing };
}

/**
 * Physical Docs Ready accepts the canonical current-cycle report predicate as
 * a legacy fallback when a fully drafted pack missed its report_doc_id bind.
 * A real typed/bound report document remains sufficient on its own.
 */
export function physicalReportCloseoutSatisfied(
  input: MakesafeStatusInput,
): boolean {
  return !!input.evidence?.pack?.report_doc_id ||
    input.evidence?.documents?.report === true ||
    reportInEvidence(input).satisfied;
}

export function docsReady(input: MakesafeStatusInput): boolean {
  // Docs Ready is the pre-authorisation review queue. A qualifying current
  // Xero DRAFT is the money-side prerequisite; an AUTHORISED/SUBMITTED/PAID
  // invoice without that fact must not over-promote an unsent card.
  const pack = input.evidence?.pack;
  const packStatus = String(pack?.status || "").toLowerCase();
  const packSentStatuses = [
    "sent",
    "sent_marker_failed",
    "sent_not_closed",
    "close_failed",
  ];
  const qualifiesDraft =
    input.evidence?.invoiceQualifiesAsCurrentDraft === true;
  if (!qualifiesDraft) return false;

  const kind = classifyMakesafeJobType(input.detail, input.job);
  const recorded = String(input.evidence?.packState || "").toUpperCase();
  if (["READY", "READY_TO_BUILD"].includes(recorded)) {
    return kind !== "assessment_report_quote" ||
      reportInEvidence(input).satisfied;
  }

  // Legacy durable pack rows predate a persisted pack_state value. Read their
  // already-produced artifacts rather than re-running the reporting skill:
  // first draft pack + qualifying current DRAFT + SWMS when the docket requires
  // it. The DRAFT itself is the invoice closeout fact; it need not also be
  // duplicated into job_documents before the card can be reviewed.
  if (!pack || packSentStatuses.includes(packStatus)) return false;
  if (
    kind === "physical_makesafe" &&
    !physicalReportCloseoutSatisfied(input)
  ) return false;
  if (input.evidence?.swmsRequired && !pack.swms_doc_id) return false;
  // A legacy pack row is accepted only when the underlying report evidence also
  // satisfies the approved job-type predicate. A malformed artifact row cannot
  // manufacture Docs Ready by itself.
  return reportInEvidence(input).satisfied;
}

export function closeoutSatisfied(input: MakesafeStatusInput): boolean {
  const kind = classifyMakesafeJobType(input.detail, input.job);
  const invoiceStatus = String(input.evidence?.invoiceStatus || "")
    .toUpperCase();
  const authorised = ["AUTHORISED", "SUBMITTED", "PAID"].includes(
    invoiceStatus,
  );
  const durableCloseoutInvoice = ["AUTHORISED", "PAID"].includes(
    invoiceStatus,
  );
  const sent = input.evidence?.packSent === true || [
    "sent",
    "sent_marker_failed",
    "sent_not_closed",
    "close_failed",
  ].includes(String(input.evidence?.pack?.status || "").toLowerCase());
  // A durable send record plus an issued/paid ACCREC invoice is authoritative
  // close-out evidence. Missing historical portal captures or re-attached PDFs
  // must not revive work that demonstrably went out the door.
  if (sent && durableCloseoutInvoice) return true;
  const docs = input.evidence?.documents || {};
  if (!sent || !authorised || docs.invoice !== true) return false;
  if (kind === "physical_makesafe" && docs.report !== true) return false;
  if (input.evidence?.swmsRequired && docs.swms !== true) return false;
  return kind === "physical_makesafe" || reportInEvidence(input).satisfied;
}

function completedAt(input: MakesafeStatusInput): number | null {
  const raw = input.evidence?.pack?.sent_at ||
    input.evidence?.invoiceDate ||
    input.evidence?.invoiceCreatedAt ||
    input.detail?.invoice_ready_at ||
    input.job?.completed_at ||
    input.job?.updated_at ||
    input.detail?.report_sent_at ||
    null;
  if (!raw) return null;
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? value : null;
}

/** The non-terminal half of the ladder: READY pack, report-in, allocation, new. */
export type MakesafeEvidenceStage =
  | "report_ready"
  | "trade_report_in"
  | "allocated"
  | "new";

export interface MakesafeEvidenceStageResult {
  status: MakesafeEvidenceStage;
  reasons: string[];
  missing: string[];
}

/**
 * Derives the evidence-only half of the stage ladder — everything below the
 * terminal branches.
 *
 * Extracted verbatim from `computeMakesafeStatus` so the corrected shadow
 * engine (`ses_stage_engine_v2.ts`) can reuse ONE definition of "what the
 * evidence on this card proves" rather than keeping a second copy that can
 * drift. The terminal branches deliberately stay out: correcting their clock
 * and their corroboration is exactly what the shadow engine changes, and the
 * two engines must be free to disagree there while agreeing here.
 */
export function deriveMakesafeEvidenceStage(
  input: MakesafeStatusInput,
  /**
   * R5 — an optional replacement for the report-in test ONLY.
   *
   * This is the seam that lets the corrected shadow engine prove an
   * own-template roof card from its submitted draft without either engine
   * keeping a second copy of the ladder. `computeMakesafeStatus` never passes
   * it, so M1's output is unchanged by construction; the rest of the ladder
   * (docs-ready, allocation, new) stays shared and is evaluated exactly once.
   */
  overrides?: {
    reportIn?: { satisfied: boolean; missing: string[] };
    reportInReason?: string;
    /**
     * R7 — an optional replacement for the Docs Ready test ONLY, same seam
     * shape as `reportIn`. `computeMakesafeStatus` never passes it.
     */
    docsReady?: { satisfied: boolean; missing: string[] };
    docsReadyReason?: string;
  },
): MakesafeEvidenceStageResult {
  const kind = classifyMakesafeJobType(input.detail, input.job);
  const hold = input.evidence?.hold || null;
  const reasons: string[] = [];
  const missing: string[] = [];

  const docsReadyResult = overrides?.docsReady;
  if (docsReadyResult ? docsReadyResult.satisfied : docsReady(input)) {
    reasons.push(
      overrides?.docsReadyReason ??
        "validated draft-pack records are READY or READY_TO_BUILD",
    );
    return { status: "report_ready", reasons, missing };
  }
  // Deliberately NOT pushed into `missing`. The override decides SATISFACTION
  // only; `missing` keeps its existing meaning (what report-in evidence the
  // card is short of). Folding docs-ready shortfalls in here would change the
  // published `derived_stage_v2_missing` on every card that is not Docs Ready —
  // a second, unmeasured output change riding inside this release.

  const reportIn = overrides?.reportIn ?? reportInEvidence(input);
  if (reportIn.satisfied) {
    reasons.push(
      overrides?.reportInReason ??
        (kind === "physical_makesafe"
          ? "current-cycle submitted service report and completion photo floor are present"
          : "all required typed portal captures are recorded done"),
    );
    if (hold) reasons.push(`hold badge: ${hold.reason_code}`);
    return { status: "trade_report_in", reasons, missing };
  }
  missing.push(...reportIn.missing);

  const hasAssignment = (input.evidence?.assignments || []).length > 0;
  if (hasAssignment) {
    reasons.push("job assignment exists");
    return { status: "allocated", reasons, missing };
  }

  // F4 — the report-only waiting state places the card in Allocated in this
  // engine too, so the legacy ladder and M1 agree on where a freshly approved
  // roof / assessment card lands. This reads a persisted state, not an
  // assignment and not a completion claim: the card is still short every
  // required portal capture (already collected in `missing` above), so nothing
  // here can advance it. Only the explicit portal-completion evidence event
  // moves the card off this substatus.
  if (
    String(input.detail?.substatus || "").trim().toLowerCase() ===
      MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION
  ) {
    reasons.push(
      "card is awaiting proof the builder-portal report was completed",
    );
    return { status: "allocated", reasons, missing };
  }

  if (kind !== "physical_makesafe") {
    const hasPortalLink =
      Array.isArray((input.detail as any)?.external_links) &&
      (input.detail as any).external_links.length > 0;
    if (hasPortalLink) {
      reasons.push("portal link exists and required captures are not all done");
      return { status: "allocated", reasons, missing };
    }
  }

  reasons.push("card exists with no allocation or completed report evidence");
  return { status: "new", reasons, missing };
}

export function computeMakesafeStatus(
  input: MakesafeStatusInput,
): MakesafeStatusResult {
  const jobStatus = String(input.job?.status || "").toLowerCase();
  const kind = classifyMakesafeJobType(input.detail, input.job);
  const hold = input.evidence?.hold || null;
  const reasons: string[] = [];
  const missing: string[] = [];
  const displayedStatus = String(input.displayedStatus || "").toLowerCase();

  // Structural no-revival invariant. The display stage is the board's current
  // operator truth; terminal cards retain that exact terminal stage even if
  // operational job state and sparse historical evidence disagree.
  if (displayedStatus === "archive") {
    return {
      status: "archive",
      job_type: kind,
      reasons: ["displayed card is already archived"],
      missing,
      hold,
      closeout_satisfied: closeoutSatisfied(input),
    };
  }
  if (displayedStatus === "completed") {
    return {
      status: "completed",
      job_type: kind,
      reasons: ["displayed card is already completed"],
      missing,
      hold,
    };
  }
  if (displayedStatus === "cancelled") {
    return {
      status: "cancelled",
      job_type: kind,
      reasons: ["displayed card is already cancelled"],
      missing,
      hold,
    };
  }

  if (["cancelled", "canceled"].includes(jobStatus)) {
    return {
      status: "cancelled",
      job_type: kind,
      reasons: ["job is cancelled"],
      missing,
      hold,
    };
  }
  if (jobStatus === "archived") {
    return {
      status: "archive",
      job_type: kind,
      reasons: ["job is archived"],
      missing,
      hold,
    };
  }
  if (["complete", "completed", "closed"].includes(jobStatus)) {
    return {
      status: "completed",
      job_type: kind,
      reasons: ["job is already completed or closed"],
      missing,
      hold,
    };
  }

  if (closeoutSatisfied(input)) {
    reasons.push(
      "durable sent-pack evidence and authorised invoice agree",
    );
    const at = completedAt(input);
    const now = new Date(input.nowIso || new Date().toISOString()).getTime();
    // Match the displayed model: an unknown completion timestamp stays visible
    // in Completed for operator repair; it never falls straight into Archive.
    const withinSevenDays = at == null ||
      (Number.isFinite(now) && now - at < 7 * 86_400_000);
    return {
      status: withinSevenDays ? "completed" : "archive",
      job_type: kind,
      reasons,
      missing,
      hold,
    };
  }

  const evidenceStage = deriveMakesafeEvidenceStage(input);
  reasons.push(...evidenceStage.reasons);
  missing.push(...evidenceStage.missing);
  return {
    status: evidenceStage.status,
    job_type: kind,
    reasons,
    missing,
    hold,
  };
}

export interface MakesafeDisagreementCard {
  id: string;
  job_number?: string | null;
  substatus?: string | null;
  declared_status: string;
  computation: MakesafeStatusResult;
}

export function buildMakesafeDisagreementList(
  cards: MakesafeDisagreementCard[],
) {
  return cards.filter((card) =>
    String(card.declared_status || "").toLowerCase() !==
      card.computation.status
  ).map((card) => ({
    job_id: card.id,
    job_number: card.job_number || null,
    declared_substatus: card.substatus || null,
    declared_status: card.declared_status,
    computed_status: card.computation.status,
    why_they_differ: {
      summary:
        `declared ${card.declared_status}; evidence computes ${card.computation.status}`,
      reasons: card.computation.reasons,
      missing: card.computation.missing,
      hold: card.computation.hold,
    },
  }));
}

export interface MakesafeCanaryCard extends MakesafeDisagreementCard {
  report_received_at?: string | null;
  has_submitted_service_report?: boolean;
  has_current_portal_capture?: boolean;
}

export function checkMakesafeStatusCanary(cards: MakesafeCanaryCard[]) {
  const alarms: Array<Record<string, unknown>> = [];
  const disagreements = buildMakesafeDisagreementList(cards);
  for (const row of disagreements) {
    alarms.push({ code: "declared_computed_disagreement", ...row });
  }
  for (const card of cards) {
    if (
      card.report_received_at && !card.has_submitted_service_report &&
      !card.has_current_portal_capture
    ) {
      alarms.push({
        code: "report_received_without_evidence",
        job_id: card.id,
        job_number: card.job_number || null,
      });
    }
    if (
      card.report_received_at && [
        "company_contact_required",
        "company_contact_done",
        "waiting_on_trade_report",
      ].includes(String(card.substatus || "").toLowerCase())
    ) {
      alarms.push({
        code: "report_received_with_pre_report_substatus",
        job_id: card.id,
        job_number: card.job_number || null,
        declared_substatus: card.substatus || null,
      });
    }
  }
  return { ok: alarms.length === 0, checked: cards.length, alarms };
}
