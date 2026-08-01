// SES Phase C1 — the deterministic evidence ruler.
//
// This module is the codified form of the draft evidence-requirements contract
// (49 family x display-stage rows). It is deliberately PURE: it holds the
// requirement table plus a reader that grades one card's already-collected
// evidence inventory. It never queries, never writes, never moves a stage and
// never decides a Captain question.
//
// Two hard rules the rest of Phase C depends on:
//
//   1. A QUESTION cell is NEVER guessed. Where the governing sources conflict or
//      are silent, the cell stays `question`, the reader returns
//      `unresolved_question` for that item, and the card's verdict degrades to
//      `undetermined` rather than `fail`. Promoting a QUESTION cell to
//      required/optional/not-applicable requires a Captain ruling that answers
//      the named question in CAPTAIN_QUESTIONS, not a code change here.
//   2. A card that fails ONLY because of a question cell is undetermined. A real
//      `missing` on a `required` cell is what produces `fail`.
//
// Source of the table: the C1 draft contract
// `codex-evidence-ruler-draft-v1/report.md` sections 4.1-4.7 and 6, itself
// grounded in the backend evidence register [E1]-[E9], the Captain decision
// records [D1]-[D5] and the wiki blueprint [W1]-[W6]. Section anchors are
// repeated per family below so a maintainer can diff code against the draft.
//
// Rulings applied on top of the draft (rule 1 is how a QUESTION leaves this
// table, and each one is recorded here rather than silently absorbed):
//
//   - 2026-08-01, `po_floor` — SUPERSEDED, then re-ruled the same day. The first
//     answer ("of course every card needs a po") promoted the PO cell to
//     REQUIRED in all 49 rows. The Captain then clarified that the answer was
//     about WORK ORDERS: a purchase order is expected but its absence is not a
//     failure. The PO cell is therefore OPTIONAL in all 49 rows — still observed
//     and reported on every reading, never a gate. Both rulings are recorded on
//     `Q_PO_FLOOR.resolution` (the current one) and its `supersedes` chain (the
//     overturned one); the question stays out of `SES_CAPTAIN_QUESTIONS` and
//     `q()` still refuses to name it.
//   - 2026-08-01, work-order floor — "WORK ORDER: required on EVERY card, no
//     exceptions. We have nothing to invoice against without a work order."
//     `builder_wo_doc` was already REQUIRED at every live stage of the five
//     sealed families; this ruling extends it to `completed` and `archive`,
//     where the draft left it open under `terminal_evidence`. That question
//     stays OPEN for the other five columns — the ruling names work orders, not
//     reports, photos, SWMS or the terminal invoice.
//
// Deliberately NOT encoded here (2026-08-01 SWMS ruling, "SWMS required only for
// MLB make-safes"): the ruler's cells are family x stage and carry no builder
// identity, so an MLB-only rule cannot be expressed in this table at all. The
// builder-aware rule already lives, sealed, in `ses_family_matrix.ts` (MLB ->
// `always`, AJS -> `builder_waiver_unless_hrcw`, everyone else -> `hrcw_only`),
// which is exactly the plan-v2 C.11 reading "MLB always; everyone else only when
// the work is genuinely high-risk". `Q_REPORT_ONLY_SWMS` therefore stays OPEN
// pending C.11: flattening the high-risk-construction-work trigger to N-A by
// builder identity is a safety call, not a paperwork one, and it is not this
// batch's to make.

import {
  MAKESAFE_COMPUTED_STATUSES,
  type MakesafeComputedStatus,
} from "./makesafe_computed_status.ts";
import {
  canonicalSesFamilyFromCard,
  type SesFamilyId,
} from "./ses_family_matrix.ts";

export const SES_EVIDENCE_CONTRACT_VERSION =
  "ses-evidence-requirements/c1-wo-floor-po-optional-v4";

/**
 * The draft contract's source document. Recorded so a measurement run can prove
 * which ruler produced it without re-reading the ruler.
 */
export const SES_EVIDENCE_CONTRACT_SOURCE =
  "codex-evidence-ruler-draft-v1/report.md (DRAFT, not Captain-approved) " +
  "+ Captain rulings 2026-08-01 on the work-order floor and po_floor " +
  "(data/decisions/2026-08-01-po-wo-invoice-ruling.md)";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The seven canonical Ops display stages. Imported rather than restated so the
 * ruler can never drift from the board's own stage enum.
 */
