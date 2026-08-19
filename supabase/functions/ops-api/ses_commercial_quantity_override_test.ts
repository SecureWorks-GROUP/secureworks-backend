// deno-lint-ignore-file no-import-prefix
import { SES_FAMILY_MATRIX_VERSION } from "./ses_family_matrix.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCommercialQuantityOverrideLines,
  parseSesCommercialQuantityOverride,
  SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  SesCommercialQuantityOverrideError,
} from "./ses_commercial_quantity_override.ts";
import {
  prepareSesInvoiceObligationAction,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";

const AJBR_70488 = {
  schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  authorised_by: "Captain",
  authorised_at: "2026-08-05T00:00:00.000Z",
  decision_key: "ajbr-remint-25h-commercial-v1",
  reason:
    "Captain-authorised commercial quantity above sealed AJS 2h floor; trade attendance remains 2.0h; materials timber and bugle screws.",
  trade_reported_hours_per_trade: 2,
  sealed_billable_hours_floor: 2,
  lines: [
    {
      line_kind: "labour",
      description: "AJBR-70488 - make-safe attendance - 1 trade x 2.5 hours",
      quantity: 2.5,
      unit_price_ex_gst: 80,
    },
    {
      line_kind: "materials",
      description: "AJBR-70488 - Materials: timber and bugle screws",
      quantity: 1,
      unit_price_ex_gst: 45,
    },
  ],
};

const AJBR_70487 = {
  ...AJBR_70488,
  reason:
    "Captain-authorised commercial quantity above sealed AJS 2h floor; trade attendance remains 2.0h; materials timber, bugle, flashing and silicone.",
  lines: [
    {
      line_kind: "labour",
      description: "AJBR-70487 - make-safe attendance - 1 trade x 2.5 hours",
      quantity: 2.5,
      unit_price_ex_gst: 80,
    },
    {
      line_kind: "materials",
      description:
        "AJBR-70487 - Materials: timber, bugle screws, flashing tape and silicone",
      quantity: 1,
      unit_price_ex_gst: 60,
    },
  ],
};

const STAFF_LOCKED_120 = {
  schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  authorised_by: "Operations staff",
  authorised_at: "2026-08-13T00:00:00.000Z",
  decision_key: "kelmscott-style-locked-120-v1",
  reason:
    "Staff locked the named card at $120 ex-GST; the AJS two-hour floor remains unchanged for cards without an override.",
  trade_reported_hours_per_trade: 1.5,
  sealed_billable_hours_floor: 2,
  lines: [{
    line_kind: "labour",
    description: "AJBR-LOCKED - make-safe attendance - locked figure",
    quantity: 1.5,
    unit_price_ex_gst: 80,
  }],
};

function missingPricingDocket() {
  return {
    id: "40000000-0000-4000-8000-00000000d120",
    job_id: "6006c332-3bb5-473e-beda-bef627172120",
    stage: "pre_xero",
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    attendance_cycle_ids: ["20000000-0000-4000-8000-000000000120"],
    current_attendance_cycle_id: "20000000-0000-4000-8000-000000000120",
    envelope: { v2: { routing: { builder: "aj" } } },
    review_spec: {
      cards: [{
        exception_review_codes: [],
        invoice_gate_codes: ["pricing_evidence_missing"],
      }],
    },
    local_invoice_proposal: {
      version: "ses-draft-zero-invoice-review/v1",
      state: "price_unresolved",
      reference: "AJBR-LOCKED",
      invoice_basis: "ajs_labour_materials",
      line_items: [],
      subtotal_ex_gst: null,
      total_inc_gst: null,
      invoice_gates: ["pricing_evidence_missing"],
    },
  };
}

function preparationClient(docket: Record<string, unknown>) {
  let committedRevision: any = null;
  const client = {
    from(table: string) {
      const response = () => {
        if (table === "makesafe_docket_revisions") {
          return { data: docket, error: null };
        }
        if (table === "makesafe_invoice_obligation_revisions_current") {
          return { data: null, error: null };
        }
        if (table === "xero_invoices") {
          return { data: [], error: null };
        }
        return { data: null, error: null };
      };
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        not() {
          return query;
        },
        or() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve(response());
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(response()).then(resolve);
        },
      };
      return query;
    },
    async rpc(name: string, args: any) {
      if (name === "commit_ses_invoice_obligation_revision_v1") {
        committedRevision = args.p_revision;
        return { data: { ok: true, state: "proposed" }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  } as unknown as SesSupabaseClient;
  return {
    client,
    committedRevision: () => committedRevision,
  };
}

Deno.test("commercial override parses Captain AJBR-70488 ceiling targets", () => {
  const parsed = parseSesCommercialQuantityOverride(AJBR_70488);
  assertEquals(parsed.trade_reported_hours_per_trade, 2);
  assertEquals(parsed.sealed_billable_hours_floor, 2);
  assertEquals(parsed.lines.length, 2);
  assertEquals(parsed.lines[0].line_kind, "labour");
  assertEquals(parsed.lines[0].quantity, 2.5);
  assertEquals(parsed.lines[1].unit_price_ex_gst, 45);
});

Deno.test("staff-locked $120 figure overrides a missing-pricing hold and the AJS floor", async () => {
  const docket = missingPricingDocket();
  const fixture = preparationClient(docket);
  const result = await prepareSesInvoiceObligationAction(
    fixture.client,
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-0000-0000-000000000001",
      job_id: docket.job_id,
      docket_revision_id: docket.id,
      created_by: "fm/locked-figure-test",
      commercial_quantity_override: STAFF_LOCKED_120,
    },
  );

  assertEquals(result.state, "prepared");
  assertEquals(
    result.proposal.pricing_disposition,
    "priced_with_line_override",
  );
  assertEquals(result.proposal.totals, { ex: 120, inc: 132 });
  assertEquals(result.proposal.lines.length, 1);
  assertEquals(result.proposal.lines[0].quantity, 1.5);
  assertEquals(result.proposal.lines[0].unit_price, 80);
  assertEquals(result.proposal.lines[0].rate_override_by, "Operations staff");
  assertEquals(
    (result.proposal as any).commercial_quantity_override.authorised_by,
    "Operations staff",
  );
  assertEquals(
    fixture.committedRevision().proposal.totals,
    { ex: 120, inc: 132 },
  );
  assertEquals(docket.local_invoice_proposal.state, "price_unresolved");
});

Deno.test("missing pricing without a locked figure still refuses before money", async () => {
  const docket = missingPricingDocket();
  const fixture = preparationClient(docket);
  const error = await assertRejects(
    () =>
      prepareSesInvoiceObligationAction(
        fixture.client,
        { mode: "api_key", user: null },
        {
          org_id: "00000000-0000-0000-0000-000000000001",
          job_id: docket.job_id,
          docket_revision_id: docket.id,
          created_by: "fm/no-locked-figure-test",
        },
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  // Commercial taste flags no longer wall mint; a true draft-zero
  // (price_unresolved / no amount) still refuses before money.
  assertStringIncludes(error.message, "no amount");
  assertEquals(fixture.committedRevision(), null);
});

Deno.test("commercial override builds separate labour and materials lines at sealed rate", () => {
  const { lines, provenance } = buildCommercialQuantityOverrideLines({
    override: AJBR_70488,
    docket_revision_id: "docket-1",
    attendance_cycle_ids: ["cycle-1"],
    sealed_labour_unit_price_ex_gst: 80,
    builder_reference: "AJBR-70488",
  });
  assertEquals(lines.length, 2);
  assertEquals(lines[0].quantity, 2.5);
  assertEquals(lines[0].unit_price, 80);
  assertEquals(lines[1].quantity, 1);
  assertEquals(lines[1].unit_price, 45);
  assertEquals(lines[0].rate_override_approved, true);
  assertEquals(lines[0].rate_override_by, "Captain");
  assertEquals(
    (lines[0].evidence as any).override_kind,
    "commercial_quantity_not_rate",
  );
  assertEquals(
    (lines[0].evidence as any).trade_reported_hours_per_trade,
    2,
  );
  assertEquals(provenance.decision_key, "ajbr-remint-25h-commercial-v1");
  const ex = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  assertEquals(ex, 245);
  assertEquals(Math.round(ex * 1.1 * 100) / 100, 269.5);
});

Deno.test("commercial override AJBR-70487 roof totals 260 ex / 286 inc", () => {
  const { lines } = buildCommercialQuantityOverrideLines({
    override: AJBR_70487,
    docket_revision_id: "docket-2",
    attendance_cycle_ids: ["cycle-1"],
    sealed_labour_unit_price_ex_gst: 80,
    builder_reference: "AJBR-70487",
  });
  const ex = lines.reduce((s, l) => s + l.quantity * l.unit_price, 0);
  assertEquals(ex, 260);
  assertEquals(Math.round(ex * 1.1 * 100) / 100, 286);
  assertStringIncludes(lines[0].description, "2.5 hours");
  assertStringIncludes(lines[1].description.toLowerCase(), "timber");
});

Deno.test("commercial override refuses a false labour rate that reaches a total", () => {
  assertRejects(
    async () => {
      buildCommercialQuantityOverrideLines({
        override: {
          ...AJBR_70488,
          lines: [{
            line_kind: "labour",
            description: "fake rate path",
            // 2.0h * 100 = 200 — false rate trap
            quantity: 2,
            unit_price_ex_gst: 100,
          }],
        },
        docket_revision_id: "docket-1",
        attendance_cycle_ids: ["cycle-1"],
        sealed_labour_unit_price_ex_gst: 80,
        builder_reference: "AJBR-70488",
      });
    },
    SesCommercialQuantityOverrideError,
    "sealed schedule rate",
  );
});

Deno.test("commercial override accepts Captain labour_rate_override for this card only", () => {
  const { lines, provenance } = buildCommercialQuantityOverrideLines({
    override: {
      schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
      authorised_by: "Captain Marnin Stobbe",
      authorised_at: "2026-08-06T00:00:00.000Z",
      decision_key: "mosman-park-remint-v1",
      reason:
        "Captain after-hours rate $100 and commercial materials/glass for Mosman Park only; sealed MLB $85 unchanged globally.",
      trade_reported_hours_per_trade: 5,
      sealed_billable_hours_floor: 3,
      labour_rate_override: {
        sealed_unit_price_ex_gst: 85,
        authorised_unit_price_ex_gst: 100,
        reason: "after hours",
      },
      lines: [
        {
          line_kind: "labour",
          description:
            "MLB-27482 - make-safe attendance - 1 trade x 5 hours (after hours)",
          quantity: 5,
          unit_price_ex_gst: 100,
        },
        {
          line_kind: "materials",
          description:
            "MLB-27482 - Materials: structural timber 8m + ply 12mm 2.4x1.8 x3 + screws",
          quantity: 1,
          unit_price_ex_gst: 267.3,
        },
        {
          line_kind: "materials",
          description: "MLB-27482 - Glass disposal",
          quantity: 1,
          unit_price_ex_gst: 70,
        },
      ],
    },
    docket_revision_id: "docket-mosman",
    attendance_cycle_ids: ["cycle-mosman"],
    sealed_labour_unit_price_ex_gst: 85,
    builder_reference: "MLB-27482",
  });
  assertEquals(lines.length, 3);
  assertEquals(lines[0].quantity, 5);
  assertEquals(lines[0].unit_price, 100);
  assertEquals(lines[1].unit_price, 267.3);
  assertEquals(lines[2].unit_price, 70);
  assertEquals(
    (lines[0].evidence as any).override_kind,
    "commercial_rate_override",
  );
  assertEquals(
    (lines[0].evidence as any).labour_rate_override
      .authorised_unit_price_ex_gst,
    100,
  );
  assertEquals(
    (lines[0].evidence as any).labour_rate_override.sealed_unit_price_ex_gst,
    85,
  );
  assertEquals(provenance.override_kind, "commercial_rate_override");
  const ex = Math.round(
    lines.reduce((s, l) => s + l.quantity * l.unit_price, 0) * 100,
  ) / 100;
  assertEquals(ex, 837.3);
  assertEquals(Math.round(ex * 1.1 * 100) / 100, 921.03);
});

Deno.test("commercial rate override refuses when sealed stamp mismatches U4 sealed rate", () => {
  assertRejects(
    async () => {
      buildCommercialQuantityOverrideLines({
        override: {
          schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
          authorised_by: "Captain",
          authorised_at: "2026-08-06T00:00:00.000Z",
          decision_key: "bad-sealed-stamp",
          reason: "test",
          trade_reported_hours_per_trade: 5,
          sealed_billable_hours_floor: 3,
          labour_rate_override: {
            sealed_unit_price_ex_gst: 80,
            authorised_unit_price_ex_gst: 100,
            reason: "after hours",
          },
          lines: [{
            line_kind: "labour",
            description: "x",
            quantity: 5,
            unit_price_ex_gst: 100,
          }],
        },
        docket_revision_id: "d",
        attendance_cycle_ids: ["c"],
        sealed_labour_unit_price_ex_gst: 85,
        builder_reference: "MLB-1",
      });
    },
    SesCommercialQuantityOverrideError,
    "does not match the U4 sealed schedule rate",
  );
});

Deno.test("commercial override refuses missing staff provenance", () => {
  assertRejects(
    async () => {
      parseSesCommercialQuantityOverride({
        schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
        authorised_by: "",
        authorised_at: "2026-08-05T00:00:00.000Z",
        decision_key: "x",
        reason: "y",
        trade_reported_hours_per_trade: 2,
        sealed_billable_hours_floor: 2,
        lines: AJBR_70488.lines,
      });
    },
    SesCommercialQuantityOverrideError,
    "authorised_by",
  );
});

Deno.test("prepare_ses_invoice_obligation applies commercial override without touching docket labour", async () => {
  const docket = {
    id: "40000000-0000-4000-8000-00000000d001",
    job_id: "6006c332-3bb5-473e-beda-bef627172784",
    stage: "pre_xero",
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    attendance_cycle_ids: ["20000000-0000-4000-8000-000000000001"],
    current_attendance_cycle_id: "20000000-0000-4000-8000-000000000001",
    envelope: { v2: { routing: { builder: "aj" } } },
    local_invoice_proposal: {
      builder_reference: "AJBR-70488",
      // Sealed schedule path: trade 2.0h at floor 2 → 2h * 80
      reported_hours_per_trade: 2,
      billable_hours_per_trade: 2,
      billable_hours_floor: 2,
      line_items: [{
        description: "AJBR-70488 - make-safe attendance - 1 trade x 2 hours",
        quantity: 2,
        unit_price_ex_gst: 80,
      }],
      subtotal_ex_gst: 160,
      total_inc_gst: 176,
    },
  };
  const fixture = preparationClient(docket);

  const result = await prepareSesInvoiceObligationAction(
    fixture.client,
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-0000-0000-000000000001",
      job_id: docket.job_id,
      docket_revision_id: docket.id,
      created_by: "fm/ajbr-remint-25h-commercial-v1",
      commercial_quantity_override: AJBR_70488,
    },
  );

  assertEquals(result.state, "prepared");
  assertEquals(
    result.proposal.pricing_disposition,
    "priced_with_line_override",
  );
  assertEquals(result.proposal.totals, { ex: 245, inc: 269.5 });
  assertEquals(result.proposal.lines.length, 2);
  assertEquals(result.proposal.lines[0].quantity, 2.5);
  assertEquals(result.proposal.lines[0].unit_price, 80);
  assertEquals(result.proposal.lines[1].unit_price, 45);
  assertStringIncludes(result.proposal.lines[0].description, "2.5 hours");
  assertStringIncludes(
    result.proposal.lines[1].description.toLowerCase(),
    "timber",
  );
  // Docket sealed proposal still says 2h — we never rewrote it.
  assertEquals(docket.local_invoice_proposal.billable_hours_per_trade, 2);
  assertEquals(docket.local_invoice_proposal.reported_hours_per_trade, 2);
  // Provenance stamped on the committed proposal.
  assertEquals(
    (result.proposal as any).commercial_quantity_override.authorised_by,
    "Captain",
  );
  assertEquals(
    (result.proposal as any).commercial_quantity_override
      .trade_reported_hours_per_trade,
    2,
  );
  assertEquals(
    fixture.committedRevision().proposal.commercial_quantity_override
      .decision_key,
    "ajbr-remint-25h-commercial-v1",
  );
  assertEquals(
    (result.proposal.lines[0].evidence as any).override_kind,
    "commercial_quantity_not_rate",
  );
});


Deno.test("authority_kind defaults to staff_lock and accepts ai_proposal", () => {
  const parsed = parseSesCommercialQuantityOverride(AJBR_70488);
  assertEquals(parsed.authority_kind, "staff_lock");
  const ai = parseSesCommercialQuantityOverride({
    ...AJBR_70488,
    authority_kind: "ai_proposal",
    proposal_source: "labour-by-builder@ses-matrices/v1",
  });
  assertEquals(ai.authority_kind, "ai_proposal");
  assertEquals(ai.proposal_source, "labour-by-builder@ses-matrices/v1");
});
