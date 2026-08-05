/**
 * Captain-authorised commercial quantity override for SES invoice obligations.
 *
 * This is NOT a rate override and NOT a trade-evidence edit:
 * - trade attendance hours stay as logged on job_service_reports
 * - sealed builder floors in ses_prepare_docket_revision stay unchanged
 * - the unit price on labour lines must remain the sealed schedule rate
 * - quantity and materials totals may rise above the sealed schedule when the
 *   Captain authorises a one-off commercial figure for named cards only
 *
 * Disposition reuses priced_with_line_override (already in the DB CHECK) so no
 * migration is required. Line.rate_override_* fields are the existing audit
 * vehicle for human approval; evidence.override_kind is always
 * commercial_quantity_not_rate so a year later nobody mistakes this for a
 * false hourly rate.
 */

import type { SesInvoiceProposalLine } from "./makesafe_invoice_obligation.ts";

export const SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA =
  "secureworks.makesafe.commercial-quantity-override/v1" as const;

/** Validation error for commercial override payloads (mapped to HTTP by the action). */
export class SesCommercialQuantityOverrideError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "SesCommercialQuantityOverrideError";
    this.httpStatus = httpStatus;
  }
}

export type SesCommercialLineKind = "labour" | "materials";

export interface SesCommercialQuantityOverrideLineInput {
  line_kind: SesCommercialLineKind;
  description: string;
  quantity: number;
  unit_price_ex_gst: number;
}

export interface SesCommercialQuantityOverrideInput {
  schema: typeof SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA;
  /** Who authorised the commercial figure (Captain). */
  authorised_by: string;
  /** ISO-8601 timestamp of the Captain instruction. */
  authorised_at: string;
  /** Stable decision key for the instruction. */
  decision_key: string;
  /** Human-readable reason (must state commercial, not evidence correction). */
  reason: string;
  /**
   * Trade-recorded hours left untouched. Required so the obligation records
   * what the form still says.
   */
  trade_reported_hours_per_trade: number;
  /**
   * Sealed floor that would have applied without the commercial override
   * (AJS physical = 2). Recorded for audit; not applied as a raise here.
   */
  sealed_billable_hours_floor: number;
  lines: SesCommercialQuantityOverrideLineInput[];
}

export interface SesCommercialQuantityOverrideBuildArgs {
  override: unknown;
  docket_revision_id: string;
  attendance_cycle_ids: string[];
  /** Sealed labour unit price from the U4 local proposal (must not change). */
  sealed_labour_unit_price_ex_gst: number | null;
  builder_reference: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function finiteNonNegative(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Parse and validate a commercial quantity override payload.
 * Throws SesActionError(400/409) on any invalid shape.
 */
export function parseSesCommercialQuantityOverride(
  raw: unknown,
): SesCommercialQuantityOverrideInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "commercial_quantity_override must be an object with Captain authority and line items.",
    );
  }
  const o = raw as Record<string, unknown>;
  if (o.schema !== SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA) {
    throw new SesCommercialQuantityOverrideError(
      400,
      `commercial_quantity_override.schema must be ${SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA}.`,
    );
  }
  const authorised_by = text(o.authorised_by);
  const authorised_at = text(o.authorised_at);
  const decision_key = text(o.decision_key);
  const reason = text(o.reason);
  const trade_reported = finiteNonNegative(o.trade_reported_hours_per_trade);
  const sealed_floor = finiteNonNegative(o.sealed_billable_hours_floor);
  if (!authorised_by || !authorised_at || !decision_key || !reason) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "commercial_quantity_override requires authorised_by, authorised_at, decision_key and reason so the commercial figure stays attributable.",
    );
  }
  if (trade_reported === null || sealed_floor === null) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "commercial_quantity_override must record trade_reported_hours_per_trade and sealed_billable_hours_floor (evidence and schedule stay separate from the commercial figure).",
    );
  }
  if (!Array.isArray(o.lines) || o.lines.length === 0) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "commercial_quantity_override.lines must be a non-empty array.",
    );
  }
  const lines: SesCommercialQuantityOverrideLineInput[] = [];
  let labourCount = 0;
  for (const rawLine of o.lines) {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
      throw new SesCommercialQuantityOverrideError(
        400,
        "Each commercial_quantity_override line must be an object.",
      );
    }
    const line = rawLine as Record<string, unknown>;
    const line_kind = text(line.line_kind);
    if (line_kind !== "labour" && line_kind !== "materials") {
      throw new SesCommercialQuantityOverrideError(
        400,
        "commercial_quantity_override lines must declare line_kind labour or materials (never a blended total).",
      );
    }
    const description = text(line.description);
    const quantity = finitePositive(line.quantity);
    const unit_price_ex_gst = finiteNonNegative(line.unit_price_ex_gst);
    if (!description || quantity === null || unit_price_ex_gst === null) {
      throw new SesCommercialQuantityOverrideError(
        400,
        "Each commercial line needs description, positive quantity and non-negative unit_price_ex_gst.",
      );
    }
    if (line_kind === "labour") labourCount += 1;
    lines.push({
      line_kind,
      description,
      quantity,
      unit_price_ex_gst,
    });
  }
  if (labourCount < 1) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "commercial_quantity_override must include at least one labour line so the Captain's hours figure is explicit on the invoice.",
    );
  }
  return {
    schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
    authorised_by,
    authorised_at,
    decision_key,
    reason,
    trade_reported_hours_per_trade: trade_reported,
    sealed_billable_hours_floor: sealed_floor,
    lines,
  };
}

