// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prepareSesInvoiceObligation } from "./makesafe_invoice_obligation.ts";
import type { SesInvoiceDuplicateResolution } from "./makesafe_invoice_duplicate_resolver.ts";
import { SES_FAMILY_MATRIX_VERSION } from "./ses_family_matrix.ts";
import {
  prepareSesInvoiceObligationAction,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "10000000-0000-4000-8000-000000000001";
const CYCLE_1 = "20000000-0000-4000-8000-000000000001";
const CYCLE_2 = "20000000-0000-4000-8000-000000000002";
const OBLIGATION = "30000000-0000-4000-8000-000000000001";

const clearProbe: SesInvoiceDuplicateResolution = {
  job_id: JOB,
  match_tier: null,
  ambiguity: "none",
  live_invoices: [],
  allows_create: true,
  reason_codes: [],
};

function base() {
  return {
    org_id: ORG,
    job_id: JOB,
    docket_revision_id: "40000000-0000-4000-8000-000000000001",
    attendance_cycle_ids: [CYCLE_1],
    pricing_disposition: "priced_from_canon" as const,
    pricing_canon_version: "pricing@sealed",
    company: "AJS/AJBR",
    reference: "AJBR 70062",
    contact_name: "AJ Grant",
    lines: [{
      description: "Make-safe attendance",
      quantity: 4,
      unit_price: 80,
      account_code: "210",
      evidence: { source: "job_service_reports", cycle_id: CYCLE_1 },
    }],
    guard_result: { hard_failures: [], warnings: [] },
    duplicate_probe: clearProbe,
    created_by: "ses-u5-test",
    allocate_uuid: () => OBLIGATION,
  };
}

Deno.test("first proposal mints opaque stable obligation and content revision", async () => {
  const result = await prepareSesInvoiceObligation(base());
  assertEquals(result.state, "prepared");
  assertEquals(result.obligation.id, OBLIGATION);
  assertEquals(result.proposal.invoice_obligation_id, OBLIGATION);
  assertEquals(result.proposal.xero, null);
  assertEquals(result.proposal.totals, { ex: 320, inc: 352 });
});

Deno.test("review invoice gates refuse with a catalogue code and preserve exact gate evidence", async () => {
  const docket = {
    id: "40000000-0000-4000-8000-000000007501",
    job_id: JOB,
    stage: "pre_xero",
    local_invoice_proposal: { line_items: [] },
    review_spec: {
      cards: [{
        invoice_gate_codes: [
          "invoice_gate",
          "materials_charge_figure_required",
        ],
      }],
    },
  };
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: docket, error: null });
        },
      };
      return query;
    },
  } as unknown as SesSupabaseClient;
  const error = await assertRejects(
    () =>
      prepareSesInvoiceObligationAction(
        client,
        { mode: "routine", user: null },
        {
          org_id: ORG,
          job_id: JOB,
          docket_revision_id: docket.id,
          created_by: "gate-test",
        },
      ),
    SesActionError,
  );
  const refusal = (error as SesActionError).refusal as Record<string, unknown>;
  assertEquals(refusal.code, "pricing_evidence_missing");
  assertEquals(typeof refusal.fact, "string");
  assertEquals(
    (refusal.evidence as Record<string, unknown>).invoice_gate_codes,
    ["invoice_gate", "materials_charge_figure_required"],
  );
});

Deno.test("exception-review identity evidence refuses invoice mint without hiding the review pack", async () => {
  const docket = {
    id: "40000000-0000-4000-8000-000000007504",
    job_id: JOB,
    stage: "pre_xero",
    local_invoice_proposal: { line_items: [] },
    review_spec: {
      cards: [{ exception_review_codes: ["draft_pack_reference_mismatch"] }],
    },
  };
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: docket, error: null });
        },
      };
      return query;
    },
  } as unknown as SesSupabaseClient;
  const error = await assertRejects(
    () =>
      prepareSesInvoiceObligationAction(
        client,
        { mode: "routine", user: null },
        {
          org_id: ORG,
          job_id: JOB,
          docket_revision_id: docket.id,
          created_by: "exception-review-test",
        },
      ),
    SesActionError,
  );
  const refusal = (error as SesActionError).refusal as Record<string, unknown>;
  assertEquals(refusal.code, "pricing_evidence_missing");
  assertEquals(
    (refusal.evidence as Record<string, unknown>).exception_review_codes,
    ["draft_pack_reference_mismatch"],
  );
});

