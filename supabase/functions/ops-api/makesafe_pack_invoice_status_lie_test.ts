// deno-lint-ignore-file no-import-prefix
/**
 * SWMS-261237 / INV-1240 class: pack/review surface must not say DRAFT when
 * the live Xero mirror (and board top-level invoice_raw_status) already say
 * AUTHORISED. The pack row stamp is fallback only.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _enrichMakesafeBoardJobForTest as enrich,
  presentMakesafePackInvoiceStatus,
} from "./index.ts";

Deno.test("presentMakesafePackInvoiceStatus: live AUTHORISED beats pack DRAFT stamp", () => {
  assertEquals(
    presentMakesafePackInvoiceStatus("DRAFT", "AUTHORISED"),
    "AUTHORISED",
  );
  assertEquals(
    presentMakesafePackInvoiceStatus("draft", "AUTHORISED"),
    "AUTHORISED",
  );
});

Deno.test("presentMakesafePackInvoiceStatus: live DRAFT beats a stale AUTHORISED stamp", () => {
  // Live mirror is authority in both directions — a voided/rewound live row
  // must not keep advertising a raised stamp.
  assertEquals(
    presentMakesafePackInvoiceStatus("AUTHORISED", "DRAFT"),
    "DRAFT",
  );
});

Deno.test("presentMakesafePackInvoiceStatus: pack stamp is fallback when live is absent", () => {
  assertEquals(presentMakesafePackInvoiceStatus("DRAFT", null), "DRAFT");
  assertEquals(presentMakesafePackInvoiceStatus("DRAFT", ""), "DRAFT");
  assertEquals(presentMakesafePackInvoiceStatus(null, null), null);
  assertEquals(presentMakesafePackInvoiceStatus("  ", "  "), null);
});

Deno.test(
  "SWMS-261237 class: report_pack.invoice_status follows live AUTHORISED, not pack DRAFT stamp",
  () => {
    // Production shape measured 2026-08-18 on SAMPLE AJS SWMS-261237:
    // xero_invoices.status = AUTHORISED, makesafe_report_packs.invoice_status =
    // DRAFT, one invoice INV-1240 $352. Board top-level already published
    // AUTHORISED; pack surface lied DRAFT and could invite Approve on money
    // already authorised.
    const job = {
      id: "94bbb534-c0e8-4061-8ae0-574bd1b7377c",
      job_number: "SWMS-261237",
      status: "accepted",
      type: "makesafe",
      created_at: "2026-08-18T03:25:55.999Z",
      metadata: { external_ref: "SAMPLE-AJS-WALK-1" },
    };
    const detail = {
      substatus: "admin_to_send_report",
      external_ref: "SAMPLE-AJS-WALK-1",
      attendance_cycle_id: "f945af34-b359-4537-8ad3-a36b5d5a3e88",
      report_type: null,
    };
    const report = {
      id: "f945af34-b359-4537-8ad3-a36b5d5a3e88",
      status: "submitted",
      submitted_at: "2026-08-18T03:26:04.91Z",
      created_at: "2026-08-18T03:26:04.91Z",
      attendance_cycle_id: "f945af34-b359-4537-8ad3-a36b5d5a3e88",
      cycle_number: 1,
    };
    const liveAuthorised = {
      id: "51d81e8a-80de-4005-bb41-ac06355d3662",
      xero_invoice_id: "f6044f64-b72d-42d1-aa62-a6bb88af1381",
      job_id: job.id,
      invoice_type: "ACCREC",
      invoice_number: "INV-1240",
      status: "AUTHORISED",
      reference: "SAMPLE-AJS-WALK-1",
      total: 352,
      invoice_date: "2026-08-18",
      created_at: "2026-08-18T03:40:02.419Z",
    };
    const packStampedDraft = {
      id: "pack-261237",
      status: "drafted",
      invoice_status: "DRAFT",
      xero_invoice_id: liveAuthorised.xero_invoice_id,
      report_doc_id: "49c99067-4b57-4e53-a5b1-26027b6f7463",
      invoice_doc_id: "cf775940-f00a-4a23-83f1-85ed3a8141c8",
      swms_doc_id: null,
      pre_xero_docs_ready: true,
      cycle_attribution: "bound",
      docket_revision_id: "docket-261237",
    };
    const docs = [
      { type: "makesafe_report", id: packStampedDraft.report_doc_id },
      { type: "invoice", id: packStampedDraft.invoice_doc_id },
    ];

    const row = enrich(
      job,
      detail,
      [],
      report,
      liveAuthorised,
      docs,
      false,
      packStampedDraft,
    );

    assertEquals(row.invoice_raw_status, "AUTHORISED");
    assertEquals(row.invoice_qualifies_as_current_draft, false);
    assertEquals(row.report_pack?.invoice_status, "AUTHORISED");
    // Control: the same stamp with no live invoice still falls back to DRAFT.
    const noLive = enrich(
      job,
      detail,
      [],
      report,
      null,
      docs,
      false,
      packStampedDraft,
    );
    assertEquals(noLive.report_pack?.invoice_status, "DRAFT");
  },
);
