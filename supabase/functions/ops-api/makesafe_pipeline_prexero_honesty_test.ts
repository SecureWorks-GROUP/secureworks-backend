// deno-lint-ignore-file no-explicit-any require-await no-import-prefix

// SES pipeline surface honesty gate (parity with the #725 board projection).
//
// THE BUG THIS GUARDS: makesafePipeline used to stamp report_pack
// pre_xero_docs_ready / review_state straight from docket.pre_xero_docs_ready.
// A report-only (assessment/roof) card with a ready-stamped U4 docket but no
// portal/report evidence therefore read presentation_kind "ready",
// pre_xero_docs_ready true, review_state READY on the pipeline surface while
// the board projection honestly refused it (live proof: SWMS-261243, ops-api
// 1153). The operator-facing values must be green only when pack honesty is
// ready AND the docket stamp is true; the raw stamp is preserved on
// docket_pre_xero_docs_ready so the board re-derive (which has portal
// captures) and the legacy ladder keep their pre-gate input.
//
// We drive the REAL _makesafePipelineForTest with a fake PostgREST client:
//   - a 261243-class assessment card (ready docket, no portal evidence) must
//     NOT read ready/true on the pipeline surface, while the raw docket stamp
//     rides on docket_pre_xero_docs_ready for the board re-derive;
//   - a 261241-class physical card (ready docket, bound report_doc_id) must
//     STAY ready/true — the gate refuses dishonest green, not honest green.
//
// Run: deno test --allow-env --allow-net=127.0.0.1 --allow-read \
//        supabase/functions/ops-api/makesafe_pipeline_prexero_honesty_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafePipelineForTest } from "./index.ts";

// Fake PostgREST client (same shape as makesafe_pagination_test's pipeline
// client): fixed rows per table, real-ish predicate + .range() semantics.
function makePipelineClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (rowsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        preds.push((r) => r?.[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        preds.push((r) => r?.[col] !== val);
        return b;
      },
      not: () => b,
      gte: () => b,
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      order: () => b,
      limit: () => b,
      range: async (from: number, to: number) => {
        const data = rows.filter((r) => preds.every((p) => p(r))).slice(
          from,
          to + 1,
        );
        return { data, error: null };
      },
      maybeSingle: async () => {
        const data = rows.filter((r) => preds.every((p) => p(r)))[0] ?? null;
        return { data, error: null };
      },
      single: async () => {
        const data = rows.filter((r) => preds.every((p) => p(r)))[0] ?? null;
        return { data, error: null };
      },
      then: (resolve: (v: any) => any) => {
        return resolve({
          data: rows.filter((r) => preds.every((p) => p(r))),
          error: null,
        });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

const RECENT = new Date(Date.now() - 3600 * 1000).toISOString();

// Two cards, both with a ready-stamped current U4 docket and no legacy sent
// state. The assessment card has NO portal evidence (the pipeline cannot load
// portal captures, so report-in fails closed there); the physical card has its
// builder report BOUND on the pack (report_doc_id) and a submitted current
// trade report, and its family requires no SWMS (non-MLB company).
export function honestyFixtureTables(): Record<string, any[]> {
  return {
    jobs: [
      {
        id: "job-assess-261243",
        job_number: "SWMS-261243",
        type: "makesafe",
        status: "in_progress",
        metadata: {},
        site_lat: -31.9,
        site_lng: 115.8,
        created_at: RECENT,
      },
      {
        id: "job-physical-261241",
        job_number: "SWMS-261241",
        type: "makesafe",
        status: "in_progress",
        metadata: {},
        site_lat: -31.9,
        site_lng: 115.8,
        created_at: RECENT,
      },
    ],
    makesafe_job_details: [
      {
        job_id: "job-assess-261243",
        report_type: "assessment",
        substatus: "awaiting_portal_completion",
        requesting_company_name: "Acme Builders",
      },
      {
        job_id: "job-physical-261241",
        substatus: "admin_to_send_report",
        requesting_company_name: "Acme Builders",
      },
    ],
    makesafe_docket_revisions_current: [
      {
        id: "docket-assess",
        job_id: "job-assess-261243",
        state: "committed",
        pre_xero_docs_ready: true,
        blockers: [],
        current_attendance_cycle_id: null,
        committed_at: RECENT,
      },
      {
        id: "docket-physical",
        job_id: "job-physical-261241",
        state: "committed",
        pre_xero_docs_ready: true,
        blockers: [],
        current_attendance_cycle_id: null,
        committed_at: RECENT,
      },
    ],
    makesafe_report_packs: [
      {
        id: "pack-physical",
        job_id: "job-physical-261241",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: "doc-physical-report",
        invoice_doc_id: null,
        swms_doc_id: null,
      },
    ],
    job_service_reports: [
      {
        job_id: "job-physical-261241",
        status: "submitted",
        submitted_at: RECENT,
        created_at: RECENT,
        cycle_number: 1,
      },
    ],
    xero_invoices: [],
    job_documents: [],
    job_assignments: [],
    job_events: [],
  };
}

export async function runHonestyPipeline(): Promise<Record<string, any>> {
  const client = makePipelineClient(honestyFixtureTables());
  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  const all = Object.values(res.columns).flat() as any[];
  const byId: Record<string, any> = {};
  for (const row of all) byId[row.id] = row;
  return byId;
}

Deno.test("261243 class: ready-stamped assessment docket must not read ready/true on the pipeline surface", async () => {
  const byId = await runHonestyPipeline();
  const card = byId["job-assess-261243"];
  assert(card, "assessment card is on the pipeline board");
  const pack = card.report_pack;
  assert(pack, "docket-backed card publishes a report_pack block");

  // The dishonest pre-fix surface: presentation ready + pre_xero true +
  // review_state READY straight off the docket stamp.
  assertEquals(
    pack.presentation_kind,
    "incomplete",
    "no portal/report evidence → presentation must not be ready",
  );
  assertEquals(
    pack.pre_xero_docs_ready,
    false,
    "operator-facing pre_xero_docs_ready is honesty-gated",
  );
  assertEquals(
    pack.review_state,
    "U4_BLOCKED",
    "review_state READY is honesty-gated",
  );
  assert(
    String(pack.presentation_reason || "").length > 0,
    "the incomplete presentation names its reason",
  );
  // The raw U4 stamp is PRESERVED so the board re-derive (which loads portal
  // captures) and the legacy ladder still see the pre-gate docket truth.
  assertEquals(
    pack.docket_pre_xero_docs_ready,
    true,
    "raw docket stamp preserved on docket_pre_xero_docs_ready",
  );
  assertEquals(pack.docket_revision_id, "docket-assess");
});

Deno.test("261241 class: physical card with bound report_doc_id stays ready/true under the honesty gate", async () => {
  const byId = await runHonestyPipeline();
  const card = byId["job-physical-261241"];
  assert(card, "physical card is on the pipeline board");
  const pack = card.report_pack;
  assert(pack, "docket-backed card publishes a report_pack block");

  assertEquals(
    pack.presentation_kind,
    "ready",
    "bound physical pack must stay ready — the gate refuses dishonest green only",
  );
  assertEquals(pack.pre_xero_docs_ready, true);
  assertEquals(pack.review_state, "READY");
  assertEquals(pack.docket_pre_xero_docs_ready, true);
  assertEquals(pack.report_doc_id, "doc-physical-report");
});
