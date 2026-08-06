/**
 * Offline prepare+commit for Mosman Park remint when production ops-api still
 * lacks labour_rate_override. Uses the same pure builders as the edge, then
 * commits via commit_ses_invoice_obligation_revision_v1 (SECURITY DEFINER).
 *
 * Does NOT mint Xero — create_ses_invoice_draft remains the mint path with the
 * full live ACCREC duplicate guard.
 */
import {
  buildCommercialQuantityOverrideLines,
  SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
} from "../../supabase/functions/ops-api/ses_commercial_quantity_override.ts";
import { prepareSesInvoiceObligation } from "../../supabase/functions/ops-api/makesafe_invoice_obligation.ts";

const JOB_ID = "762ebaad-5f6f-4477-acb7-30db016b15ea";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DOCKET_ID = "86d995e7-01fd-5574-a7b9-f23247b25cb7";
const CYCLE_ID = "b7edf9d8-6f68-4cc4-b12a-7aa20d3b070a";
const PRICING_CANON =
  "pricing-and-invoice-rules@sha256:7a116693ed57ab19a0076238fd860f572bb054868465e27415e7f85e983fe42b";

const override = {
  schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  authorised_by: "Captain Marnin Stobbe",
  authorised_at: "2026-08-06T00:00:00.000Z",
  decision_key: "mosman-park-remint-v1",
  reason:
    "Captain after-hours labour rate $100 (sealed MLB $85 unchanged globally) plus commercial materials $267.30 (Bunnings retail check) and glass disposal $70 for Mosman Park SWMS-261147 / INV-1143 remint only. Trade attendance left at 5h.",
  trade_reported_hours_per_trade: 5,
  sealed_billable_hours_floor: 3,
  labour_rate_override: {
    sealed_unit_price_ex_gst: 85,
    authorised_unit_price_ex_gst: 100,
    reason: "after hours",
  },
  lines: [
    {
      line_kind: "labour" as const,
      description:
        "MLB-27482 - make-safe attendance - 1 trade x 5 hours (after hours)",
      quantity: 5,
      unit_price_ex_gst: 100,
    },
    {
      line_kind: "materials" as const,
      description:
        "MLB-27482 - Materials: structural timber 8m + ply 12mm 2.4x1.8 x3 + screws",
      quantity: 1,
      unit_price_ex_gst: 267.3,
    },
    {
      line_kind: "materials" as const,
      description: "MLB-27482 - Glass disposal",
      quantity: 1,
      unit_price_ex_gst: 70,
    },
  ],
};

const { lines, provenance } = buildCommercialQuantityOverrideLines({
  override,
  docket_revision_id: DOCKET_ID,
  attendance_cycle_ids: [CYCLE_ID],
  sealed_labour_unit_price_ex_gst: 85,
  builder_reference: "MLB-27482",
});

const prepared = await prepareSesInvoiceObligation({
  org_id: ORG_ID,
  job_id: JOB_ID,
  docket_revision_id: DOCKET_ID,
  attendance_cycle_ids: [CYCLE_ID],
  pricing_disposition: "priced_with_line_override",
  pricing_canon_version: PRICING_CANON,
  company: "mlb",
  reference: "MLB-27482",
  contact_name: "mlb",
  lines,
  guard_result: {
    hard_failures: [],
    warnings: [
      "commercial_quantity_override_applied: Captain-authorised after-hours rate and commercial materials for this card only; trade attendance evidence unchanged; sealed schedule matrix unchanged",
    ],
  },
  duplicate_probe: {
    allows_create: true,
    match_tier: null,
    ambiguity: "void_only",
  },
  created_by: "fm/mosman-park-remint-v1",
  existing: null,
  post_release_disposition: null,
});

(prepared.proposal as any).commercial_quantity_override = provenance;
(prepared.revision as any).proposal = prepared.proposal;

const totals = prepared.proposal.totals;
if (totals.ex !== 837.3 || totals.inc !== 921.03) {
  console.error("TOTAL_MISMATCH", totals);
  Deno.exit(2);
}

const url = Deno.env.get("SW_SUPABASE_URL");
const key = Deno.env.get("SR_KEY");
if (!url || !key) {
  console.error("Need SW_SUPABASE_URL and SR_KEY");
  Deno.exit(1);
}

const res = await fetch(`${url}/rest/v1/rpc/commit_ses_invoice_obligation_revision_v1`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({
    p_obligation: prepared.obligation,
    p_revision: prepared.revision,
  }),
});
const body = await res.json();
const out = {
  http: res.status,
  prepared: {
    state: prepared.state,
    obligation_id: prepared.obligation.id,
    revision_id: prepared.revision.id,
    content_hash: prepared.revision.content_hash,
    pricing_disposition: prepared.revision.pricing_disposition,
    totals: prepared.proposal.totals,
    lines: prepared.proposal.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      override_kind: (l.evidence as any)?.override_kind,
    })),
    override_kind: provenance.override_kind,
    decision_key: provenance.decision_key,
    labour_rate_override: provenance.labour_rate_override,
  },
  commit: body,
};
console.log(JSON.stringify(out, null, 2));
if (!res.ok) Deno.exit(1);