/**
 * Build obligation lines from a validated commercial override.
 * Labour unit prices must match the sealed schedule rate from the U4 proposal
 * when one is known — never invent a false rate to reach a total.
 */
export function buildCommercialQuantityOverrideLines(
  args: SesCommercialQuantityOverrideBuildArgs,
): {
  lines: SesInvoiceProposalLine[];
  provenance: SesCommercialQuantityOverrideInput & {
    applied_at: string;
    docket_revision_id: string;
    sealed_labour_unit_price_ex_gst: number | null;
    note: string;
  };
} {
  const override = parseSesCommercialQuantityOverride(args.override);
  const sealedRate = args.sealed_labour_unit_price_ex_gst;
  const lines: SesInvoiceProposalLine[] = [];

  for (const line of override.lines) {
    if (
      line.line_kind === "labour" &&
      sealedRate != null &&
      line.unit_price_ex_gst !== sealedRate
    ) {
      throw new SesCommercialQuantityOverrideError(
        409,
        `Commercial labour unit price ${line.unit_price_ex_gst} does not match the sealed schedule rate ${sealedRate}. Do not force a total through a false hourly rate; keep the schedule rate and override quantity only.`,
      );
    }
    lines.push({
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price_ex_gst,
      account_code: "210",
      // Existing disposition vehicle for human-approved non-canon lines.
      // evidence.override_kind makes plain this is quantity/materials, not rate.
      rate_override_approved: true,
      rate_override_by: override.authorised_by,
      rate_override_at: override.authorised_at,
      evidence: {
        source: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
        override_kind: "commercial_quantity_not_rate",
        line_kind: line.line_kind,
        authorised_by: override.authorised_by,
        authorised_at: override.authorised_at,
        decision_key: override.decision_key,
        reason: override.reason,
        trade_reported_hours_per_trade: override.trade_reported_hours_per_trade,
        sealed_billable_hours_floor: override.sealed_billable_hours_floor,
        sealed_labour_unit_price_ex_gst: sealedRate,
        docket_revision_id: args.docket_revision_id,
        attendance_cycle_ids: args.attendance_cycle_ids,
        builder_reference: args.builder_reference,
        note:
          "Captain-authorised commercial figure above the sealed schedule. Trade attendance evidence is unchanged. Unit price is the sealed schedule rate; quantity and materials are commercial.",
      },
    });
  }

  const provenance = {
    ...override,
    applied_at: new Date().toISOString(),
    docket_revision_id: args.docket_revision_id,
    sealed_labour_unit_price_ex_gst: sealedRate,
    note:
      "priced_with_line_override disposition hosts this commercial quantity path without a migration. rate_override_* fields carry Captain approval audit only; override_kind=commercial_quantity_not_rate. Trade evidence was not written.",
  };

  return { lines, provenance };
}
