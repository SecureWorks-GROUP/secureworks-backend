// ############################################################################
// # PARKED — DO NOT LAND THIS AS WRITTEN.                                    #
// #                                                                          #
// # This module wires Docs Ready placement to `computed_status`. An audit    #
// # outside this fleet found `computed_status` is CIRCULAR: the DISPLAYED    #
// # STAGE is fed back into the computation that produces it (see             #
// # `displayedStatus` in `computeMakesafeStatus`, and the header of          #
// # `ses_stage_engine_v2.ts`, whose input deliberately OMITS that key to end #
// # the circular "display determines computation" path). A column consuming  #
// # this field would therefore derive from a field that derives from the     #
// # column.                                                                  #
// #                                                                          #
// # Board placement, stage derivation, substatus and the Docs Ready column   #
// # also have another owner. Do not revive this, and do not fix the          #
// # circularity from here — that is theirs.                                  #
// #                                                                          #
// # Full state note, the verified production measurement, and what IS worth  #
// # salvaging: `docs/evidence/ses-docs-ready-capture-gate-2026-08-06.md`.    #
// ############################################################################
//
// Docs Ready capture gate — the placement prerequisite for the portal-report
// families.
//
// WHY THIS EXISTS
// ---------------
// The board placed a card in Docs Ready (`report_ready`) from the declared
// ladder plus the display-ledger overlay, and neither of those reads the
// portal-capture evidence. `makesafe_computed_status.ts` already computes that
// evidence per family and already names the exact captures a card is short of;
// the column simply did not consume it. Measured on production 2026-08-06, of
// the 15 cards the declared ladder put in Docs Ready, 10 were behind
// `report_ready` by the system's own computation — 7 assessment cards short of
// all three of their captures and 3 roof cards short of their one.
//
// WHAT THIS IS NOT
// ----------------
// It is NOT a second completeness engine. The verdict, the held destination and
// the published missing list are all ONE call to `computeMakesafeStatus` — the
// same engine, the same input shape, the same output the board already
// publishes as `computed_status` / `computed_status_missing`. There is no rule
// here to disagree with M1 about.
//
// It is also not a stage engine: it can only REMOVE a card from `report_ready`,
// never add one, and it touches no other destination. That mirrors the existing
// Docs Ready prerequisite in the overlay resolver
// (`invoiceQualifiesAsCurrentDraft`), which is the same seam one layer up.
//
// DELIBERATELY NOT OUT-STRICTING M1
// ---------------------------------
// `docsReady()` accepts a roof card whose draft-pack record is READY without
// re-checking its portal capture. Two live roof cards sit on exactly that
// branch (White Gum Valley SWMS-261114 and Mindarie SWMS-261081 on 2026-08-06:
// `computed_status: report_ready` with `has_current_portal_capture: false`).
// Reading `reportInEvidence` directly here instead of the engine's own verdict
// would evict them — a STRICTER rule than the system computes, invented at the
// placement layer. That roof question belongs to the roof-exemption work, not
// to this gate. So the gate consumes the engine's answer and those cards stay.
//
// SCOPE — the portal-report families only
// ---------------------------------------
// `classifyMakesafeJobType` returns `roof_report` / `assessment_report_quote`
// for the families whose report-in evidence IS the set of Prime portal
// captures, and those are the two families whose evidence the board's card
// shape can fully supply. A `physical_makesafe` card is judged on a submitted
// service report plus the completion-photo floor, and the card shape loads
// neither; running the engine on it here would demote it for missing INPUTS
// rather than missing evidence. Those cards keep today's placement, and the
// exclusion is structural (`applies: false`), never a silent pass.
//
// NO VERDICT IS NOT A FAILING VERDICT
// -----------------------------------
// Three cases resolve to "leave the card exactly where it was":
//   * a family the rule does not cover (`applies: false`);
//   * a capture ledger this request could not read (`satisfied: null`,
//     `portal_capture_evidence_unreadable`) — `makesafe_portal_capture_revisions`
//     is read behind a try/catch that fails closed to an empty list, so an
//     unreadable ledger and a card with genuinely zero captures are
//     byte-identical at this layer and only the caller knows which happened;
//   * a card the engine puts AHEAD of Docs Ready — completed, archived or
//     cancelled (`computed_status_ahead_of_docs_ready`). "Further along than
//     ready" is not "not ready", and moving such a card is a different
//     question from the one this gate answers.

import {
  classifyMakesafeJobType,
  computeMakesafeStatus,
  type MakesafeJobKind,
  type MakesafeStatusInput,
} from "./makesafe_computed_status.ts";

/**
 * Versions the gate's own semantics. Published on every row so a past
 * measurement can name the rule that produced its placement, exactly as
 * `derived_stage_v2_engine_version` does for the shadow engine. Deliberately
 * separate from `MAKESAFE_BOARD_CONTRACT_VERSION` (payload shape — this change
 * is additive) and from `MAKESAFE_STAGE_LADDER_VERSION` (the declared ladder —
 * unchanged; the gate runs after it, like the overlay resolver).
 */
export const DOCS_READY_CAPTURE_GATE_VERSION = "docs-ready-capture-gate/v1";

/** The one stage this gate guards. It never touches another destination. */
export const DOCS_READY_STAGE = "report_ready";

/**
 * The computed statuses that sit BELOW Docs Ready. A card the engine puts in
 * one of these has not reached Docs Ready, so the board must not show it there.
 * Every other computed status — `report_ready` itself, and the three terminal
 * ones — leaves placement alone.
 */
export const DOCS_READY_PRECEDING_STATUSES = [
  "new",
  "allocated",
  "trade_report_in",
] as const;

