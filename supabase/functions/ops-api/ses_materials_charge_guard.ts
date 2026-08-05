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
 * Path (Captain 2026-08-05): when materials_used is present and no materials
 * charge line can be produced, refuse with a named blocker that lists the
 * materials and asks for one materials figure (ex GST). The operator answers on
 * the OPERATOR surface — the `materials_charge` body field of
 * `prepare_ses_docket_revision` — which never writes trade attendance evidence.
 * Typed priced `materials[]` lines remain valid.
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
      "materials_charge.amount_ex_gst must be a positive ex-GST figure. Do not send zero to clear the materials question.",
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
  operator_charge: SesMaterialsChargeAuthorisation | null;
  priced_materials_line_count: number;
}): MaterialsChargeDecision {
  const materials = recordedMaterialsUsed(input.materials_used);
  const charge = input.operator_charge;
  const alreadyPriced = Number.isFinite(input.priced_materials_line_count) &&
    input.priced_materials_line_count > 0;

  if (charge) {
    if (!materials.length) {
      return {
        action: "refuse",
        materials,
        reason_code: MATERIALS_CHARGE_FIGURE_UNSUPPORTED,
        reason:
          `A materials charge of $${charge.amount_ex_gst} ex GST was authorised but this card records no materials used, so there is nothing the charge describes.`,
        recovery_action:
          "Drop materials_charge and let the card price labour only, or recover the trade's materials-used evidence first. Never bill a figure the report cannot show.",
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
          "Choose one: keep the typed priced materials lines and drop materials_charge, or remove the typed lines and bill the single authorised figure.",
      };
    }
    const joined = materials.join("; ");
    return {
      action: "charge_line",
      materials,
      amount_ex_gst: charge.amount_ex_gst,
      description: `Materials used: ${joined}`,
      provenance: {
        schema: charge.schema,
        materials_charge_ex_gst: charge.amount_ex_gst,
        materials_used: materials,
        source: "operator_materials_charge_figure",
        authorised_by: charge.authorised_by,
        authorised_at: charge.authorised_at,
        decision_key: charge.decision_key,
        reason: charge.reason,
        // Not an auto-estimate — figure was authorised, materials list is trade evidence.
        estimate: false,
        note:
          "Operator commercial materials figure. Trade attendance evidence was not written; the sealed labour rate and logged hours are unchanged.",
      },
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
