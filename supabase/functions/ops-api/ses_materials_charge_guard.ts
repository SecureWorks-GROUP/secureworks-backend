/**
 * MLB / standard_labour_materials materials charge guard.
 *
 * Silent labour-only invoice proposals when the trade recorded materials used
 * have cost the Captain money on nearly every card. There is no authoritative
 * materials unit-price list in this system for general physical make-safe
 * consumables (the sealed AJS existing-fence star-picket $13.50 rate is a
 * different, narrow carve-out). Without a real price source we must never
 * invent unit prices on a builder invoice.
 *
 * Path (Captain 2026-08-05): the card carries a standing materials-charge
 * DECISION with exactly three states, and the operator moves between them on
 * the OPERATOR surface — the `materials_charge` body field of
 * `prepare_ses_docket_revision` — which never writes trade attendance evidence.
 *
 *   UNSET  nobody has answered           -> ask (`materials_charge_figure_required`)
 *   SET    an authorised ex-GST figure   -> one charge line naming the materials
 *   NONE   an explicit "no materials charge" -> labour-only, decision recorded
 *
 * All three are DURABLE, because SET and NONE are both stamped as the
 * `materials_charge` marker on the revision the prepare commits (on the
 * proposal when one is produced, and on the refusing blocker's facts when one
 * is not). Inheritance reads the NEWEST marker of either kind, so a withdrawal
 * is never overtaken by the charge it withdrew. Omitting the body key inherits
 * the standing decision and changes nothing; only an explicit body value moves
 * it. Typed priced `materials[]` lines remain valid.
 *
 * A supplied figure is never silently dropped either: if there is nothing to
 * charge for, or the proposal already prices materials, the run refuses with
 * `materials_charge_figure_unsupported` rather than discarding the money.
 *
 * Scope: `standard_labour_materials` only (MLB physical / repair / restoration
 * and other non-AJS builders on that basis). AJS/AJBR keep their existing
 * picket carve-out and labour path; they share the silent-omit defect for
 * non-picket materials but are out of scope for this change.
 */

export const MATERIALS_CHARGE_FIGURE_REQUIRED =
  "materials_charge_figure_required";

export const MATERIALS_CHARGE_FIGURE_UNSUPPORTED =
  "materials_charge_figure_unsupported";

export const SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA =
  "secureworks.makesafe.materials-charge-figure/v1" as const;

/**
 * One operator-authorised materials charge for one card, ex GST.
 *
 * This is a commercial figure, not a unit-price list and not a trade-evidence
 * edit: `job_service_reports` is never written, the sealed labour rate and the
 * trade's logged hours are untouched, and the figure carries its own authority
 * so a year later it stays attributable.
 */
export interface SesMaterialsChargeAuthorisation {
  schema: typeof SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA;
  amount_ex_gst: number;
  authorised_by: string;
  authorised_at: string;
  decision_key: string;
  reason: string;
}

/**
 * The operator's explicit "no materials charge on this card".
 *
 * This is the NONE state, not the UNSET one: the question has been answered,
 * the card prices labour only, and the answer is recorded on the revision so a
 * later prepare inherits it. "Not supplied" and "explicitly cleared" are
 * different states and must never collapse into each other — treating a
 * deliberate withdrawal as absent would put a figure the operator removed back
 * onto a builder invoice.
 */
export interface SesMaterialsChargeClearance {
  cleared_by: string | null;
  cleared_at: string | null;
  decision_key: string | null;
  reason: string | null;
}

export type SesMaterialsChargeDirective =
  | { kind: "charge"; authorisation: SesMaterialsChargeAuthorisation }
  | { kind: "cleared"; clearance: SesMaterialsChargeClearance };

/** The standing decision a card carries: SET, or NONE. UNSET is `null`. */
export type SesMaterialsChargeStandingDecision =
  | { decision: "charge"; authorisation: SesMaterialsChargeAuthorisation }
  | { decision: "none"; clearance: SesMaterialsChargeClearance };

/** Validation error for materials-charge payloads (mapped to HTTP by callers). */
export class SesMaterialsChargeAuthorisationError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "SesMaterialsChargeAuthorisationError";
    this.httpStatus = httpStatus;
  }
}

/** Placeholders the trade app / templates emit when nothing was used. */
const EMPTY_MATERIALS_RE =
  /^(none|n\/?a|nil|no materials?|other\s*\/\s*none|not applicable|-+|\.?)$/i;

/**
 * Key-style values (`star_pickets`) read as words; hyphens are left alone
 * because this label is copied verbatim onto a builder-facing invoice line and
 * "Tarps - heavy duty" is the trade's own wording, not a key separator.
 */
function normalizeMaterialLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replaceAll(/_+/g, " ").replaceAll(/\s+/g, " ").trim();
}

