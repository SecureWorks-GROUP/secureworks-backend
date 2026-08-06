// SES Item 10 -- the rules-clean determination for auto-authorisation.
//
// PURE. No network, no Supabase, no Xero. The caller collects evidence; this
// module decides. That split is deliberate: the determination must be
// re-derivable from a recorded evidence snapshot long after the fact, which is
// what the Captain's "why was this authorised without me" question needs.
//
// ── What this module is for ────────────────────────────────────────────────
//
// The Captain ruled (2026-08-06) that the skill may advance its own rules-clean
// DRAFT invoices to AUTHORISED without him. SEND IT stays his per-card press.
// This module is the definition of "rules-clean". It answers exactly one
// question: MAY THE HUMAN BE SKIPPED ON THIS INVOICE? Nothing else. It prices
// nothing, writes nothing, sends nothing, and returns no send affordance.
//
// ── The safety inversion this module lives under ───────────────────────────
//
// A BLIND GUARD REPORTS CLEAN. It does not report "I could not tell"; it
// reports the same word a genuinely clean invoice gets. On the day this was
// ruled, the live duplicate guard was PO-blind: it compared reference strings,
// so `MLB-27093` and `MLB-27093PO-56481` did not match and a double-bill
// reached a real card. A human at APPROVE INVOICE caught it. Under this
// automation there is no human at that point.
//
// Two structural consequences, and they are the whole design:
//
//  1. UNEVALUABLE IS OFF-RULES. Every guard has three outcomes, never two:
//     `clean`, `flagged`, `unevaluable`. Only an all-`clean` sweep of the
//     CLOSED guard list is rules-clean. A read that failed, an input that is
//     absent, a shape nobody modelled -- all of them park. There is no branch
//     in this file that turns "I could not tell" into "clean".
//
//  2. THE PRICING CHECK IS A WHITELIST, NOT A BLACKLIST. `deriveSealedProposal`
//     re-derives, from the sealed constants, the EXACT line set the sealed
//     pricing law would have produced for this card's own declared facts, and
//     requires an exact match. A blacklist can only catch fault shapes someone
//     thought of; this catches every shape that is not the one sealed shape.
//     That is the answer to "a fault class absent from the shadow window": an
//     unmodelled fault is a mismatch, and a mismatch parks.
//
// Divergence rule, stated so a future maintainer cannot get it backwards: this
// classifier is a SUBTRACTIVE gate, never a pricing authority. If it and the
// skill's Python guards ever disagree, the correct resolution is the one that
// PARKS MORE. Widening this file to admit a card the Python guards would refuse
// is a money-safety defect; narrowing it so a card parks that need not have is
// merely an inconvenience the Captain can clear with one press.
//
// Contract, live shadow results and the residual this cannot cover:
// docs/evidence/ses-item10-rules-clean-shadow-2026-08-06.md

import {
  ROOF_REPORT_PRICING,
  roofReportPrice,
} from "./roof_report_template.ts";
import { AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST } from "./makesafe_existing_fence_pickets.ts";
import type {
  SesInvoiceAmbiguity,
  SesInvoiceDuplicateResolution,
} from "./makesafe_invoice_duplicate_resolver.ts";

/**
 * Bump on ANY change to what this module admits or refuses, so a past
 * determination stays attributable to the definition that produced it. A
 * recorded verdict without a version is not re-derivable.
 */
export const SES_RULES_CLEAN_CONTRACT_VERSION = "ses-rules-clean/v1";

export type SesRulesCleanFamily = "A" | "B" | "C";
export type SesRulesCleanGuardStatus = "clean" | "flagged" | "unevaluable";

/**
 * The CLOSED guard list. This list IS the definition of rules-clean, per the
 * spec: "This list is the definition, not an illustration of it."
 *
 * `classifySesInvoiceRulesClean` asserts that every id here produced an
 * outcome. A guard that silently fails to run cannot therefore be mistaken for
 * a guard that passed -- the sweep refuses instead.
 */