export const SES_EVIDENCE_STAGES = MAKESAFE_COMPUTED_STATUSES;
export type SesEvidenceStage = MakesafeComputedStatus;

/**
 * The seven contract families. This is `SesFamilyId` minus `unknown`: `unknown`
 * is a refusal outcome, not a family, so it has no row in the matrix (draft §3).
 */
export const SES_EVIDENCE_FAMILIES = [
  "physical_makesafe",
  "temporary_fencing",
  "ordinary_roof_portal",
  "own_template_roof",
  "assessment_quote",
  "repair",
  "restoration",
] as const;
export type SesEvidenceFamily = (typeof SES_EVIDENCE_FAMILIES)[number];

/** The seven evidence columns of the draft matrix, in table order. */
export const SES_EVIDENCE_ITEMS = [
  "builder_wo_doc",
  "prime_link",
  "trade_report",
  "photos_media",
  "swms",
  "invoice",
  "po",
] as const;
export type SesEvidenceItem = (typeof SES_EVIDENCE_ITEMS)[number];

export const SES_EVIDENCE_ITEM_LABELS: Record<SesEvidenceItem, string> = {
  builder_wo_doc: "Builder work-order document",
  prime_link: "Prime typed link and locked/submitted capture",
  // One slot, two artifacts: the trade's service report for physical families,
  // and the SecureWorks roof PDF for own-document roof.
  trade_report: "Trade report, or the SecureWorks roof PDF",
  photos_media: "Family photo/media evidence",
  swms: "SWMS decision or artifact",
  // A card-unique UNLINKED issued ACCREC counts here too. `xero_invoices.job_id`
  // cannot be backfilled (the write-once SES money seal refuses `linked`), so
  // the matcher in `makesafe_invoice_reference_match.ts` supplies the evidence
  // instead. Ambiguous matches are withheld and the cell stays missing.
  invoice: "Invoice (draft at Docs Ready; issued ledger invoice at close-out)",
  // OPTIONAL in all 49 rows since the 2026-08-01 re-ruling (see `Q_PO_FLOOR`),
  // but never dropped: `observed_present`, `observed_count` and `detail` are
  // reported on every reading, so the PO stays visible without gating anything.
  po: "Builder purchase order (observed, never a gate)",
};

export type SesEvidenceRequirementLevel =
  | "required"
  | "optional"
  | "not_applicable"
  | "question";

export type SesEvidenceItemStatus =
  | "present"
  | "missing"
  | "not_required"
  | "unresolved_question";

export type SesEvidenceVerdict = "pass" | "fail" | "undetermined";

/**
 * Cheap transit discrimination. `lost_in_transit` means a submission/upload
 * record exists for evidence whose artifact does not — the trade app recorded an
 * upload but the media/document row is absent. Full transit forensics is C2's
 * job; this flag only distinguishes "never produced" from "produced and lost".
 */
export type SesEvidenceSignal = "none" | "lost_in_transit";

// ---------------------------------------------------------------------------
// Captain questions (draft §6)
// ---------------------------------------------------------------------------

export type SesCaptainQuestionId =
  | "po_floor"
  | "ghl_equivalence"
  | "report_ready_authority"
  | "terminal_evidence"
  | "report_only_swms"
  | "own_document_roof_report_in"
  | "repair_recipe"
  | "restoration_recipe"
  | "cancelled_floor";

/**
 * A Captain ruling that closes a question. Its presence is what moves a question
 * out of `SES_CAPTAIN_QUESTIONS`; the question constant itself is kept so a
 * measurement or audit can still resolve the id and read why the cells moved.
 */
export interface SesCaptainQuestionResolution {
  /** ISO date of the ruling. */
  ruled_on: string;
  /** The Captain's words, verbatim. */
  ruling: string;
  /** What the ruling changed in this table, in matrix terms. */
  effect: string;
  /**
   * Earlier rulings on this same question that this one overturned, oldest
   * first. A superseding ruling is recorded exactly the way the original was —
   * the whole point of this mechanism is that a ruling is RECORDED, never
   * silently absorbed, and that includes the ruling it replaced.
   */
  supersedes?: readonly SesSupersededCaptainRuling[];
}

/**
 * A ruling that no longer governs. Kept verbatim so a past measurement taken
 * under it stays attributable, alongside the date and reason it was replaced.
 */