function materialLabel(value: unknown): string {
  if (typeof value === "string") return normalizeMaterialLabel(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    for (const flag of ["checked", "selected"] as const) {
      if (Object.hasOwn(row, flag) && !row[flag]) return "";
    }
    for (
      const key of ["description", "label", "name", "material", "key"] as const
    ) {
      const label = normalizeMaterialLabel(row[key]);
      if (label) return label;
    }
  }
  return "";
}

/**
 * Real materials the trade recorded. Empty / "none" / "Other / none" template
 * ticks are not evidence that anything was consumed.
 */
export function recordedMaterialsUsed(materialsUsed: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const label = materialLabel(raw);
    if (!label || EMPTY_MATERIALS_RE.test(label)) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  };
  if (Array.isArray(materialsUsed)) {
    for (const item of materialsUsed) push(item);
  } else if (materialsUsed != null) {
    push(materialsUsed);
  }
  return out;
}

export function positiveMaterialsChargeExGst(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100) / 100;
}

function requiredText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const text = requiredText(value);
  return text || null;
}

/**
 * Parse the operator's `materials_charge` body field. Throws on any shape that
 * would put an unattributable figure on a builder invoice.
 */
export function parseSesMaterialsChargeAuthorisation(
  raw: unknown,
): SesMaterialsChargeAuthorisation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SesMaterialsChargeAuthorisationError(
      400,
      "materials_charge must be an object carrying the ex-GST figure and who authorised it.",
    );
  }
  const payload = raw as Record<string, unknown>;
  if (payload.schema !== SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA) {
    throw new SesMaterialsChargeAuthorisationError(
      400,
      `materials_charge.schema must be ${SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA}.`,
    );
  }
  const amount = positiveMaterialsChargeExGst(payload.amount_ex_gst);
  if (amount === null) {
    throw new SesMaterialsChargeAuthorisationError(
      400,
      "materials_charge.amount_ex_gst must be a positive ex-GST figure. Send null, or amount_ex_gst 0 with the same authority fields, to withdraw a figure.",
    );
  }
  const authorised_by = requiredText(payload.authorised_by);
  const authorised_at = requiredText(payload.authorised_at);
  const decision_key = requiredText(payload.decision_key);
  const reason = requiredText(payload.reason);
  if (!authorised_by || !authorised_at || !decision_key || !reason) {
    throw new SesMaterialsChargeAuthorisationError(
      400,
      "materials_charge requires authorised_by, authorised_at, decision_key and reason so the commercial figure stays attributable.",
    );
  }
  return {
    schema: SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
    amount_ex_gst: amount,
    authorised_by,
    authorised_at,
    decision_key,
    reason,
  };
}

/**
 * Read the operator's `materials_charge` body field, which the caller supplies
 * only when the key is actually present. A present `null` — or an explicit
 * zero carrying the same authority fields — withdraws the figure; anything
 * else must be a positive authorised charge.
 */
export function parseSesMaterialsChargeDirective(
  raw: unknown,
): SesMaterialsChargeDirective {
  if (raw === null) {
    return {
      kind: "cleared",
      clearance: {
        cleared_by: null,
        cleared_at: null,
        decision_key: null,
        reason: null,
      },
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SesMaterialsChargeAuthorisationError(
      400,
      "materials_charge must be an object carrying the ex-GST figure and who authorised it, or null to withdraw the figure.",
    );
  }
  const payload = raw as Record<string, unknown>;
  const amount = Number(payload.amount_ex_gst);
  if (Number.isFinite(amount) && amount === 0) {
    if (payload.schema !== SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA) {
      throw new SesMaterialsChargeAuthorisationError(
        400,
        `materials_charge.schema must be ${SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA}.`,
      );
    }
    const cleared_by = requiredText(payload.authorised_by);
    const cleared_at = requiredText(payload.authorised_at);
    const decision_key = requiredText(payload.decision_key);
    const reason = requiredText(payload.reason);
    if (!cleared_by || !cleared_at || !decision_key || !reason) {
      throw new SesMaterialsChargeAuthorisationError(
        400,
        "Withdrawing a materials charge with amount_ex_gst 0 requires authorised_by, authorised_at, decision_key and reason so the withdrawal stays attributable. Send materials_charge null for an unattributed clear.",
      );
    }
    return {
      kind: "cleared",
      clearance: { cleared_by, cleared_at, decision_key, reason },
    };
  }
  return {
    kind: "charge",
    authorisation: parseSesMaterialsChargeAuthorisation(raw),
  };
}

function sameMaterialSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map((item) => item.toLowerCase()).sort();
  const b = right.map((item) => item.toLowerCase()).sort();
  return a.every((item, index) => item === b[index]);
}