export const DOCS_READY_CAPTURE_GATE_REASONS = {
  /** The engine puts this card below Docs Ready — held, and told why. */
  belowDocsReady: "computed_status_below_docs_ready",
  /** The capture ledger could not be read; no verdict, so no movement. */
  unreadable: "portal_capture_evidence_unreadable",
  /** Completed / archived / cancelled: past ready, not short of it. */
  ahead: "computed_status_ahead_of_docs_ready",
} as const;

export const DOCS_READY_CAPTURE_BLOCKER_CODE = "portal_capture_not_proven";
export const DOCS_READY_CAPTURE_BLOCKER_CATEGORY = "ses_portal_capture";

export interface DocsReadyCaptureGate {
  version: string;
  /** Did the rule have anything to say about this card at this stage? */
  applies: boolean;
  /** true / false when it did; null when it had no usable verdict. */
  satisfied: boolean | null;
  job_type: MakesafeJobKind;
  /** The engine's own status for this card, when it was consulted. */
  computed_status: string | null;
  /** The exact captures the card is short of, in the engine's own wording. */
  missing: string[];
  /** Where the card would have been placed had the gate not run. */
  held_from_stage: string | null;
  /** Where the gate placed it instead (null when it moved nothing). */
  held_to_stage: string | null;
  reason: string | null;
}

function gate(
  over: Partial<DocsReadyCaptureGate> & {
    job_type: MakesafeJobKind;
  },
): DocsReadyCaptureGate {
  return {
    version: DOCS_READY_CAPTURE_GATE_VERSION,
    applies: false,
    satisfied: null,
    computed_status: null,
    missing: [],
    held_from_stage: null,
    held_to_stage: null,
    reason: null,
    ...over,
  };
}

/**
 * Does this card's family have a portal-capture opinion at all? The board uses
 * it to decide which job ids need the capture ledger loaded, so it must stay
 * the same predicate the gate itself applies — one definition, no drift.
 */
export function docsReadyCaptureGateFamilyApplies(
  detail: MakesafeStatusInput["detail"],
  job: MakesafeStatusInput["job"],
): boolean {
  return classifyMakesafeJobType(detail, job) !== "physical_makesafe";
}

/**
 * Evaluates the gate for one card.
 *
 * `input` is the same `MakesafeStatusInput` the board hands `computeMakesafeStatus`,
 * minus the keys only a physical card is judged on (completion photos, service
 * reports) — which is exactly why the scope note above excludes that family.
 * `displayedStatus` is deliberately NOT set: it drives the engine's no-revival
 * short-circuits, and a card the ladder placed at `report_ready` has no
 * terminal display to preserve.
 *
 * `captureEvidenceReadable` is the caller's answer to "did the capture ledger
 * read succeed for this request?" — see the header note on why an empty list
 * cannot answer it.
 */
export function evaluateDocsReadyCaptureGate(args: {
  displayStage: string;
  input: MakesafeStatusInput;
  captureEvidenceReadable: boolean;
}): DocsReadyCaptureGate {
  const jobType = classifyMakesafeJobType(args.input?.detail, args.input?.job);
  const stage = String(args.displayStage || "").trim().toLowerCase();
  if (stage !== DOCS_READY_STAGE) return gate({ job_type: jobType });
  if (jobType === "physical_makesafe") return gate({ job_type: jobType });

  if (args.captureEvidenceReadable !== true) {
    return gate({
      job_type: jobType,
      applies: true,
      reason: DOCS_READY_CAPTURE_GATE_REASONS.unreadable,
    });
  }

  const computation = computeMakesafeStatus(args.input);
  const status = String(computation.status);

  if (
    !(DOCS_READY_PRECEDING_STATUSES as readonly string[]).includes(status)
  ) {
    return gate({
      job_type: jobType,
      applies: true,
      // `report_ready` is a pass; a terminal status is a different question.
      satisfied: status === DOCS_READY_STAGE ? true : null,
      computed_status: status,
      reason: status === DOCS_READY_STAGE
        ? null
        : DOCS_READY_CAPTURE_GATE_REASONS.ahead,
    });
  }

  return gate({
    job_type: jobType,
    applies: true,
    satisfied: false,
    computed_status: status,
    missing: computation.missing,
    held_from_stage: DOCS_READY_STAGE,
    held_to_stage: status,
    reason: DOCS_READY_CAPTURE_GATE_REASONS.belowDocsReady,
  });
}

export interface DocsReadyCaptureGateBlocker {
  code: string;
  category: string;
  /** The missing capture, in the engine's own wording. */
  fact: string;
  recovery_action: string;
  held_from_stage: string | null;
  held_to_stage: string | null;
  gate_version: string;
}

/**
 * The operator-facing half. A card that vanishes from Docs Ready with no
 * explanation is a different dishonesty from a card that was wrongly there, so
 * every held card carries one blocker per capture it is short of, in the same
 * `blockers.real[]` shape the rest of the board already paints.
 */
export function docsReadyCaptureGateBlockers(
  gateResult: DocsReadyCaptureGate | null | undefined,
): DocsReadyCaptureGateBlocker[] {
  if (
    !gateResult || gateResult.applies !== true || gateResult.satisfied !== false
  ) {
    return [];
  }
  return (gateResult.missing || []).map((fact) => ({
    code: DOCS_READY_CAPTURE_BLOCKER_CODE,
    category: DOCS_READY_CAPTURE_BLOCKER_CATEGORY,
    fact,
    recovery_action:
      "Capture the Prime form as submitted and locked, then the card returns to Docs Ready.",
    held_from_stage: gateResult.held_from_stage,
    held_to_stage: gateResult.held_to_stage,
    gate_version: gateResult.version,
  }));
}