export const SES_RULES_CLEAN_GUARDS = [
  // ── A. Identity and duplication: "does this work already have an invoice?" ──
  {
    id: "A1_duplicate_resolver_all_tiers",
    family: "A",
    what: "The five-tier duplicate resolver returns no live match on any tier.",
  },
  {
    id: "A2_ambiguity_is_refusal",
    family: "A",
    what:
      "Every duplicate ambiguity state (multi_live, sibling_po, void_only, mirror_xero_mismatch) refuses.",
  },
  {
    id: "A3_builder_reference_present",
    family: "A",
    what:
      "A non-empty canonical builder reference exists; the reference tiers are inert without one.",
  },
  {
    id: "A4_full_accrec_scan",
    family: "A",
    what:
      "The full live-ACCREC estate scan ran and found no invoice for this work.",
  },
  {
    id: "A5_subject_invoice_is_our_current_draft",
    family: "A",
    what:
      "If an invoice is already minted, it is a DRAFT bound to THIS card's current obligation revision.",
  },
  // ── B. Pricing: "is this money derived from sealed rules?" ──
  {
    id: "B1_pricing_basis_sealed",
    family: "B",
    what:
      "The proposal declares a sealed pricing basis this module can derive.",
  },
  {
    id: "B2_sealed_line_derivation",
    family: "B",
    what:
      "Every line matches, exactly, the line the sealed pricing law derives from this card's own declared facts.",
  },
  {
    id: "B3_company_labour_schedule",
    family: "B",
    what:
      "Labour is the sealed per-trade-hour rate for the builder, with positive trades and per-trade hours.",
  },
  {
    id: "B4_attendance_hours_floor",
    family: "B",
    what:
      "Billable hours per trade sit at or above the sealed builder floor, and the floor is the sealed one.",
  },
  {
    id: "B5_report_rate",
    family: "B",
    what:
      "A report card is priced at the sealed roof/assessment rate for its own classification.",
  },
  {
    id: "B6_nonzero",
    family: "B",
    what:
      "At least one line, no negative unit price, and a positive ex-GST total.",
  },
  {
    id: "B7_no_hand_pricing",
    family: "B",
    what:
      "No rate override, commercial quantity override or operator materials-charge decision on this money.",
  },
  {
    id: "B8_materials_rate_card_sealed",
    family: "B",
    what:
      "No materials-bearing line: item 08 has not sealed a materials rate card, so no guard can check one.",
  },
  // ── C. Evidence and readiness: "is the pack real?" ──
  {
    id: "C1_docket_ready_zero_blockers",
    family: "C",
    what:
      "A persisted pre-Xero docket revision reports zero blockers and pre_xero_docs_ready.",
  },
  {
    id: "C2_docket_bound_to_this_card_and_cycle",
    family: "C",
    what:
      "That docket belongs to THIS job and covers the card's current attendance cycle.",
  },
  {
    id: "C3_report_evidence_floor",
    family: "C",
    what:
      "The report evidence floor and photo completeness are independently proven, not self-vouched.",
  },
] as const satisfies ReadonlyArray<
  { id: string; family: SesRulesCleanFamily; what: string }
>;

export type SesRulesCleanGuardId = typeof SES_RULES_CLEAN_GUARDS[number]["id"];

export interface SesRulesCleanGuardOutcome {
  id: SesRulesCleanGuardId;
  family: SesRulesCleanFamily;
  status: SesRulesCleanGuardStatus;
  /** Operator-facing sentence. On a park this is what the card must show. */
  detail: string;
}

export interface SesRulesCleanVerdict {
  verdict: "rules_clean" | "parks";
  contract_version: string;
  job_id: string;
  job_number: string | null;
  guards: SesRulesCleanGuardOutcome[];
  /** Guard ids that flagged or could not evaluate, in list order. */
  parked_on: SesRulesCleanGuardId[];
  /** One sentence naming the guard that parked the card, for the board. */
  park_reason: string | null;
  /**
   * Always false. Auto-authorisation may never reach the send path; this key
   * exists so a consumer asserting "no send affordance" has something to
   * assert on, and so a future widening trips a test instead of a builder's
   * inbox.
   */
  authorises_send: false;
}

// ── Evidence input ─────────────────────────────────────────────────────────
//
// Every field is what a READ produced. `*_read_error` fields are how a caller
// says "this read failed" -- which parks, rather than being absorbed as absent.

export interface SesRulesCleanProposalLine {
  description?: unknown;
  quantity?: unknown;
  unit_price_ex_gst?: unknown;
  unit_price?: unknown;
  amount_ex_gst?: unknown;
  rate_override_approved?: unknown;
  rate_override_by?: unknown;
  rate_override_at?: unknown;
}

export interface SesRulesCleanProposal {
  basis?: unknown;
  builder_reference?: unknown;
  line_items?: unknown;
  subtotal_ex_gst?: unknown;
  trades?: unknown;
  storeys?: unknown;
  fence_only?: unknown;
  billable_hours_per_trade?: unknown;
  billable_hours_floor?: unknown;
  reported_hours_per_trade?: unknown;
  materials_charge?: unknown;
  commercial_quantity_override?: unknown;
}

export interface SesRulesCleanDocket {
  revision_id: string;
  job_id: string;
  stage?: unknown;
  state?: unknown;
  blockers?: unknown;
  pre_xero_docs_ready?: unknown;
  attendance_cycle_ids?: unknown;
  local_invoice_proposal?: SesRulesCleanProposal | null;
}

export interface SesRulesCleanEvidence {
  job_id: string;
  job_number?: string | null;
  /** SES family id from the matrix; drives the sealed attendance floor. */
  family?: string | null;

  docket: SesRulesCleanDocket | null;
  docket_read_error?: string | null;
  /** The card's own current attendance cycle, from the board read model. */
  current_attendance_cycle_id?: string | null;

  /** The reference the mint would actually carry (claim plus PO where known). */
  composed_reference?: string | null;
  duplicate: SesInvoiceDuplicateResolution | null;
  duplicate_read_error?: string | null;
  /**
   * The skill-side full live-ACCREC estate scan. `matches` counts invoices the
   * scan attributed to this work. An absent scan is unevaluable, never clean:
   * the indexed probe is a different, narrower question.
   */
  full_accrec_scan?: { rows_scanned: number; matches: number } | null;
  full_accrec_scan_error?: string | null;

  /** Existing obligation revision, if the card already has one. */
  obligation?: {
    revision_id: string;
    state?: unknown;
    pricing_disposition?: unknown;
  } | null;
  obligation_read_error?: string | null;