export interface SesSupersededCaptainRuling {
  ruled_on: string;
  ruling: string;
  /** What this ruling did to the table while it governed. */
  effect: string;
  /** ISO date of the ruling that replaced it. */
  superseded_on: string;
  /** Why it no longer governs, in the Captain's terms. */
  superseded_reason: string;
}

export interface SesCaptainQuestion {
  id: SesCaptainQuestionId;
  title: string;
  /** The Captain question text, verbatim in substance from draft §6. */
  question: string;
  /** Evidence-register anchors from the draft that produced the conflict. */
  basis: readonly string[];
  /**
   * Set once the Captain has ruled. A resolved question is provenance only: it
   * may never gate a cell again, and `q()` throws if one is named.
   */
  resolution?: SesCaptainQuestionResolution;
}

/**
 * RESOLVED 2026-08-01, then RE-RULED the same day. Kept exported so the 49
 * OPTIONAL PO cells have a named, readable origin — and so the REQUIRED floor
 * that governed before it stays on the record rather than vanishing.
 */
export const Q_PO_FLOOR: SesCaptainQuestion = {
  id: "po_floor",
  title: "PO floor",
  question:
    "Is a builder PO required for every family, and if so from which stage? " +
    "Or is it an optional identity fact that must be stored separately whenever " +
    "present? The current Captain record says claim remains customer-visible and " +
    "PO is stored separately, but also records live cards with no PO.",
  basis: ["D5"],
  resolution: {
    ruled_on: "2026-08-01",
    ruling:
      "PURCHASE ORDER: NOT required. Expected to usually exist, but absence is " +
      "not a failure.",
    effect:
      "The `po` cell is OPTIONAL for every family at every display stage — all " +
      "49 rows, including the unsealed repair and restoration recipes. It stays " +
      "OBSERVED: every reading still reports `observed_present` and the " +
      "measured detail, so a purchase order remains visible on the card when " +
      "one exists. It is simply never a gate — a card with no builder PO reads " +
      "`not_required`, not `missing`, and the PO alone can no longer fail a " +
      "card. The work-order floor carries the obligation the first ruling was " +
      "actually about; see `builder_wo_doc`, REQUIRED at every stage of every " +
      "sealed family including `completed` and `archive`.",
    supersedes: [
      {
        ruled_on: "2026-08-01",
        ruling: "of course every card needs a po",
        effect:
          "Promoted the `po` cell to REQUIRED for every family at every " +
          "display stage — all 49 rows, no stage floor and no family " +
          "exemption. A card with no builder PO was a real `missing` on a " +
          "`required` cell and failed the ruler. Measured effect while it " +
          "governed: 359 of 388 measurable cards carried a `po` required-miss " +
          "and 364 of 407 cards read `fail`.",
        superseded_on: "2026-08-01",
        superseded_reason:
          "The Captain clarified the same day that the quick answer was about " +
          'WORK ORDERS, not purchase orders: "We have nothing to invoice ' +
          'against without a work order". A PO is expected to usually exist ' +
          "but its absence is not a failure. Recorded verbatim in " +
          "data/decisions/2026-08-01-po-wo-invoice-ruling.md.",
      },
    ],
  },
};

export const Q_GHL_EQUIVALENCE: SesCaptainQuestion = {
  id: "ghl_equivalence",
  title: "GHL equivalence",
  question:
    "Can any GHL link satisfy a Prime portal obligation? If yes, what typed " +
    "roles and locked/submitted screenshot proof make it equivalent? The " +
    "governing sources name Prime, not GHL.",
  basis: ["D1", "E5"],
};

export const Q_REPORT_READY_AUTHORITY: SesCaptainQuestion = {
  id: "report_ready_authority",
  title: "report_ready authority",
  question:
    "Should the ruler enforce the Captain's full-pack rule even when the current " +
    "board trusts READY/READY_TO_BUILD without rechecking every artifact? " +
    "Recommended answer: yes, because the Captain's audit-grade ruling is " +
    "explicit and the blueprint records the current lane as untruthful.",
  basis: ["D3", "W6"],
};

/**
 * STILL OPEN, but narrower than its text. The 2026-08-01 work-order ruling
 * ("required on EVERY card, no exceptions") answered the WO clause of this
 * question for the five sealed families, so `builder_wo_doc` is REQUIRED at
 * `completed` and `archive` and no longer names this question. The draft text is
 * kept verbatim; the remaining columns — family artifacts, photos, the SWMS
 * decision and the legacy-orphan exemption — are what is still unresolved.
 */
