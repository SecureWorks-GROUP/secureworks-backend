/**
 * Staff-authorised commercial quantity (and optional rate) override for SES
 * invoice obligations.
 *
 * Default path — quantity / materials only:
 * - trade attendance hours stay as logged on job_service_reports
 * - sealed builder floors in ses_prepare_docket_revision stay unchanged
 * - the unit price on labour lines must remain the sealed schedule rate
 * - quantity and materials totals may rise above the sealed schedule when the
 *   Captain or another staff member locks a one-off commercial figure for
 *   a named card
 * - evidence.override_kind is commercial_quantity_not_rate
 *
 * Explicit staff labour rate override (card-scoped only):
 * - labour_rate_override must be present with sealed + authorised rates and
 *   a reason (e.g. after hours). The sealed schedule matrix is never changed.
 * - evidence.override_kind is commercial_rate_override; sealed and authorised
 *   rates are both stamped so a later reader can see who overrode what and why.
 * - Without that block, a non-sealed labour unit price still refuses (no quiet
 *   rate fakery to force a total).
 *
 * Disposition reuses priced_with_line_override (already in the DB CHECK) so no
 * migration is required. Line.rate_override_* fields carry the staff audit.
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

export type SesCommercialOverrideKind =
  | "commercial_quantity_not_rate"
  | "commercial_rate_override";

export interface SesCommercialQuantityOverrideLineInput {
  line_kind: SesCommercialLineKind;
  description: string;
  quantity: number;
  unit_price_ex_gst: number;
}

/**
 * Explicit staff labour rate override for THIS card only.
 * Never changes the sealed schedule matrix; stamps sealed vs authorised rates.
 */
export interface SesCommercialLabourRateOverride {
  /** Sealed schedule rate that would apply without this override (e.g. MLB 85). */
  sealed_unit_price_ex_gst: number;
  /** Staff-authorised rate for this card (e.g. 100 after hours). */
  authorised_unit_price_ex_gst: number;
  /** Why the rate differs (must name the commercial reason, e.g. after hours). */
  reason: string;
}

/**
 * Who proposed the commercial figure (Captain 2026-08-19 pack system).
 * Default `staff_lock` preserves pre-mission remint payloads.
 * `ai_proposal` always surfaces as a commercial_review caveat for Captain eyes;
 * `captain_lock` is an identified Captain instruction.
 */
export type SesCommercialAuthorityKind =
  | "ai_proposal"
  | "staff_lock"
  | "captain_lock";

export const SES_COMMERCIAL_AUTHORITY_KINDS: readonly SesCommercialAuthorityKind[] =
  ["ai_proposal", "staff_lock", "captain_lock"] as const;

export interface SesCommercialQuantityOverrideInput {
  schema: typeof SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA;
  /** Staff member who authorised the commercial figure. */
  authorised_by: string;
  /** ISO-8601 timestamp of the staff instruction. */
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
  /**
   * Required when any labour line unit price differs from the sealed schedule.
   * Absent → non-sealed labour rate refuses (no quiet rate fakery).
   */
  labour_rate_override?: SesCommercialLabourRateOverride;
  /**
   * Optional. Defaults to `staff_lock` for back-compat. Matrix id+version may
   * ride in `proposal_source` when authority_kind is `ai_proposal`.
   */
  authority_kind?: SesCommercialAuthorityKind;
  /** Optional matrix/source coordinate (e.g. `labour-by-builder@ses-matrices/v1`). */
  proposal_source?: string | null;
}

export interface SesCommercialQuantityOverrideBuildArgs {
  override: unknown;
  docket_revision_id: string;
  attendance_cycle_ids: string[];
  /** Sealed labour unit price from the U4 local proposal. */
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

function parseLabourRateOverride(
  raw: unknown,
): SesCommercialLabourRateOverride | undefined {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "labour_rate_override must be an object with sealed_unit_price_ex_gst, authorised_unit_price_ex_gst and reason.",
    );
  }
  const o = raw as Record<string, unknown>;
  const sealed = finitePositive(o.sealed_unit_price_ex_gst);
  const authorised = finitePositive(o.authorised_unit_price_ex_gst);
  const reason = text(o.reason);
  if (sealed === null || authorised === null || !reason) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "labour_rate_override requires positive sealed_unit_price_ex_gst, positive authorised_unit_price_ex_gst, and a non-empty reason (e.g. after hours).",
    );
  }
  if (sealed === authorised) {
    throw new SesCommercialQuantityOverrideError(
      400,
      "labour_rate_override is only for a rate that differs from the sealed schedule; omit it when keeping the sealed rate.",
    );
  }
  return {
    sealed_unit_price_ex_gst: sealed,
    authorised_unit_price_ex_gst: authorised,
    reason,
  };
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
      "commercial_quantity_override must be an object with attributed staff authority and line items.",
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
  const labour_rate_override = parseLabourRateOverride(o.labour_rate_override);
  let authority_kind: SesCommercialAuthorityKind = "staff_lock";
  if (o.authority_kind != null && text(o.authority_kind)) {
    const kind = text(o.authority_kind) as SesCommercialAuthorityKind;
    if (!(SES_COMMERCIAL_AUTHORITY_KINDS as readonly string[]).includes(kind)) {
      throw new SesCommercialQuantityOverrideError(
        400,
        `commercial_quantity_override.authority_kind must be one of ${
          SES_COMMERCIAL_AUTHORITY_KINDS.join(", ")
        } (default staff_lock).`,
      );
    }
    authority_kind = kind;
  }
  const proposal_source = o.proposal_source == null
    ? null
    : text(o.proposal_source) || null;
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
      "commercial_quantity_override must include at least one labour line so the staff-locked hours figure is explicit on the invoice.",
    );
  }
  if (labour_rate_override) {
    for (const line of lines) {
      if (
        line.line_kind === "labour" &&
        line.unit_price_ex_gst !==
          labour_rate_override.authorised_unit_price_ex_gst
      ) {
        throw new SesCommercialQuantityOverrideError(
          409,
          `Labour line unit price ${line.unit_price_ex_gst} does not match labour_rate_override.authorised_unit_price_ex_gst ${labour_rate_override.authorised_unit_price_ex_gst}.`,
        );
      }
    }
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
    authority_kind,
    proposal_source,
    ...(labour_rate_override ? { labour_rate_override } : {}),
  };
}