  /**
   * THE MONEY THIS DETERMINATION IS ABOUT, and where it was read from.
   *
   * Before a mint that is the docket's `local_invoice_proposal.line_items`.
   * After one it is the bound obligation revision's `proposal.lines`, because
   * that is what the Xero invoice actually carries -- and the two can legally
   * differ (a Captain rate override lives on the obligation and never touches
   * the docket). Classifying the docket while authorising the obligation would
   * check money nobody is about to bill.
   *
   * The sealed DERIVATION still comes from the docket, which is the only place
   * the declared facts (basis, trades, hours, storeys) live. So B2 compares a
   * derivation from the docket against the lines from here; when they are two
   * different rows, a disagreement is exactly the flag it should be.
   *
   * Absent means "use the docket proposal's own line items".
   */
  priced_lines?: SesRulesCleanProposalLine[] | null;
  priced_lines_source?:
    | "docket_local_invoice_proposal"
    | "invoice_obligation_revision"
    | null;
  priced_lines_read_error?: string | null;
  /** Captain commercial-quantity provenance stamped on the priced proposal. */
  commercial_quantity_override?: unknown;

  /**
   * The invoice this determination is ABOUT, when one has already been minted.
   *
   * This exists because "does this work already have an invoice?" has two
   * different answers depending on WHEN it is asked. Before the mint there is
   * no invoice and any live money on the card is a duplicate. After the mint,
   * the card's own DRAFT is on the card -- and that DRAFT is the very thing
   * being authorised, not a duplicate of it. A classifier that cannot tell
   * those apart either refuses every post-mint card (useless) or waves through
   * a second invoice (dangerous).
   *
   * The caller MUST have removed exactly this invoice from the rows it fed the
   * duplicate resolver and the full-ACCREC scan, and nothing else. Leave this
   * absent for a pre-mint determination, where nothing is excluded.
   */
  subject_invoice?: {
    xero_invoice_id?: unknown;
    invoice_number?: unknown;
    status?: unknown;
    invoice_obligation_revision_id?: unknown;
  } | null;

  /**
   * Independent completeness proof for the supporting report, per
   * `inspectSesSupportingReportProof`. `null` means the caller could not
   * establish it -- which parks, and is how the two open readiness gaps
   * (docket-readiness-photo-completeness-v1, tuart-self-vouch-completeness-gate-v1)
   * have their card classes excluded rather than trusted.
   */
  report_evidence_independent?: boolean | null;
  report_evidence_read_error?: string | null;
}

// ── Sealed pricing law, imported never copied ──────────────────────────────

/** AJS/AJBR bill $80 ex per trade-hour; everyone else on the labour bases $85. */
const SEALED_LABOUR_RATE_EX_GST: Record<string, number> = {
  ajs_labour_materials: 80,
  ajs_temporary_fence_labour_only: 80,
  standard_labour_materials: 85,
};

/** Sealed assessment prices (ses_prepare_docket_revision assessment_fixed). */
const ASSESSMENT_EX_GST = 150;
const ASSESSMENT_FENCE_ONLY_EX_GST = 130;

/**
 * The bases this module can derive a sealed proposal for. A basis absent from
 * this map is `unevaluable` at B1 and parks -- notably every temporary-fencing
 * hire basis, whose pricing inputs have a reader and no producer.
 */
const DERIVABLE_BASES = new Set<string>([
  "roof_storey_fixed",
  "assessment_fixed",
  "ajs_labour_materials",
  "standard_labour_materials",
]);

/** Mirrors `attendanceLineSubject` in ses_prepare_docket_revision.ts. */
function attendanceSubject(family: string | null | undefined): string | null {
  switch (String(family || "")) {
    case "temporary_fencing":
      return "temporary fencing make-safe";
    case "repair":
      return "repair attendance";
    case "restoration":
      return "restoration attendance";
    case "makesafe":
    case "physical_makesafe":
    case "own_template_roof":
    case "portal_roof":
    case "assessment":
      return "make-safe attendance";
    default:
      // An unrecognised family cannot derive the builder-facing wording, so the
      // derivation is refused rather than guessed.
      return null;
  }
}

/** Sealed attendance floor: temp-fencing solo 4h, AJS 2h, otherwise 3h. */
function sealedHoursFloor(
  basis: string,
  family: string | null | undefined,
  trades: number,
): number {
  if (String(family || "") === "temporary_fencing" && trades === 1) return 4;
  return SEALED_LABOUR_RATE_EX_GST[basis] === 80 ? 2 : 3;
}