export const Q_TERMINAL_EVIDENCE: SesCaptainQuestion = {
  id: "terminal_evidence",
  title: "Terminal evidence and legacy exceptions",
  question:
    "For normal forward work, must completed/archive retain WO, family " +
    "artifacts, photos, SWMS decision and invoice proof? If historical sent/paid " +
    "orphans are exceptions, what explicit annotation exempts them without " +
    "weakening the forward rule? The current terminal-preservation code and " +
    "sixty-orphan decision hold leave this unresolved.",
  basis: ["D5", "E8"],
};

export const Q_REPORT_ONLY_SWMS: SesCaptainQuestion = {
  id: "report_only_swms",
  title: "Report-only SWMS",
  question:
    "Does HRCW always override family and builder waivers for roof and " +
    "assessment, or do the explicit 'Never a SWMS' / 'no SWMS, no additional " +
    "gate' rulings win for report-only jobs?",
  basis: ["D1", "E4", "W2"],
};

export const Q_OWN_DOCUMENT_ROOF_REPORT_IN: SesCaptainQuestion = {
  id: "own_document_roof_report_in",
  title: "Own-document roof report-in proof",
  question:
    "What evidence moves an own-document roof card into trade_report_in: " +
    "submitted trade-filled roof template, rendered SecureWorks Roof Report PDF, " +
    "or another durable event? The matrix forbids a portal deliverable, while " +
    "the current stage gate requires one.",
  basis: ["D2", "E4", "E5"],
};

/**
 * The draft text still names PO because it predates the 2026-08-01 rulings; it
 * is kept verbatim. The PO column is no longer part of what this question seals
 * — `po_floor` settled it for every family, as OPTIONAL — so this question now
 * covers the other six columns only, `builder_wo_doc` included: an unsealed
 * recipe is not a sealed family, and the work-order ruling promoted only the
 * cells the draft left open under `terminal_evidence`.
 */
export const Q_REPAIR_RECIPE: SesCaptainQuestion = {
  id: "repair_recipe",
  title: "Repair recipe",
  question:
    "Seal the quote-stage display location and the completed-repair report, " +
    "photo, SWMS, invoice and PO recipe. Until then all repair cells remain " +
    "QUESTION.",
  basis: ["E3", "W2"],
};

export const Q_RESTORATION_RECIPE: SesCaptainQuestion = {
  id: "restoration_recipe",
  title: "Restoration recipe",
  question:
    "Seal the intake authority and complete per-stage evidence/pack recipe. " +
    "Until then all restoration cells remain QUESTION.",
  basis: ["E3", "W2"],
};

export const Q_CANCELLED_FLOOR: SesCaptainQuestion = {
  id: "cancelled_floor",
  title: "Cancelled cards",
  question:
    "What minimum source/evidence must a displayed cancelled card retain, and " +
    "which family obligations become N-A after cancellation? Current code " +
    "preserves the terminal state without an evidence floor.",
  basis: ["E8"],
};

/**
 * The Captain questions the ruler has answers for. Provenance only — a resolved
 * question is unreachable from every cell (see `q()`), so it can never reappear
 * in a reading's `open_questions`.
 */
export const SES_RESOLVED_CAPTAIN_QUESTIONS: readonly SesCaptainQuestion[] = [
  Q_PO_FLOOR,
];

/** The eight still-open Captain questions, in draft §6 order. */
export const SES_CAPTAIN_QUESTIONS: readonly SesCaptainQuestion[] = [
  Q_GHL_EQUIVALENCE,
  Q_REPORT_READY_AUTHORITY,
  Q_TERMINAL_EVIDENCE,
  Q_REPORT_ONLY_SWMS,
  Q_OWN_DOCUMENT_ROOF_REPORT_IN,
  Q_REPAIR_RECIPE,
  Q_RESTORATION_RECIPE,
  Q_CANCELLED_FLOOR,
];

/** Every question the draft raised, open or ruled, in draft §6 order. */
export const SES_ALL_CAPTAIN_QUESTIONS: readonly SesCaptainQuestion[] = [
  Q_PO_FLOOR,
  ...SES_CAPTAIN_QUESTIONS,
];

