// deno-lint-ignore-file no-import-prefix
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

Deno.test("commercial override parses Captain AJBR-70488 ceiling targets", () => {
  const parsed = parseSesCommercialQuantityOverride(AJBR_70488);
  assertEquals(parsed.trade_reported_hours_per_trade, 2);
  assertEquals(parsed.sealed_billable_hours_floor, 2);
  assertEquals(parsed.lines.length, 2);
  assertEquals(parsed.lines[0].line_kind, "labour");
  assertEquals(parsed.lines[0].quantity, 2.5);
  assertEquals(parsed.lines[1].unit_price_ex_gst, 45);
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

Deno.test("commercial override refuses missing Captain provenance", () => {
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
        then(resolve: (v: unknown) => unknown) {
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

  const result = await prepareSesInvoiceObligationAction(
    client,
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
  assertEquals(result.proposal.pricing_disposition, "priced_with_line_override");
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
    committedRevision.proposal.commercial_quantity_override.decision_key,
    "ajbr-remint-25h-commercial-v1",
  );
  assertEquals(
    (result.proposal.lines[0].evidence as any).override_kind,
    "commercial_quantity_not_rate",
  );
});
