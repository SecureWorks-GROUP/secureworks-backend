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
 * materials and asks for one materials figure (ex GST). An operator-supplied
 * positive `materials_charge_ex_gst` answers that question as a single
 * clearly-marked charge line. Typed priced `materials[]` lines remain valid.
 *
 * Scope: `standard_labour_materials` only (MLB physical / repair / restoration
 * and other non-AJS builders on that basis). AJS/AJBR keep their existing
 * picket carve-out and labour path; they share the silent-omit defect for
 * non-picket materials but are out of scope for this change.
 */

export const MATERIALS_CHARGE_FIGURE_REQUIRED =
  "materials_charge_figure_required";

/** Placeholders the trade app / templates emit when nothing was used. */
const EMPTY_MATERIALS_RE =
  /^(none|n\/?a|nil|no materials?|other\s*\/\s*none|not applicable|-+|\.?)$/i;

function materialLabel(value: unknown): string {
  if (typeof value === "string") {
    return value.replaceAll(/[_-]+/g, " ").trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    if (row.selected === false) return "";
    for (
      const key of ["description", "label", "name", "material", "key"] as const
    ) {
      if (typeof row[key] === "string") {
        return String(row[key]).replaceAll(/[_-]+/g, " ").trim();
      }
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

export type MaterialsChargeDecision =
  | { action: "none" }
  | {
    action: "charge_line";
    materials: string[];
    amount_ex_gst: number;
    description_suffix: string;
  }
  | {
    action: "ask_one_figure";
    materials: string[];
    reason_code: typeof MATERIALS_CHARGE_FIGURE_REQUIRED;
    reason: string;
    recovery_action: string;
  };

/**
 * Decide whether a standard_labour_materials proposal needs a materials charge
 * line, already has one (via priced typed materials), can accept a one-figure
 * answer, or must refuse.
 *
 * `pricedMaterialsLineCount` is how many materials lines the proposal already
 * holds (typed materials with description + qty + unit price). Labour is not
 * counted.
 */
export function decideStandardLabourMaterialsCharge(input: {
  materials_used: unknown;
  materials_charge_ex_gst: unknown;
  priced_materials_line_count: number;
}): MaterialsChargeDecision {
  const materials = recordedMaterialsUsed(input.materials_used);
  if (!materials.length) return { action: "none" };

  if (
    Number.isFinite(input.priced_materials_line_count) &&
    input.priced_materials_line_count > 0
  ) {
    return { action: "none" };
  }

  const figure = positiveMaterialsChargeExGst(input.materials_charge_ex_gst);
  if (figure !== null) {
    const joined = materials.join("; ");
    return {
      action: "charge_line",
      materials,
      amount_ex_gst: figure,
      description_suffix:
        `Materials used (operator charge figure): ${joined}`,
    };
  }

  const listed = materials.join("; ");
  return {
    action: "ask_one_figure",
    materials,
    reason_code: MATERIALS_CHARGE_FIGURE_REQUIRED,
    reason:
      `Trade recorded materials used (${listed}) but the invoice proposal has no materials charge. Silent labour-only pricing is refused.`,
    recovery_action:
      "Supply one materials charge figure ex GST (materials_charge_ex_gst) for the listed materials, or typed materials lines with approved ex-GST unit prices. Do not invent unit prices, and do not raise the total by inflating labour hours or the sealed rate.",
  };
}