const QUESTIONS_BY_ID = new Map<SesCaptainQuestionId, SesCaptainQuestion>(
  SES_ALL_CAPTAIN_QUESTIONS.map((question) => [question.id, question]),
);

export function sesCaptainQuestion(
  id: SesCaptainQuestionId,
): SesCaptainQuestion {
  const question = QUESTIONS_BY_ID.get(id);
  if (!question) throw new Error(`unknown Captain question: ${id}`);
  return question;
}

/**
 * Standing item-level questions. Unlike a QUESTION cell these do not change a
 * cell's requirement level; they qualify how an item may be satisfied at all.
 *
 * `prime_link` carries the GHL-equivalence question because the sources
 * establish Prime only (draft §3). A card whose ONLY portal evidence is a GHL
 * object therefore cannot be graded present or missing — see
 * `readSesCardEvidence`.
 */
export const SES_EVIDENCE_ITEM_STANDING_QUESTIONS: Partial<
  Record<SesEvidenceItem, readonly SesCaptainQuestionId[]>
> = {
  prime_link: ["ghl_equivalence"],
};

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export interface SesEvidenceRequirement {
  level: SesEvidenceRequirementLevel;
  /** Non-empty exactly when `level === "question"`. */
  questions: readonly SesCaptainQuestionId[];
}

const REQ: SesEvidenceRequirement = { level: "required", questions: [] };
const OPT: SesEvidenceRequirement = { level: "optional", questions: [] };
const NA: SesEvidenceRequirement = { level: "not_applicable", questions: [] };

function q(
  ...questions: readonly SesCaptainQuestionId[]
): SesEvidenceRequirement {
  if (questions.length === 0) {
    throw new Error("a question cell must name at least one Captain question");
  }
  for (const id of questions) {
    // A ruled question is settled. Re-opening a cell under it would quietly
    // undo the Captain's answer, so refuse it at table-construction time.
    const resolution = sesCaptainQuestion(id).resolution;
    if (resolution) {
      throw new Error(
        `Captain question "${id}" was resolved on ${resolution.ruled_on} ` +
          `("${resolution.ruling}") and cannot gate a cell`,
      );
    }
  }
  return { level: "question", questions };
}

/** One matrix row, in SES_EVIDENCE_ITEMS order. */
type StageRow = readonly [
  builder_wo_doc: SesEvidenceRequirement,
  prime_link: SesEvidenceRequirement,
  trade_report: SesEvidenceRequirement,
  photos_media: SesEvidenceRequirement,
  swms: SesEvidenceRequirement,
  invoice: SesEvidenceRequirement,
  po: SesEvidenceRequirement,
];

function stageRow(row: StageRow): Record<
  SesEvidenceItem,
  SesEvidenceRequirement
> {
  return {
    builder_wo_doc: row[0],
    prime_link: row[1],
    trade_report: row[2],
    photos_media: row[3],
    swms: row[4],
    invoice: row[5],
    po: row[6],
  };
}

/**
 * A family whose reporting recipe the Captain has not sealed. Every cell is open
 * under that family's recipe question EXCEPT `po`: the 2026-08-01 `po_floor`
 * ruling is family-independent ("not required"), so an unsealed recipe is
 * settled on that one column — as OPTIONAL, not as a floor.
 *
 * `builder_wo_doc` deliberately stays open here. The work-order ruling promotes
 * the cells the draft left open under `terminal_evidence`; an unsealed recipe is
 * a different kind of open, and sealing a recipe by code change is exactly what
 * rule 1 at the top of this file forbids.
 */
function unsealedFamily(
  recipe: SesCaptainQuestionId,
): Record<SesEvidenceStage, Record<SesEvidenceItem, SesEvidenceRequirement>> {
  const row = stageRow([
    q(recipe),
    q(recipe),
    q(recipe),
    q(recipe),
    q(recipe),
    q(recipe),
    OPT,
  ]);
  return {
    new: row,
    allocated: row,
    trade_report_in: row,
    report_ready: row,
    completed: row,
    archive: row,
    cancelled: row,
  };
}

/**
 * Physical make-safe (draft §4.1) and temporary fencing (draft §4.2) share the
 * same seven-column shape: temporary fencing inherits the physical row and SWMS
 * policy, and its family-specific fence/hire facts sit outside these columns.
 */