// ── Small total helpers. Every one refuses rather than coercing. ───────────

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function money(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function lineUnitPrice(line: SesRulesCleanProposalLine): number | null {
  // The docket proposal writes `unit_price_ex_gst`; the obligation copies it to
  // `unit_price`. Accept either, refuse if they disagree.
  const a = finiteNumber(line.unit_price_ex_gst);
  const b = finiteNumber(line.unit_price);
  if (a !== null && b !== null) return money(a, b) ? a : null;
  return a ?? b;
}

function proposalLines(
  proposal: SesRulesCleanProposal | null | undefined,
): SesRulesCleanProposalLine[] | null {
  if (!proposal) return null;
  return Array.isArray(proposal.line_items)
    ? proposal.line_items as SesRulesCleanProposalLine[]
    : null;
}

/** A line whose wording is a recorded materials charge rather than labour. */
function isMaterialsLine(description: string): boolean {
  return /materials\s+used\s*:/i.test(description);
}

function isStarPicketLine(description: string): boolean {
  return /star\s*pickets?\b/i.test(description);
}

// ── The sealed derivation (the whitelist) ─────────────────────────────────

interface SealedLine {
  description: string;
  quantity: number;
  unit_price_ex_gst: number;
}

interface SealedDerivation {
  lines: SealedLine[] | null;
  /** Why the sealed shape could not be derived. Non-null means UNEVALUABLE. */
  undeterminable: string | null;
}

/**
 * Re-derive the exact line set the sealed pricing law produces for this card's
 * own declared facts. Anything the law would not have produced is not in here,
 * so B2's equality test refuses it -- including shapes nobody has seen yet.
 */
export function deriveSealedProposal(
  proposal: SesRulesCleanProposal,
  family: string | null | undefined,
): SealedDerivation {
  const basis = text(proposal.basis);
  const ref = text(proposal.builder_reference);
  if (!basis) {
    return {
      lines: null,
      undeterminable: "the proposal declares no pricing basis",
    };
  }
  if (!DERIVABLE_BASES.has(basis)) {
    return {
      lines: null,
      undeterminable:
        `pricing basis ${basis} has no sealed derivation in this module`,
    };
  }
  if (!ref) {
    return {
      lines: null,
      undeterminable: "the proposal carries no builder reference",
    };
  }

  if (basis === "roof_storey_fixed") {
    let priced;
    try {
      priced = roofReportPrice(proposal.storeys);
    } catch {
      return {
        lines: null,
        undeterminable:
          "the roof card declares no explicit single/double storey classification",
      };
    }
    return {
      lines: [{
        description: `${ref} - ${priced.storey_label} roof report`,
        quantity: 1,
        unit_price_ex_gst: priced.ex_gst,
      }],
      undeterminable: null,
    };
  }

  if (basis === "assessment_fixed") {
    if (typeof proposal.fence_only !== "boolean") {
      return {
        lines: null,
        undeterminable:
          "the assessment card does not state whether the scope is fence-only",
      };
    }
    const ex = proposal.fence_only
      ? ASSESSMENT_FENCE_ONLY_EX_GST
      : ASSESSMENT_EX_GST;
    return {
      lines: [{
        description: `${ref} - ${
          proposal.fence_only ? "Fence-only " : ""
        }assessment report and quote`,
        quantity: 1,
        unit_price_ex_gst: ex,
      }],
      undeterminable: null,
    };
  }

  // Labour bases.
  const subject = attendanceSubject(family);
  if (subject === null) {
    return {
      lines: null,
      undeterminable: `SES family ${
        text(family) || "<absent>"
      } has no sealed attendance wording`,
    };
  }
  const trades = finiteNumber(proposal.trades);
  const billable = finiteNumber(proposal.billable_hours_per_trade);
  const reported = finiteNumber(proposal.reported_hours_per_trade);
  if (trades === null || !Number.isInteger(trades) || trades < 1) {
    return {
      lines: null,
      undeterminable: "the proposal declares no positive whole trade count",
    };
  }
  if (billable === null || billable <= 0) {
    return {
      lines: null,
      undeterminable:
        "the proposal declares no positive billable hours per trade",
    };
  }
  if (reported === null || reported <= 0) {
    return {
      lines: null,
      undeterminable:
        "the proposal records no positive reported hours per trade, so the floor cannot be re-derived",
    };
  }
  const floor = sealedHoursFloor(basis, family, trades);
  const expectedBillable = Math.max(reported, floor);
  if (!money(billable, expectedBillable)) {
    // Not `undeterminable`: the facts are all present and they disagree with
    // the sealed law. That is a FLAG, expressed as a derivation the caller's
    // equality test will refuse.
    return {
      lines: [],
      undeterminable: null,
    };
  }
  const rate = SEALED_LABOUR_RATE_EX_GST[basis];
  const lines: SealedLine[] = [{
    description: `${ref} - ${subject} - ${trades} trade${
      trades === 1 ? "" : "s"
    } x ${billable} hours`,
    quantity: trades * billable,
    unit_price_ex_gst: rate,
  }];
  return { lines, undeterminable: null };
}

// ── The sweep ─────────────────────────────────────────────────────────────

type Outcomes = Map<SesRulesCleanGuardId, SesRulesCleanGuardOutcome>;

function record(
  outcomes: Outcomes,
  id: SesRulesCleanGuardId,
  status: SesRulesCleanGuardStatus,
  detail: string,
): void {
  if (outcomes.has(id)) return; // first answer wins; a guard is answered once
  const spec = SES_RULES_CLEAN_GUARDS.find((guard) => guard.id === id)!;
  outcomes.set(id, { id, family: spec.family, status, detail });
}

/** Mark every still-unanswered guard unevaluable for one stated reason. */
function unevaluableRest(
  outcomes: Outcomes,
  ids: readonly SesRulesCleanGuardId[],
  reason: string,
): void {
  for (const id of ids) record(outcomes, id, "unevaluable", reason);
}

const AMBIGUITY_REFUSALS: SesInvoiceAmbiguity[] = [
  "multi_live",
  "sibling_po",
  "void_only",
  "mirror_xero_mismatch",
];

function classifyFamilyA(
  evidence: SesRulesCleanEvidence,
  outcomes: Outcomes,
): void {
  const reference = text(evidence.composed_reference);
  record(
    outcomes,
    "A3_builder_reference_present",
    reference ? "clean" : "flagged",
    reference
      ? `Builder reference ${reference} is present, so the reference duplicate tiers can see.`
      : "This card has no canonical builder reference, so every reference duplicate tier is inert.",
  );

  if (evidence.duplicate_read_error) {
    const reason =
      `The duplicate guard could not read the invoice mirror (${evidence.duplicate_read_error}).`;
    record(outcomes, "A1_duplicate_resolver_all_tiers", "unevaluable", reason);
    record(outcomes, "A2_ambiguity_is_refusal", "unevaluable", reason);
  } else if (!evidence.duplicate) {
    const reason = "No duplicate resolution was supplied for this card.";
    record(outcomes, "A1_duplicate_resolver_all_tiers", "unevaluable", reason);
    record(outcomes, "A2_ambiguity_is_refusal", "unevaluable", reason);
  } else {
    const duplicate = evidence.duplicate;
    const matched = duplicate.match_tier !== null ||
      duplicate.live_invoices.length > 0 || duplicate.allows_create !== true;
    record(
      outcomes,
      "A1_duplicate_resolver_all_tiers",
      matched ? "flagged" : "clean",
      matched
        ? `The duplicate resolver matched live money on tier ${
          duplicate.match_tier ?? "none"
        } (${duplicate.live_invoices.length} live invoice(s); reasons: ${
          duplicate.reason_codes.join(", ") || "none"
        }).`
        : "The five-tier duplicate resolver found no live invoice for this work.",
    );
    const ambiguous = AMBIGUITY_REFUSALS.includes(duplicate.ambiguity);
    record(
      outcomes,
      "A2_ambiguity_is_refusal",
      ambiguous ? "flagged" : "clean",
      ambiguous
        ? `The duplicate probe recorded ambiguity ${duplicate.ambiguity}; an ambiguity refuses, it never warns.`
        : "The duplicate probe recorded no ambiguity.",
    );
  }

  if (evidence.full_accrec_scan_error) {
    record(
      outcomes,
      "A4_full_accrec_scan",
      "unevaluable",
      `The full live-ACCREC estate scan could not run (${evidence.full_accrec_scan_error}).`,
    );
  } else if (!evidence.full_accrec_scan) {
    record(
      outcomes,
      "A4_full_accrec_scan",
      "unevaluable",
      "No full live-ACCREC estate scan was supplied; the indexed probe answers a narrower question and cannot stand in for it.",
    );
  } else {
    const matches = evidence.full_accrec_scan.matches;
    record(
      outcomes,
      "A4_full_accrec_scan",
      matches > 0 ? "flagged" : "clean",
      matches > 0
        ? `The full live-ACCREC scan attributed ${matches} existing invoice(s) to this work across ${evidence.full_accrec_scan.rows_scanned} scanned rows.`
        : `The full live-ACCREC scan found no invoice for this work across ${evidence.full_accrec_scan.rows_scanned} scanned rows.`,
    );
  }

  const subject = evidence.subject_invoice ?? null;
  if (!subject) {
    record(
      outcomes,
      "A5_subject_invoice_is_our_current_draft",
      "clean",
      "No invoice has been minted yet, so nothing was excluded from the duplicate question.",
    );
  } else {
    const status = text(subject.status).toUpperCase();
    const bound = text(subject.invoice_obligation_revision_id);
    const current = text(evidence.obligation?.revision_id);
    const faults: string[] = [];
    if (status !== "DRAFT") {
      faults.push(
        `it is ${
          status || "of unknown status"
        }, and only a DRAFT is a thing this automation may advance`,
      );
    }
    if (!current) {
      faults.push(
        "this card has no current invoice obligation revision to bind it to",
      );
    } else if (bound !== current) {
      faults.push(
        "it is not bound to this card's current obligation revision, so excluding it from the duplicate question would hide someone else's money",
      );
    }
    record(
      outcomes,
      "A5_subject_invoice_is_our_current_draft",
      faults.length > 0 ? "flagged" : "clean",
      faults.length > 0
        ? `The invoice this determination excluded from the duplicate question is not this card's own current DRAFT: ${
          faults.join("; ")
        }.`
        : "The invoice under consideration is this card's own DRAFT, bound to its current obligation revision, and it alone was excluded from the duplicate question.",
    );
  }
}

const FAMILY_B_IDS: readonly SesRulesCleanGuardId[] = [
  "B1_pricing_basis_sealed",
  "B2_sealed_line_derivation",
  "B3_company_labour_schedule",
  "B4_attendance_hours_floor",
  "B5_report_rate",
  "B6_nonzero",
  "B7_no_hand_pricing",
  "B8_materials_rate_card_sealed",
];

function classifyFamilyB(
  evidence: SesRulesCleanEvidence,
  outcomes: Outcomes,
): void {
  const proposal = evidence.docket?.local_invoice_proposal ?? null;
  if (evidence.priced_lines_read_error) {
    unevaluableRest(
      outcomes,
      FAMILY_B_IDS,
      `The priced lines could not be read (${evidence.priced_lines_read_error}).`,
    );
    return;
  }
  const lines = evidence.priced_lines ?? proposalLines(proposal);
  const linesSource = evidence.priced_lines
    ? (evidence.priced_lines_source ?? "invoice_obligation_revision")
    : "docket_local_invoice_proposal";
  if (!proposal || !lines) {
    unevaluableRest(
      outcomes,
      FAMILY_B_IDS,
      "No persisted local invoice proposal exists for this card, so no pricing guard can run.",
    );
    return;
  }

  // B7 first: hand pricing is decided by markers, not by the numbers, and it
  // must be answered even when a later guard cannot evaluate.
  const overrideLines = lines.filter((line) =>
    line.rate_override_approved === true ||
    text(line.rate_override_by) !== "" || text(line.rate_override_at) !== ""
  );
  const commercial = proposal.commercial_quantity_override != null ||
    evidence.commercial_quantity_override != null;
  const materialsDecision = proposal.materials_charge != null;
  const handPriced = overrideLines.length > 0 || commercial ||
    materialsDecision;
  record(
    outcomes,
    "B7_no_hand_pricing",
    handPriced ? "flagged" : "clean",
    handPriced
      ? `This money is hand-priced (${
        [
          overrideLines.length > 0 ? "a line carries a rate override" : null,
          commercial
            ? "a Captain commercial quantity override is stamped"
            : null,
          materialsDecision
            ? "an operator materials-charge decision is stamped"
            : null,
        ].filter(Boolean).join("; ")
      }); hand-priced invoices park for the Captain's press.`
      : "No rate override, commercial quantity override or materials-charge decision is stamped on this money.",
  );

  // B6 nonzero.
  const nonZeroFaults: string[] = [];
  if (lines.length < 1) nonZeroFaults.push("the proposal has no line items");
  let total = 0;
  for (const [index, line] of lines.entries()) {
    const price = lineUnitPrice(line);
    const quantity = finiteNumber(line.quantity);
    if (price === null) {
      nonZeroFaults.push(`line ${index + 1} has no single numeric unit price`);
      continue;
    }
    if (price < 0) {
      nonZeroFaults.push(`line ${index + 1} has a negative unit price`);
    }
    if (quantity === null) {
      nonZeroFaults.push(`line ${index + 1} has a non-numeric quantity`);
      continue;
    }
    total += price * quantity;
  }
  if (nonZeroFaults.length === 0 && total <= 0) {
    nonZeroFaults.push("the ex-GST total is not positive");
  }
  record(
    outcomes,
    "B6_nonzero",
    nonZeroFaults.length > 0 ? "flagged" : "clean",
    nonZeroFaults.length > 0
      ? `The invoice shape is not billable: ${nonZeroFaults.join("; ")}.`
      : "The proposal has priced lines and a positive ex-GST total.",
  );

  // B8 materials. Every line that is neither the sealed labour line nor a
  // sealed report line is materials-bearing, and item 08 has not sealed a
  // materials rate card, so no guard can check the number against anything.
  const materialsLines = lines.filter((line) => {
    const description = text(line.description);
    return isMaterialsLine(description) || isStarPicketLine(description);
  });
  record(
    outcomes,
    "B8_materials_rate_card_sealed",
    materialsLines.length > 0 ? "flagged" : "clean",
    materialsLines.length > 0
      ? `This invoice carries ${materialsLines.length} materials-bearing line(s). Item 08 has not sealed a materials rate card, so no guard can check the figure; materials-bearing cards park until it lands.`
      : "This invoice carries no materials-bearing line.",
  );

  // B1 basis.
  const basis = text(proposal.basis);
  const derivable = basis !== "" && DERIVABLE_BASES.has(basis);
  record(
    outcomes,
    "B1_pricing_basis_sealed",
    derivable ? "clean" : "unevaluable",
    derivable
      ? `Pricing basis ${basis} has a sealed derivation.`
      : `Pricing basis ${
        basis || "<absent>"
      } has no sealed derivation in this module, so its money cannot be checked against sealed rules.`,
  );

  // B2 the whitelist: the sealed derivation must reproduce the lines exactly.
  const derived = deriveSealedProposal(proposal, evidence.family);
  if (!derivable) {
    unevaluableRest(
      outcomes,
      [
        "B2_sealed_line_derivation",
        "B3_company_labour_schedule",
        "B4_attendance_hours_floor",
        "B5_report_rate",
      ],
      `Pricing basis ${
        basis || "<absent>"
      } has no sealed derivation, so the sealed line comparison cannot run.`,
    );
  } else if (derived.undeterminable) {
    unevaluableRest(
      outcomes,
      [
        "B2_sealed_line_derivation",
        "B3_company_labour_schedule",
        "B4_attendance_hours_floor",
        "B5_report_rate",
      ],
      `The sealed line set could not be derived: ${derived.undeterminable}.`,
    );
  } else {
    const expected = derived.lines ?? [];
    // Only the sealed lines are compared here; a materials line is already a
    // B8 flag, and comparing it would say the same thing twice in different
    // words. Every OTHER unexpected line is a B2 refusal.
    const actual = lines.filter((line) => {
      const description = text(line.description);
      return !isMaterialsLine(description) && !isStarPicketLine(description);
    });
    const mismatches: string[] = [];
    if (actual.length !== expected.length) {
      mismatches.push(
        `the sealed law derives ${expected.length} line(s) and the proposal carries ${actual.length}`,
      );
    }
    for (const [index, want] of expected.entries()) {
      const got = actual[index];
      if (!got) continue;
      const gotDescription = text(got.description);
      const gotQuantity = finiteNumber(got.quantity);
      const gotPrice = lineUnitPrice(got);
      if (gotDescription !== want.description) {
        mismatches.push(
          `line ${
            index + 1
          } wording is not the sealed wording (sealed: "${want.description}")`,
        );
      }
      if (gotQuantity === null || !money(gotQuantity, want.quantity)) {
        mismatches.push(
          `line ${index + 1} quantity is ${
            gotQuantity ?? "non-numeric"
          }, sealed derivation is ${want.quantity}`,
        );
      }
      if (gotPrice === null || !money(gotPrice, want.unit_price_ex_gst)) {
        mismatches.push(
          `line ${index + 1} unit price is ${
            gotPrice ?? "non-numeric"
          } ex, sealed rate is ${want.unit_price_ex_gst} ex`,
        );
      }
    }
    record(
      outcomes,
      "B2_sealed_line_derivation",
      mismatches.length > 0 ? "flagged" : "clean",
      mismatches.length > 0
        ? `The priced lines (read from ${linesSource}) are not the ones the sealed law derives from the docket's declared facts: ${
          mismatches.join("; ")
        }.`
        : `Every priced line (read from ${linesSource}) reproduces, exactly, the line the sealed pricing law derives from this card's declared facts.`,
    );

    // B3/B4/B5 are the named halves of that derivation, reported separately so
    // a parked card can name the specific rule rather than "pricing".
    if (basis === "roof_storey_fixed" || basis === "assessment_fixed") {
      const want = expected[0];
      const got = actual[0];
      const gotPrice = got ? lineUnitPrice(got) : null;
      const sealed = want && gotPrice !== null &&
        money(gotPrice, want.unit_price_ex_gst);
      record(
        outcomes,
        "B5_report_rate",
        sealed ? "clean" : "flagged",
        sealed
          ? `The report is priced at the sealed $${want.unit_price_ex_gst} ex rate for its own classification.`
          : `The report is priced at ${
            gotPrice === null ? "no numeric rate" : `$${gotPrice} ex`
          }; the sealed rate for its own classification is $${
            want?.unit_price_ex_gst ?? "unknown"
          } ex (roof: $${ROOF_REPORT_PRICING.single.ex_gst} single / $${ROOF_REPORT_PRICING.double.ex_gst} double).`,
      );
      record(
        outcomes,
        "B3_company_labour_schedule",
        "clean",
        "A fixed-price report card carries no labour line, so the labour schedule does not apply.",
      );
      record(
        outcomes,
        "B4_attendance_hours_floor",
        "clean",
        "A fixed-price report card carries no attendance hours.",
      );
    } else {
      const want = expected[0];
      const got = actual[0];
      const gotPrice = got ? lineUnitPrice(got) : null;
      const rateSealed = want && gotPrice !== null &&
        money(gotPrice, want.unit_price_ex_gst);
      record(
        outcomes,
        "B3_company_labour_schedule",
        rateSealed ? "clean" : "flagged",
        rateSealed
          ? `Labour is billed at the sealed $${want.unit_price_ex_gst} ex per trade-hour for this builder.`
          : `Labour is billed at ${
            gotPrice === null ? "no numeric rate" : `$${gotPrice} ex`
          } per trade-hour; the sealed rate for basis ${basis} is $${
            SEALED_LABOUR_RATE_EX_GST[basis]
          } ex.`,
      );
      const trades = finiteNumber(proposal.trades) ?? 0;
      const billable = finiteNumber(proposal.billable_hours_per_trade);
      const declaredFloor = finiteNumber(proposal.billable_hours_floor);
      const sealedFloor = sealedHoursFloor(basis, evidence.family, trades);
      const floorFaults: string[] = [];
      if (declaredFloor === null || !money(declaredFloor, sealedFloor)) {
        floorFaults.push(
          `the proposal declares a ${
            declaredFloor ?? "missing"
          }-hour floor where the sealed floor is ${sealedFloor}`,
        );
      }
      if (billable === null || billable + 0.005 < sealedFloor) {
        floorFaults.push(
          `it bills ${
            billable ?? "no"
          } hours per trade, below the ${sealedFloor}-hour sealed floor`,
        );
      }
      record(
        outcomes,
        "B4_attendance_hours_floor",
        floorFaults.length > 0 ? "flagged" : "clean",
        floorFaults.length > 0
          ? `The attendance hours do not sit on the sealed floor: ${
            floorFaults.join("; ")
          }.`
          : `Billable hours per trade sit at or above the sealed ${sealedFloor}-hour floor.`,
      );
      record(
        outcomes,
        "B5_report_rate",
        "clean",
        "This is not a fixed-price report card, so the report rate does not apply.",
      );
    }
  }
}

const FAMILY_C_IDS: readonly SesRulesCleanGuardId[] = [
  "C1_docket_ready_zero_blockers",
  "C2_docket_bound_to_this_card_and_cycle",
  "C3_report_evidence_floor",
];

function classifyFamilyC(
  evidence: SesRulesCleanEvidence,
  outcomes: Outcomes,
): void {
  if (evidence.docket_read_error) {
    unevaluableRest(
      outcomes,
      FAMILY_C_IDS,
      `The docket revision could not be read (${evidence.docket_read_error}).`,
    );
    return;
  }
  const docket = evidence.docket;
  if (!docket) {
    unevaluableRest(
      outcomes,
      FAMILY_C_IDS,
      "No persisted pre-Xero docket revision exists for this card, so its pack cannot be shown to be real.",
    );
    return;
  }
  const blockers = Array.isArray(docket.blockers) ? docket.blockers : null;
  const readyFaults: string[] = [];
  if (text(docket.stage) !== "pre_xero") {
    readyFaults.push(
      `the current docket stage is ${
        text(docket.stage) || "<absent>"
      }, not pre_xero`,
    );
  }
  if (text(docket.state) !== "ready") {
    readyFaults.push(
      `the current docket state is ${
        text(docket.state) || "<absent>"
      }, not ready`,
    );
  }
  if (blockers === null) {
    readyFaults.push("the docket carries no readable blocker list");
  } else if (blockers.length > 0) {
    readyFaults.push(`the docket carries ${blockers.length} blocker(s)`);
  }
  if (docket.pre_xero_docs_ready !== true) {
    readyFaults.push("pre_xero_docs_ready is not true");
  }
  record(
    outcomes,
    "C1_docket_ready_zero_blockers",
    readyFaults.length > 0 ? "flagged" : "clean",
    readyFaults.length > 0
      ? `The persisted docket is not a zero-blocker ready pre-Xero pack: ${
        readyFaults.join("; ")
      }.`
      : "The persisted pre-Xero docket reports zero blockers and pre_xero_docs_ready.",
  );

  const bindFaults: string[] = [];
  if (docket.job_id !== evidence.job_id) {
    bindFaults.push("the docket belongs to a different job");
  }
  const cycles = Array.isArray(docket.attendance_cycle_ids)
    ? docket.attendance_cycle_ids.map((value) => String(value))
    : null;
  const current = text(evidence.current_attendance_cycle_id);
  if (cycles === null) {
    bindFaults.push("the docket carries no readable attendance cycle list");
  } else if (!current) {
    bindFaults.push("the card's current attendance cycle is not known");
  } else if (!cycles.includes(current)) {
    bindFaults.push(
      "the docket does not cover the card's current attendance cycle",
    );
  }
  record(
    outcomes,
    "C2_docket_bound_to_this_card_and_cycle",
    bindFaults.length > 0 ? "flagged" : "clean",
    bindFaults.length > 0
      ? `The docket is not bound to this card and this attendance cycle: ${
        bindFaults.join("; ")
      }.`
      : "The docket belongs to this job and covers its current attendance cycle.",
  );

  if (evidence.report_evidence_read_error) {
    record(
      outcomes,
      "C3_report_evidence_floor",
      "unevaluable",
      `The supporting report's independence proof could not be read (${evidence.report_evidence_read_error}).`,
    );
  } else if (evidence.report_evidence_independent !== true) {
    // The two open readiness gaps live exactly here. Until they close, a card
    // whose completeness is not INDEPENDENTLY proven is excluded by name.
    record(
      outcomes,
      "C3_report_evidence_floor",
      evidence.report_evidence_independent === false
        ? "flagged"
        : "unevaluable",
      evidence.report_evidence_independent === false
        ? "The supporting report self-vouches its own completeness; an incomplete pack can pass the readiness read (tuart-self-vouch-completeness-gate-v1, docket-readiness-photo-completeness-v1), so this card class is excluded from automation."
        : "No independent completeness proof was supplied for the supporting report, and the two open readiness gaps mean an unproven pack must not be read as a complete one.",
    );
  } else {
    record(
      outcomes,
      "C3_report_evidence_floor",
      "clean",
      "The supporting report carries an independent completeness proof.",
    );
  }
}

/**
 * The one determination. `rules_clean` requires every guard on the closed list
 * to have been evaluated and returned `clean`. There is no other way out.
 */
export function classifySesInvoiceRulesClean(
  evidence: SesRulesCleanEvidence,
): SesRulesCleanVerdict {
  const outcomes: Outcomes = new Map();
  classifyFamilyA(evidence, outcomes);
  classifyFamilyB(evidence, outcomes);
  classifyFamilyC(evidence, outcomes);

  const guards: SesRulesCleanGuardOutcome[] = SES_RULES_CLEAN_GUARDS.map(
    (spec) =>
      outcomes.get(spec.id) ?? {
        id: spec.id,
        family: spec.family,
        status: "unevaluable" as const,
        // A guard that produced no outcome is a defect in this file, and it
        // resolves to a park. It can never resolve to clean.
        detail:
          `Guard ${spec.id} produced no outcome, which is treated as off-rules.`,
      },
  );
  const parkedOn = guards.filter((guard) => guard.status !== "clean").map((
    guard,
  ) => guard.id);
  const first = guards.find((guard) => guard.status !== "clean") ?? null;
  return {
    verdict: parkedOn.length === 0 ? "rules_clean" : "parks",
    contract_version: SES_RULES_CLEAN_CONTRACT_VERSION,
    job_id: evidence.job_id,
    job_number: evidence.job_number ?? null,
    guards,
    parked_on: parkedOn,
    park_reason: first
      ? `Waiting on the Captain's press: ${first.id} ${
        first.status === "flagged" ? "flagged" : "could not evaluate"
      }. ${first.detail}`
      : null,
    authorises_send: false,
  };
}

/** Only for a caller that needs the star-picket rate in a message. */
export const SES_RULES_CLEAN_SEALED_RATES = {
  labour: SEALED_LABOUR_RATE_EX_GST,
  roof: ROOF_REPORT_PRICING,
  assessment: {
    standard_ex_gst: ASSESSMENT_EX_GST,
    fence_only_ex_gst: ASSESSMENT_FENCE_ONLY_EX_GST,
  },
  ajs_existing_fence_star_picket_ex_gst:
    AJS_EXISTING_FENCE_STAR_PICKET_RATE_EX_GST,
} as const;