/**
 * Build obligation lines from a validated commercial override.
 * Labour unit prices must match the sealed schedule rate unless staff
 * supplies an explicit labour_rate_override for this card only.
 */
export function buildCommercialQuantityOverrideLines(
  args: SesCommercialQuantityOverrideBuildArgs,
): {
  lines: SesInvoiceProposalLine[];
  provenance: SesCommercialQuantityOverrideInput & {
    applied_at: string;
    docket_revision_id: string;
    sealed_labour_unit_price_ex_gst: number | null;
    override_kind: SesCommercialOverrideKind;
    note: string;
  };
} {
  const override = parseSesCommercialQuantityOverride(args.override);
  const sealedRate = args.sealed_labour_unit_price_ex_gst;
  const rateOverride = override.labour_rate_override;
  const lines: SesInvoiceProposalLine[] = [];

  if (
    rateOverride && sealedRate != null &&
    rateOverride.sealed_unit_price_ex_gst !== sealedRate
  ) {
    throw new SesCommercialQuantityOverrideError(
      409,
      `labour_rate_override.sealed_unit_price_ex_gst ${rateOverride.sealed_unit_price_ex_gst} does not match the U4 sealed schedule rate ${sealedRate}. Do not change the shared sealed schedule; stamp the real sealed rate and override only this card.`,
    );
  }

  const overrideKind: SesCommercialOverrideKind = rateOverride
    ? "commercial_rate_override"
    : "commercial_quantity_not_rate";

  for (const line of override.lines) {
    if (line.line_kind === "labour" && sealedRate != null) {
      if (rateOverride) {
        if (
          line.unit_price_ex_gst !== rateOverride.authorised_unit_price_ex_gst
        ) {
          throw new SesCommercialQuantityOverrideError(
            409,
            `Commercial labour unit price ${line.unit_price_ex_gst} does not match the staff-authorised rate ${rateOverride.authorised_unit_price_ex_gst}.`,
          );
        }
      } else if (line.unit_price_ex_gst !== sealedRate) {
        throw new SesCommercialQuantityOverrideError(
          409,
          `Commercial labour unit price ${line.unit_price_ex_gst} does not match the sealed schedule rate ${sealedRate}. Do not force a total through a false hourly rate; keep the schedule rate and override quantity only, or supply labour_rate_override with staff provenance for a deliberate card-scoped rate change.`,
        );
      }
    }

    const lineNote = rateOverride
      ? `Staff-authorised commercial figure for this card only. Trade attendance evidence is unchanged. Labour rate overridden from sealed $${rateOverride.sealed_unit_price_ex_gst} to $${rateOverride.authorised_unit_price_ex_gst} (${rateOverride.reason}). Quantity and materials are commercial. Shared sealed schedule matrix unchanged.`
      : "Staff-authorised commercial figure overrides the automatic floor for this card. Trade attendance evidence is unchanged. Unit price is the sealed schedule rate; quantity and materials are commercial.";

    lines.push({
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unit_price_ex_gst,
      account_code: "210",
      // Existing disposition vehicle for human-approved non-canon lines.
      rate_override_approved: true,
      rate_override_by: override.authorised_by,
      rate_override_at: override.authorised_at,
      evidence: {
        source: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
        override_kind: overrideKind,
        line_kind: line.line_kind,
        authorised_by: override.authorised_by,
        authorised_at: override.authorised_at,
        decision_key: override.decision_key,
        reason: override.reason,
        trade_reported_hours_per_trade: override.trade_reported_hours_per_trade,
        sealed_billable_hours_floor: override.sealed_billable_hours_floor,
        sealed_labour_unit_price_ex_gst: sealedRate,
        ...(rateOverride
          ? {
            labour_rate_override: {
              sealed_unit_price_ex_gst: rateOverride.sealed_unit_price_ex_gst,
              authorised_unit_price_ex_gst:
                rateOverride.authorised_unit_price_ex_gst,
              reason: rateOverride.reason,
            },
          }
          : {}),
        docket_revision_id: args.docket_revision_id,
        attendance_cycle_ids: args.attendance_cycle_ids,
        builder_reference: args.builder_reference,
        note: lineNote,
      },
    });
  }

  const provenanceNote = rateOverride
    ? "priced_with_line_override hosts this commercial path without a migration. override_kind=commercial_rate_override: staff explicitly authorised a card-scoped labour rate different from the sealed schedule. Sealed matrix unchanged. Trade evidence was not written."
    : "priced_with_line_override disposition hosts this commercial quantity path without a migration. rate_override_* fields carry the staff approval audit only; override_kind=commercial_quantity_not_rate. Trade evidence was not written.";

  const provenance = {
    ...override,
    applied_at: new Date().toISOString(),
    docket_revision_id: args.docket_revision_id,
    sealed_labour_unit_price_ex_gst: sealedRate,
    override_kind: overrideKind,
    note: provenanceNote,
  };

  return { lines, provenance };
}