function physicalShapedFamily(): Record<
  SesEvidenceStage,
  Record<SesEvidenceItem, SesEvidenceRequirement>
> {
  return {
    new: stageRow([REQ, NA, OPT, OPT, OPT, OPT, OPT]),
    allocated: stageRow([REQ, NA, OPT, OPT, OPT, OPT, OPT]),
    trade_report_in: stageRow([REQ, NA, REQ, REQ, OPT, OPT, OPT]),
    report_ready: stageRow([
      REQ,
      NA,
      q("report_ready_authority"),
      q("report_ready_authority"),
      q("report_ready_authority"),
      q("report_ready_authority"),
      OPT,
    ]),
    completed: stageRow([
      REQ,
      NA,
      q("terminal_evidence"),
      q("terminal_evidence"),
      q("terminal_evidence"),
      REQ,
      OPT,
    ]),
    archive: stageRow([
      REQ,
      NA,
      q("terminal_evidence"),
      q("terminal_evidence"),
      q("terminal_evidence"),
      REQ,
      OPT,
    ]),
    cancelled: stageRow([
      q("cancelled_floor"),
      NA,
      q("cancelled_floor"),
      q("cancelled_floor"),
      q("cancelled_floor"),
      q("cancelled_floor"),
      OPT,
    ]),
  };
}

/**
 * The 49-row draft matrix: family -> Ops display stage -> evidence item.
 *
 * Cumulative by construction (draft §2): once an item is REQUIRED at a stage it
 * stays REQUIRED at later non-terminal stages unless a later cell is explicitly
 * QUESTION. `makesafe_evidence_requirements_test.ts` asserts this.
 */
export const SES_EVIDENCE_REQUIREMENTS: Record<
  SesEvidenceFamily,
  Record<SesEvidenceStage, Record<SesEvidenceItem, SesEvidenceRequirement>>