/**
 * The durable form of a standing decision. This single object is what a
 * revision commits — on the proposal when one is produced, on the refusing
 * blocker's facts when one is not — and what a later prepare reads back, so
 * SET and NONE persist through exactly the same surface and neither can
 * outlive the other.
 */
export function materialsChargeDecisionMarker(
  decision: SesMaterialsChargeStandingDecision,
  materials: string[],
): Record<string, unknown> {
  if (decision.decision === "none") {
    return {
      schema: SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA,
      decision: "none",
      materials_charge_ex_gst: 0,
      materials_used: materials,
      source: "operator_materials_charge_withdrawn",
      cleared_by: decision.clearance.cleared_by,
      cleared_at: decision.clearance.cleared_at,
      decision_key: decision.clearance.decision_key,
      reason: decision.clearance.reason,
      estimate: false,
      note:
        "Operator decided this card carries no materials charge. Recorded so a later prepare inherits the decision instead of re-asking or re-billing. Trade attendance evidence was not written.",
    };
  }
  const charge = decision.authorisation;
  return {
    schema: charge.schema,
    decision: "charge",
    materials_charge_ex_gst: charge.amount_ex_gst,
    materials_used: materials,
    source: "operator_materials_charge_figure",
    authorised_by: charge.authorised_by,
    authorised_at: charge.authorised_at,
    decision_key: charge.decision_key,
    reason: charge.reason,
    estimate: false,
    note:
      "Operator commercial materials figure. Trade attendance evidence was not written; the sealed labour rate and logged hours are unchanged.",
  };
}

/**
 * The key the refusing half of a revision stamps its decision under, so a
 * decision made while the card was blocked for an unrelated pricing reason is
 * just as durable as one made on a priced revision.
 */
export const MATERIALS_CHARGE_DECISION_FACT = "materials_charge_decision";

/**
 * How far back a decision is looked for. Every revision that prices or refuses
 * re-stamps the standing decision, so the newest revision carries it and this
 * bound is headroom, not a window the answer can fall out of.
 */
export const SES_MATERIALS_CHARGE_DECISION_SCAN_LIMIT = 25;

/** The decision marker a committed revision carries, from either surface. */
export function materialsChargeDecisionFromRevision(row: {
  local_invoice_proposal: unknown;
  blockers: unknown;
}): unknown {
  const proposal = row.local_invoice_proposal;
  if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
    const marker = (proposal as Record<string, unknown>).materials_charge;
    if (marker != null) return marker;
  }
  if (Array.isArray(row.blockers)) {
    for (const blocker of row.blockers) {
      if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) {
        continue;
      }
      const facts = (blocker as Record<string, unknown>).facts;
      if (!facts || typeof facts !== "object" || Array.isArray(facts)) continue;
      const marker = (facts as Record<string, unknown>)[
        MATERIALS_CHARGE_DECISION_FACT
      ];
      if (marker != null) return marker;
    }
  }
  return null;
}

/**
 * Read back the standing decision a previous revision committed, so one
 * operator answer keeps answering in BOTH directions: a figure keeps billing
 * and a withdrawal keeps not billing.
 *
 * A decision is inherited ONLY while it still describes the same recorded
 * materials: a re-attendance that consumed different materials was never
 * decided on, so the card asks again rather than reusing yesterday's answer.
 *
 * A rebuilt charge is byte-identical to the one the operator sent, so an
 * inheriting prepare reproduces the same input hash.
 */
export function carriedMaterialsChargeDecision(input: {
  prior_materials_charge: unknown;
  materials_used: unknown;
}): SesMaterialsChargeStandingDecision | null {
  const prior = input.prior_materials_charge;
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return null;
  const marker = prior as Record<string, unknown>;
  const current = recordedMaterialsUsed(input.materials_used);
  if (!current.length) return null;
  const decidedFor = recordedMaterialsUsed(marker.materials_used);
  if (!decidedFor.length || !sameMaterialSet(decidedFor, current)) return null;
  const amount = Number(
    marker.amount_ex_gst ?? marker.materials_charge_ex_gst,
  );
  if (marker.decision === "none" || (Number.isFinite(amount) && amount === 0)) {
    return {
      decision: "none",
      clearance: {
        cleared_by: optionalText(marker.cleared_by),
        cleared_at: optionalText(marker.cleared_at),
        decision_key: optionalText(marker.decision_key),
        reason: optionalText(marker.reason),
      },
    };
  }
  try {
    return {
      decision: "charge",
      authorisation: parseSesMaterialsChargeAuthorisation({
        ...marker,
        amount_ex_gst: marker.amount_ex_gst ?? marker.materials_charge_ex_gst,
      }),
    };
  } catch {
    return null;
  }
}