Deno.test("Bertram persisted docket reaches prepare_ses_invoice_obligation at $750 ex and $825 inc", async () => {
  const docket = {
    id: "40000000-0000-4000-8000-000000007502",
    job_id: "208450c0-7161-4b30-9514-66226b054609",
    stage: "pre_xero",
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    attendance_cycle_ids: [CYCLE_1],
    current_attendance_cycle_id: CYCLE_1,
    envelope: {
      v2: { routing: { builder: "AJS/AJBR" } },
    },
    local_invoice_proposal: {
      builder_reference: "AJBR-70271",
      line_items: [{
        description: "AJBR-70271 - make-safe attendance - 2 trades x 3 hours",
        quantity: 6,
        unit_price_ex_gst: 80,
      }, {
        description:
          "AJBR-70271 - Star pickets supplied to prop and secure existing fence",
        quantity: 20,
        unit_price_ex_gst: 13.5,
      }],
      subtotal_ex_gst: 750,
      gst: 75,
      total_inc_gst: 825,
    },
  };
  const rows: Record<string, unknown> = {
    makesafe_docket_revisions: docket,
    makesafe_invoice_obligation_revisions_current: null,
    xero_invoices: [],
  };
  const client = {
    from(table: string) {
      const response = () => ({ data: rows[table] ?? null, error: null });
      const query = {
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
        then(resolve: (value: ReturnType<typeof response>) => unknown) {
          return Promise.resolve(response()).then(resolve);
        },
      };
      return query;
    },
    rpc() {
      return Promise.resolve({
        data: { state: "proposed", committed: true },
        error: null,
      });
    },
    storage: { from: () => ({}) },
  } as unknown as SesSupabaseClient;

  const result = await prepareSesInvoiceObligationAction(
    client,
    { mode: "routine", user: null },
    {
      org_id: ORG,
      job_id: docket.job_id,
      docket_revision_id: docket.id,
      created_by: "bertram-regression",
    },
  );
  assertEquals(result.state, "prepared");
  assertEquals(result.blockers, []);
  assertEquals(result.proposal.totals, { ex: 750, inc: 825 });
  assertEquals(result.proposal.lines.length, 2);
  assertEquals(result.external_mutations, { xero: 0, email: 0 });
});