> = {
  // §4.1 General physical make-safe.
  physical_makesafe: physicalShapedFamily(),

  // §4.2 Temporary-fence make-safe. Same columns as physical; the fence-specific
  // completed-fence photographs and panel/hire facts are blockers OUTSIDE these
  // seven columns and are not silently folded into `photos_media`.
  temporary_fencing: physicalShapedFamily(),

  // §4.3 Ordinary roof report, Prime portal mode. The portal IS the report, so
  // trade report and photo/media evidence are N-A for the family.
  ordinary_roof_portal: {
    new: stageRow([REQ, OPT, NA, NA, OPT, OPT, OPT]),
    allocated: stageRow([REQ, OPT, NA, NA, OPT, OPT, OPT]),
    trade_report_in: stageRow([REQ, REQ, NA, NA, OPT, OPT, OPT]),
    report_ready: stageRow([
      REQ,
      REQ,
      NA,
      NA,
      q("report_only_swms"),
      q("report_ready_authority"),
      OPT,
    ]),
    completed: stageRow([
      REQ,
      q("terminal_evidence"),
      NA,
      NA,
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    archive: stageRow([
      REQ,
      q("terminal_evidence"),
      NA,
      NA,
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    cancelled: stageRow([
      q("cancelled_floor"),
      q("cancelled_floor"),
      NA,
      NA,
      q("report_only_swms", "cancelled_floor"),
      q("cancelled_floor"),
      OPT,
    ]),
  },

  // §4.4 Own-document roof report. `trade_report` is the SecureWorks roof PDF
  // slot here. The matrix forbids a portal deliverable while the current stage
  // gate requires one, so both the prime link and the report-in proof are open.
  own_template_roof: {
    new: stageRow([REQ, NA, OPT, NA, OPT, OPT, OPT]),
    allocated: stageRow([REQ, NA, OPT, NA, OPT, OPT, OPT]),
    trade_report_in: stageRow([
      REQ,
      q("own_document_roof_report_in"),
      q("own_document_roof_report_in"),
      NA,
      OPT,
      OPT,
      OPT,
    ]),
    report_ready: stageRow([
      REQ,
      q("own_document_roof_report_in"),
      REQ,
      NA,
      q("report_only_swms"),
      q("report_ready_authority"),
      OPT,
    ]),
    completed: stageRow([
      REQ,
      q("own_document_roof_report_in", "terminal_evidence"),
      q("terminal_evidence"),
      NA,
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    archive: stageRow([
      REQ,
      q("own_document_roof_report_in", "terminal_evidence"),
      q("terminal_evidence"),
      NA,
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    cancelled: stageRow([
      q("cancelled_floor"),
      q("own_document_roof_report_in", "cancelled_floor"),
      q("cancelled_floor"),
      NA,
      q("report_only_swms", "cancelled_floor"),
      q("cancelled_floor"),
      OPT,
    ]),
  },

  // §4.5 Assessment / quote. `photos_media` is the typed Prime photo-schedule
  // link and capture, NOT an extra local photo pack. SWMS is open at every stage
  // because the binding recipe says no SWMS while the matrix keeps an HRCW
  // override.
  assessment_quote: {
    new: stageRow([
      REQ,
      OPT,
      NA,
      OPT,
      q("report_only_swms"),
      OPT,
      OPT,
    ]),
    allocated: stageRow([
      REQ,
      OPT,
      NA,
      OPT,
      q("report_only_swms"),
      OPT,
      OPT,
    ]),
    trade_report_in: stageRow([
      REQ,
      REQ,
      NA,
      REQ,
      q("report_only_swms"),
      OPT,
      OPT,
    ]),
    report_ready: stageRow([
      REQ,
      REQ,
      NA,
      REQ,
      q("report_only_swms"),
      q("report_ready_authority"),
      OPT,
    ]),
    completed: stageRow([
      REQ,
      q("terminal_evidence"),
      NA,
      q("terminal_evidence"),
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    archive: stageRow([
      REQ,
      q("terminal_evidence"),
      NA,
      q("terminal_evidence"),
      q("report_only_swms", "terminal_evidence"),
      REQ,
      OPT,
    ]),
    cancelled: stageRow([
      q("cancelled_floor"),
      q("cancelled_floor"),
      NA,
      q("cancelled_floor"),
      q("report_only_swms", "cancelled_floor"),
      q("cancelled_floor"),
      OPT,
    ]),
  },

  // §4.6 Repair: family exists, recipe unsealed. No cell may be promoted by a
  // code change; only `po` is settled (OPTIONAL, by the 2026-08-01 re-ruling).
  repair: unsealedFamily("repair_recipe"),

  // §4.7 Restoration: typed first-class family, recipe unsealed.
  restoration: unsealedFamily("restoration_recipe"),
};

export function sesEvidenceRequirement(
  family: SesEvidenceFamily,
  stage: SesEvidenceStage,
  item: SesEvidenceItem,
): SesEvidenceRequirement {
  return SES_EVIDENCE_REQUIREMENTS[family][stage][item];
}

/**
 * Resolve a card's contract family from its raw job/detail authority. Returns
 * null for `unknown`, which is a refusal outcome and has no matrix row: an
 * unknown card must not be measured against a guessed family.
 */
export function sesEvidenceFamilyFromCard(args: {
  makesafe_job_family?: unknown;
  insurance_job_type?: unknown;
  strata?: unknown;
  own_template_requested?: unknown;
  report_delivery?: unknown;
}): SesEvidenceFamily | null {
  const family: SesFamilyId = canonicalSesFamilyFromCard(args);
  return family === "unknown" ? null : family;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface SesEvidenceFact {
  /** Whether the item's own canonical artifact was observed on the card. */
  present: boolean;
  /**
   * An acceptable-but-unruled substitute was observed. Consulted only for
   * `prime_link` (a GHL object standing in for a Prime portal obligation); the
   * reader turns that into an unresolved question, never a pass and never a fail.
   */
  substitute_present?: boolean;
  /**
   * A submission/upload record exists but its artifact does not. Cheap
   * lost-in-transit discrimination; full forensics is C2's job.
   */
  transit_record_without_artifact?: boolean;
  /** Optional observed count (photo count, typed link count, ...). */
  count?: number;
  /** Free-text provenance for the measurement report. No client PII. */
  detail?: string;
}

export type SesCardEvidenceInventory = Record<
  SesEvidenceItem,
  SesEvidenceFact
>;

/** An all-absent inventory. Spread it and override only what was measured. */
export function emptySesCardEvidenceInventory(): SesCardEvidenceInventory {
  return {
    builder_wo_doc: { present: false },
    prime_link: { present: false },
    trade_report: { present: false },
    photos_media: { present: false },
    swms: { present: false },
    invoice: { present: false },
    po: { present: false },
  };
}

export interface SesEvidenceItemReading {
  item: SesEvidenceItem;
  label: string;
  requirement: SesEvidenceRequirementLevel;
  status: SesEvidenceItemStatus;
  /** The raw fact, always reported even when the cell is unresolved. */
  observed_present: boolean;
  observed_count: number | null;
  signal: SesEvidenceSignal;
  open_questions: readonly SesCaptainQuestionId[];
  detail: string | null;
}

export interface SesEvidenceReading {
  contract_version: string;
  family: SesEvidenceFamily;
  stage: SesEvidenceStage;
  verdict: SesEvidenceVerdict;
  items: readonly SesEvidenceItemReading[];
  missing: readonly SesEvidenceItem[];
  lost_in_transit: readonly SesEvidenceItem[];
  unresolved: readonly SesEvidenceItem[];
  open_questions: readonly SesCaptainQuestion[];
}

/**
 * Grade one card's evidence inventory against the ruler.
 *
 * Status per item:
 * - `not_applicable`                    -> `not_required`
 * - `optional`, artifact present        -> `present`
 * - `optional`, artifact absent         -> `not_required`
 * - `required`, artifact present        -> `present`
 * - `required`, artifact absent         -> `missing` (signal may be
 *                                          `lost_in_transit`)
 * - `required`, only a substitute       -> `unresolved_question`
 * - `question` (any observation)        -> `unresolved_question`
 *
 * Verdict: `fail` if any item is `missing`; else `undetermined` if any item is
 * `unresolved_question`; else `pass`. A card whose only shortfall is an
 * unresolved Captain question is therefore undetermined, never failing.
 */
export function readSesCardEvidence(args: {
  family: SesEvidenceFamily;
  stage: SesEvidenceStage;
  inventory: SesCardEvidenceInventory;
}): SesEvidenceReading {
  const { family, stage, inventory } = args;
  const items: SesEvidenceItemReading[] = SES_EVIDENCE_ITEMS.map((item) => {
    const requirement = sesEvidenceRequirement(family, stage, item);
    const fact = inventory[item];
    const present = fact?.present === true;
    const signal: SesEvidenceSignal =
      !present && fact?.transit_record_without_artifact === true
        ? "lost_in_transit"
        : "none";
    const standing = SES_EVIDENCE_ITEM_STANDING_QUESTIONS[item] || [];
    const substituteOnly = !present && fact?.substitute_present === true &&
      standing.length > 0;

    let status: SesEvidenceItemStatus;
    let questions: readonly SesCaptainQuestionId[] = [];
    if (requirement.level === "question") {
      status = "unresolved_question";
      questions = requirement.questions;
    } else if (requirement.level === "not_applicable") {
      status = "not_required";
    } else if (present) {
      status = "present";
    } else if (substituteOnly) {
      // A substitute the Captain has not ruled on can neither satisfy nor fail
      // the obligation. It is undetermined at every requirement level, because
      // even an OPTIONAL cell would otherwise silently record "not required"
      // for a card that does hold portal-shaped evidence.
      status = "unresolved_question";
      questions = standing;
    } else {
      status = requirement.level === "required" ? "missing" : "not_required";
    }

    return {
      item,
      label: SES_EVIDENCE_ITEM_LABELS[item],
      requirement: requirement.level,
      status,
      observed_present: present,
      observed_count: typeof fact?.count === "number" ? fact.count : null,
      signal,
      open_questions: questions,
      detail: fact?.detail ? String(fact.detail) : null,
    };
  });

  const missing = items.filter((row) => row.status === "missing").map((row) =>
    row.item
  );
  const unresolved = items.filter((row) => row.status === "unresolved_question")
    .map((row) => row.item);
  const lostInTransit = items.filter((row) => row.signal === "lost_in_transit")
    .map((row) => row.item);
  const questionIds = new Set<SesCaptainQuestionId>(
    items.flatMap((row) => [...row.open_questions]),
  );

  return {
    contract_version: SES_EVIDENCE_CONTRACT_VERSION,
    family,
    stage,
    verdict: missing.length > 0
      ? "fail"
      : unresolved.length > 0
      ? "undetermined"
      : "pass",
    items,
    missing,
    lost_in_transit: lostInTransit,
    unresolved,
    open_questions: SES_CAPTAIN_QUESTIONS.filter((question) =>
      questionIds.has(question.id)
    ),
  };
}