export type MaterialsChargeDecision =
  | { action: "none" }
  | {
    action: "charge_line";
    materials: string[];
    amount_ex_gst: number;
    /** Builder-facing line text. No internal jargon reaches the invoice. */
    description: string;
    provenance: Record<string, unknown>;
  }
  | {
    /** NONE: no charge line, but the decision is recorded on the revision. */
    action: "no_charge_recorded";
    materials: string[];
    provenance: Record<string, unknown>;
  }
  | {
    action: "refuse";
    materials: string[];
    reason_code:
      | typeof MATERIALS_CHARGE_FIGURE_REQUIRED
      | typeof MATERIALS_CHARGE_FIGURE_UNSUPPORTED;
    reason: string;
    recovery_action: string;
  };

/** The one sanctioned way an operator answers the materials question. */
export const MATERIALS_CHARGE_OPERATOR_PATH =
  `Re-run prepare_ses_docket_revision for this one card (selection.mode job_id or job_number) with body materials_charge = { schema: "${SES_MATERIALS_CHARGE_AUTHORISATION_SCHEMA}", amount_ex_gst, authorised_by, authorised_at, decision_key, reason }. That is an operator commercial figure and writes no trade evidence.`;

/**
 * How an operator records "no materials charge on this card". Named on every
 * refusal that a standing figure causes, so the instruction is always one the
 * operator can actually follow.
 */
export const MATERIALS_CHARGE_CLEAR_PATH =
  "Record an explicit no-materials-charge decision by re-running prepare_ses_docket_revision for this one card with body materials_charge = null (or amount_ex_gst 0 with authorised_by, authorised_at, decision_key and reason to record who decided it). That decision is stored on the card and inherited from then on: the card prices labour only and stops asking. Omitting the field inherits whatever decision already stands and changes nothing.";

/**
 * Decide whether a standard_labour_materials proposal needs a materials charge
 * line, already has one (via priced typed materials), can accept the operator's
 * one-figure answer, or must refuse.
 *
 * `pricedMaterialsLineCount` is how many materials lines the proposal already
 * holds (typed materials with description + qty + unit price). Labour is not
 * counted.
 */
export function decideStandardLabourMaterialsCharge(input: {
  materials_used: unknown;
  standing_decision: SesMaterialsChargeStandingDecision | null;
  priced_materials_line_count: number;
}): MaterialsChargeDecision {
  const materials = recordedMaterialsUsed(input.materials_used);
  const standing = input.standing_decision;
  const charge = standing?.decision === "charge"
    ? standing.authorisation
    : null;
  const alreadyPriced = Number.isFinite(input.priced_materials_line_count) &&
    input.priced_materials_line_count > 0;

  if (standing?.decision === "none") {
    return {
      action: "no_charge_recorded",
      materials,
      provenance: materialsChargeDecisionMarker(standing, materials),
    };
  }

  if (charge) {
    if (!materials.length) {
      return {
        action: "refuse",
        materials,
        reason_code: MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
        reason:
          `A materials charge of $${charge.amount_ex_gst} ex GST was authorised but this card records no materials used, so there is nothing the charge describes.`,
        recovery_action:
          `Let the card price labour only, or recover the trade's materials-used evidence first. Never bill a figure the report cannot show. ${MATERIALS_CHARGE_CLEAR_PATH}`,
      };
    }
    if (alreadyPriced) {
      return {
        action: "refuse",
        materials,
        reason_code: MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
        reason:
          `A materials charge of $${charge.amount_ex_gst} ex GST was authorised while the proposal already prices ${input.priced_materials_line_count} materials line(s), so the charge would either double-bill or be dropped.`,
        recovery_action:
          `Choose one: keep the typed priced materials lines and withdraw the figure, or remove the typed lines and bill the single authorised figure. ${MATERIALS_CHARGE_CLEAR_PATH}`,
      };
    }
    const joined = materials.join("; ");
    return {
      action: "charge_line",
      materials,
      amount_ex_gst: charge.amount_ex_gst,
      description: `Materials used: ${joined}`,
      provenance: materialsChargeDecisionMarker(
        { decision: "charge", authorisation: charge },
        materials,
      ),
    };
  }

  if (!materials.length) return { action: "none" };
  if (alreadyPriced) return { action: "none" };

  const listed = materials.join("; ");
  return {
    action: "refuse",
    materials,
    reason_code: MATERIALS_CHARGE_FIGURE_REQUIRED,
    reason:
      `Trade recorded materials used (${listed}) but the invoice proposal has no materials charge. Silent labour-only pricing is refused.`,
    recovery_action:
      `Supply one materials charge figure ex GST for the listed materials, or typed materials lines with approved ex-GST unit prices. ${MATERIALS_CHARGE_OPERATOR_PATH} Do not invent unit prices, and do not raise the total by inflating labour hours or the sealed rate.`,
  };
}
