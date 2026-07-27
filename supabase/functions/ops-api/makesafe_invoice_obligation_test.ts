// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { prepareSesInvoiceObligation } from "./makesafe_invoice_obligation.ts";
import type { SesInvoiceDuplicateResolution } from "./makesafe_invoice_duplicate_resolver.ts";

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