Deno.test("a docket priced under a superseded family matrix refuses the mint with docket_pricing_stale", async () => {
  const docket = {
    id: "40000000-0000-4000-8000-000000007503",
    job_id: "208450c0-7161-4b30-9514-66226b054609",
    stage: "pre_xero",
    family_matrix_version: "ses-builder-family-matrix/2026-07-30.6",
    attendance_cycle_ids: [CYCLE_1],
    current_attendance_cycle_id: CYCLE_1,
    envelope: { v2: { routing: { builder: "MLB" } } },
    local_invoice_proposal: {
      builder_reference: "MLB-27148",
      line_items: [{
        description: "MLB-27148 - Double Storey roof report",
        quantity: 1,
        unit_price_ex_gst: 350,
      }],
      subtotal_ex_gst: 350,
      gst: 35,
      total_inc_gst: 385,
    },
  };
  const rows: Record<string, unknown> = {
    makesafe_docket_revisions: docket,
    makesafe_invoice_obligation_revisions_current: null,
    xero_invoices: [],
  };
  const client = {
    from(table: string) {
      const response = () => ({ data: rows[table] ?? null, error: null });
      const query = {
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
        then(resolve: (value: ReturnType<typeof response>) => unknown) {
          return Promise.resolve(response()).then(resolve);
        },
      };
      return query;
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
    storage: { from: () => ({}) },
  } as unknown as SesSupabaseClient;

  const error = await assertRejects(
    () =>
      prepareSesInvoiceObligationAction(
        client,
        { mode: "routine", user: null },
        {
          org_id: ORG,
          job_id: docket.job_id,
          docket_revision_id: docket.id,
          created_by: "stale-guard-test",
        },
      ),
    SesActionError,
  );
  const refusal = (error as SesActionError).refusal as Record<string, unknown>;
  assertEquals(refusal.code, "docket_pricing_stale");
  const evidence = refusal.evidence as Record<string, unknown>;
  assertEquals(
    evidence.docket_family_matrix_version,
    "ses-builder-family-matrix/2026-07-30.6",
  );
  assertEquals(
    evidence.current_family_matrix_version,
    SES_FAMILY_MATRIX_VERSION,
  );
});

Deno.test("pre-release cycle change keeps obligation but supersedes revision", async () => {
  const first = await prepareSesInvoiceObligation(base());
  const next = await prepareSesInvoiceObligation({
    ...base(),
    attendance_cycle_ids: [CYCLE_2, CYCLE_1],
    existing: {
      obligation_id: OBLIGATION,
      revision_id: String(first.revision.id),
      state: "proposed",
    },
  });
  assertEquals(next.obligation.id, OBLIGATION);
  assertEquals(
    next.revision.supersedes_revision_id,
    first.revision.id,
  );
  assert(next.revision.id !== first.revision.id);
  assertEquals(next.proposal.attendance_cycle_ids, [CYCLE_1, CYCLE_2]);
});

Deno.test("post-release attendance is blocked until human disposition", async () => {
  const result = await prepareSesInvoiceObligation({
    ...base(),
    attendance_cycle_ids: [CYCLE_2],
    existing: {
      obligation_id: OBLIGATION,
      revision_id: "50000000-0000-4000-8000-000000000001",
      state: "released",
      released_cycle_ids: [CYCLE_1],
    },
  });
  assertEquals(result.state, "blocked");
  assertEquals(
    result.blockers[0].decision_key,
    "post-release-reattend-disposition",
  );
  assert(
    result.blockers[0].fact.includes("later attendance"),
    "refusal must name the real missing billing disposition",
  );
});

Deno.test("post-release second_invoice mints a new obligation for current cycle", async () => {
  const NEW_OBLIGATION = "30000000-0000-4000-8000-000000000002";
  const result = await prepareSesInvoiceObligation({
    ...base(),
    attendance_cycle_ids: [CYCLE_2],
    allocate_uuid: () => NEW_OBLIGATION,
    existing: {
      obligation_id: OBLIGATION,
      revision_id: "50000000-0000-4000-8000-000000000001",
      state: "released",
      released_cycle_ids: [CYCLE_1],
    },
    post_release_disposition: "second_invoice",
  });
  assertEquals(result.obligation.id, NEW_OBLIGATION);
  assertEquals(result.obligation.supersedes_obligation_id, OBLIGATION);
  assertEquals(result.proposal.attendance_cycle_ids, [CYCLE_2]);
});

Deno.test("post-release document_only mints no-charge obligation and no Xero lines", async () => {
  const NEW_OBLIGATION = "30000000-0000-4000-8000-000000000003";
  const result = await prepareSesInvoiceObligation({
    ...base(),
    attendance_cycle_ids: [CYCLE_2],
    pricing_disposition: "no_additional_charge",
    lines: [],
    duplicate_probe: {
      ...clearProbe,
      allows_create: false,
      match_tier: "job_id",
      live_invoices: [{
        job_id: JOB,
        xero_invoice_id: "xero-prior",
        invoice_number: "INV-PRIOR",
        status: "AUTHORISED",
        reference: "AJBR 70062",
      }],
      reason_codes: ["blocked_duplicate_live"],
    },
    allocate_uuid: () => NEW_OBLIGATION,
    existing: {
      obligation_id: OBLIGATION,
      revision_id: "50000000-0000-4000-8000-000000000001",
      state: "released",
      released_cycle_ids: [CYCLE_1],
    },
    post_release_disposition: "document_only",
  });
  assertEquals(result.state, "prepared");
  assertEquals(result.obligation.supersedes_obligation_id, OBLIGATION);
  assertEquals(result.proposal.pricing_disposition, "no_additional_charge");
  assertEquals(result.proposal.lines, []);
  assertEquals(result.proposal.totals, { ex: 0, inc: 0 });
  assertEquals(result.blockers, []);
});

Deno.test("unproved price produces concrete refusal and no executable revision", async () => {
  const result = await prepareSesInvoiceObligation({
    ...base(),
    pricing_disposition: "blocked_missing_evidence",
    lines: [],
  });
  assertEquals(result.state, "blocked");
  assertEquals(
    result.blockers[0].fact,
    "The current evidence does not prove the invoice price.",
  );
  assertEquals(result.revision.blockers, result.blockers);
});

Deno.test("the production branch mints an id without an injected allocator", async () => {
  // Regression: `(input.allocate_uuid || crypto.randomUUID)()` detached the native method from its
  // Crypto receiver and threw "Illegal invocation" in Deno. Every other test in this file injects
  // `allocate_uuid`, so the branch production actually takes was never exercised and the bug
  // reached prepare_ses_invoice_obligation live, failing all four cards with HTTP 500.
  const input = base();
  delete (input as { allocate_uuid?: unknown }).allocate_uuid;
  const result = await prepareSesInvoiceObligation(input);
  assertEquals(result.state, "prepared");
  const minted = String(result.obligation.id);
  assertMatch(
    minted,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    `expected a real UUID, got ${minted}`,
  );
  assertEquals(result.proposal.invoice_obligation_id, minted);

  // Two runs without an allocator must mint two distinct obligations, so the fix cannot be a
  // constant standing in for the native generator.
  const again = await prepareSesInvoiceObligation(
    (() => {
      const other = base();
      delete (other as { allocate_uuid?: unknown }).allocate_uuid;
      return other;
    })(),
  );
  assertNotEquals(again.obligation.id, minted);
});
