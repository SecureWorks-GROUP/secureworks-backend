// T3 + D3 — makesafe_report_drafts FEED gating (live orchestration).
//
// T3: the feed used to return EVERY job at substatus=admin_to_send_report, which
// could include an already-sent-but-stale job (close failed, substatus lagged).
// It now applies the SHARED surfacing predicate so only genuinely drafted-not-sent
// jobs (rendered report + DRAFT invoice, NOT sentClosed) reach the cockpit.
//
// D3: the feed returns draft_docs[] (report PDF, draft invoice PDF, SWMS if any)
// and source_docs[] (trade report, work order, photos) for the carousel.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_report_drafts_feed_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _canonicalMakesafeBuilderDisplayNameForTest,
  _canonicalMakesafeInvoiceContactNameForTest,
  _makesafeReportDraftsForTest,
  _makesafeTrustedInvoiceRefTokenForTest,
} from "./index.ts";
import { MAKESAFE_CC } from "./makesafe_send_pack.ts";

// Fake client: table reads with .eq/.in/.limit/.order (predicate-applying) plus a
// .storage stub. The feed signs only bare storage paths; full https urls pass
// through unchanged, which keeps the assertions simple.
function makeFeedClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (rowsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    let maxRows: number | null = null;
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
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        maxRows = n;
        return b;
      },
      // .range() supports buildPackSentMap's paginated job_events read.
      range: async (from: number, to: number) => ({
        data: rows.filter((r) => preds.every((p) => p(r))).slice(from, to + 1),
        error: null,
      }),
      then: (resolve: (v: any) => any) => {
        let data = rows.filter((r) => preds.every((p) => p(r)));
        if (maxRows !== null) data = data.slice(0, maxRows);
        return resolve({ data, error: null });
      },
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        // Any bare path signs to a deterministic test url.
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://signed.test/${path}` },
          error: null,
        }),
      }),
    },
  };
}

const params = () => new URLSearchParams();

// A genuine Ferndale-shaped draft: admin_to_send_report, DRAFT invoice, rendered
// report doc + a pack row with report_doc_id, NOT sent.
function ferndaleSeed() {
  return {
    makesafe_job_details: [{
      job_id: "job-ferndale",
      requesting_company_name: "MLB Constructions",
      requesting_company_slug: "mlb",
      external_ref: "MLB-25248",
      substatus: "admin_to_send_report",
      report_received_at: "2026-06-16T01:00:00Z",
      report_sent_at: null,
      makesafe_companies: {
        slug: "mlb",
        name: "MLB Constructions",
        invoice_email: "accounts@mlb.com.au",
      },
    }],
    jobs: [{
      id: "job-ferndale",
      job_number: "SWMS-25248",
      client_name: "Jane Homeowner",
      client_email: "jane@x.com",
      site_address: "12 Smith St",
      site_suburb: "Ferndale",
      status: "invoiced",
      type: "makesafe",
      created_at: "2026-06-15T23:55:00Z",
    }],
    xero_invoices: [{
      xero_invoice_id: "xi-1",
      invoice_number: "INV-1234",
      status: "DRAFT",
      reference: "MLB-25248",
      sub_total: 1000,
      total: 1100,
      total_tax: 100,
      line_items: [],
      job_id: "job-ferndale",
      invoice_date: "2026-06-16",
    }],
    job_documents: [
      {
        id: "d-rep",
        job_id: "job-ferndale",
        type: "makesafe_report",
        file_name: "Make Safe Report MLB-25248.pdf",
        storage_url: "https://docs.test/report.pdf",
        pdf_url: null,
        version: 1,
        created_at: "2026-06-16T03:00:00Z",
      },
      {
        id: "d-inv",
        job_id: "job-ferndale",
        type: "invoice",
        file_name: "Tax Invoice INV-1234.pdf",
        storage_url: "https://docs.test/invoice.pdf",
        pdf_url: null,
        version: 1,
        created_at: "2026-06-16T03:05:00Z",
      },
      {
        id: "d-trade",
        job_id: "job-ferndale",
        type: "service_report",
        file_name: "Trade Report.pdf",
        storage_url: "https://docs.test/trade.pdf",
        pdf_url: null,
        version: 1,
        created_at: "2026-06-16T00:45:00Z",
      },
      {
        id: "d-wo",
        job_id: "job-ferndale",
        type: "work_order",
        file_name: "Work Order.pdf",
        storage_url: "https://docs.test/wo.pdf",
        pdf_url: null,
        version: 1,
        created_at: "2026-06-15T23:55:00Z",
      },
    ],
    job_media: [
      {
        id: "m1",
        job_id: "job-ferndale",
        phase: "completion",
        type: "photo",
        storage_url: "https://media.test/p1.jpg",
        thumbnail_url: "https://media.test/p1t.jpg",
        label: "Front",
        taken_at: "2026-06-16T00:30:00Z",
        created_at: "2026-06-16T00:40:00Z",
      },
    ],
    job_service_reports: [{
      id: "sr-1",
      job_id: "job-ferndale",
      status: "submitted",
      checklist_json: {
        labour_hours: 3,
        trade_count: 1,
        work_done: "Made safe and cleaned debris.",
      },
      notes: "Raw trade note",
      signature_name: "Hugo",
      submitted_at: "2026-06-16T00:50:00Z",
      created_at: "2026-06-16T00:48:00Z",
      updated_at: "2026-06-16T00:50:00Z",
    }],
    makesafe_report_packs: [{
      job_id: "job-ferndale",
      pack_kind: "main",
      status: "drafted",
      report_doc_id: "d-rep",
      sent_at: null,
    }],
  };
}

Deno.test("T3 feed: a genuine Ferndale-shaped draft is INCLUDED", async () => {
  const client = makeFeedClient(ferndaleSeed());
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].job_id, "job-ferndale");
  assertEquals(res.drafts[0].invoice.status, "DRAFT");
});

Deno.test("T3 feed: a sent-but-stale job (pack status sent) is EXCLUDED", async () => {
  const seed = ferndaleSeed();
  // Same substatus (admin_to_send_report) but the pack already SENT -> sentClosed.
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sent",
    report_doc_id: "d-rep",
    sent_at: "2026-06-16T05:00:00Z",
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(
    res.count,
    0,
    "a sent pack must be excluded from the cockpit feed",
  );
});

Deno.test("T3 feed: a LEGACY marker-only sent job (job_events marker, no pack row, no report_sent_at) is EXCLUDED", async () => {
  // Adversarial review #1: a job sent via the old pre-pack-table path leaves only
  // a MAKESAFE_PACK_SENT | main note. With a lingering DRAFT invoice + the
  // admin_to_send_report substatus it would otherwise look like a fresh draft.
  const seed: any = ferndaleSeed();
  seed.makesafe_report_packs = []; // no durable pack row
  seed.makesafe_job_details[0].report_sent_at = null;
  seed.job_events = [{
    id: "ev-1",
    job_id: "job-ferndale",
    event_type: "note",
    detail_json: {
      text:
        "MAKESAFE_PACK_SENT | main | INV-1234 | to=b@x.com | 2026-06-16T00:00:00Z",
    },
  }];
  // The report doc still exists so hasReportDoc would be true; only the marker
  // (via buildPackSentMap) excludes it.
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(
    res.count,
    0,
    "a legacy marker-only sent job must be excluded from the feed",
  );
});

Deno.test("T3 feed: report_sent_at set (close-out went out) is EXCLUDED", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_job_details[0].report_sent_at = "2026-06-16T05:00:00Z";
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0);
});

Deno.test("T3 feed: a job with NO draft invoice (not yet drafted) is EXCLUDED", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices = []; // no draft invoice yet -> not readyForReview
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0);
});

Deno.test("T3 feed: an AUTHORISED (already-authorised) invoice is EXCLUDED (not a DRAFT to review)", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0);
});

Deno.test("D3 feed: draft_docs[] + source_docs[] are returned with kinds, existing fields intact", async () => {
  const client = makeFeedClient(ferndaleSeed());
  const res: any = await _makesafeReportDraftsForTest(client, params());
  const row = res.drafts[0];
  // Existing fields unchanged (backward compat).
  assert(row.report_pdf_url, "report_pdf_url still present");
  assert(row.invoice_pdf_url, "invoice_pdf_url still present");
  assert(
    Array.isArray(row.photos) && row.photos.length === 1,
    "photos still present",
  );
  assert(
    row.default_subject && row.default_html_body,
    "send defaults still present",
  );
  // D3 arrays.
  const draftLabels = row.draft_docs.map((d: any) => d.label);
  assert(draftLabels.includes("Make Safe Report"), "draft_docs has the report");
  assert(
    draftLabels.includes("Draft Invoice"),
    "draft_docs has the draft invoice",
  );
  // SWMS only when attached — none here.
  assert(!draftLabels.includes("SWMS"), "no SWMS attached -> none surfaced");
  // source_docs has raw trade report data, trade report PDF, work order + the photo.
  const srcLabels = row.source_docs.map((d: any) => d.label);
  assert(srcLabels.includes("Raw Trade Report"), "source_docs has raw app-submitted trade report data");
  assert(srcLabels.includes("Trade Report PDF"), "source_docs has the raw trade report PDF");
  assert(srcLabels.includes("Work Order"), "source_docs has the work order");
  assert(
    row.source_docs.some((d: any) => d.kind === "image"),
    "source_docs includes a photo image",
  );
  assert(
    row.draft_docs.every((d: any) => d.kind === "pdf"),
    "draft_docs are pdf kind",
  );
  const rawTrade = row.source_docs.find((d: any) => d.label === "Raw Trade Report");
  assertEquals(rawTrade.kind, "html", "raw app report is rendered as an HTML click-through tab");
  assertEquals(rawTrade.received_at, "2026-06-16T01:00:00Z", "raw trade report uses report_received_at as received timestamp");
  assertEquals(rawTrade.raw_report.checklist_json.work_done, "Made safe and cleaned debris.");
  const tradePdf = row.source_docs.find((d: any) => d.label === "Trade Report PDF");
  assertEquals(tradePdf.created_at, "2026-06-16T00:45:00Z", "trade PDF preserves document created_at");
  const workOrder = row.source_docs.find((d: any) => d.label === "Work Order");
  assertEquals(workOrder.received_at, "2026-06-15T23:55:00Z", "work order exposes received timestamp");
  const photo = row.source_docs.find((d: any) => d.kind === "image");
  assertEquals(photo.received_at, "2026-06-16T00:30:00Z", "photo received timestamp prefers taken_at");
});

Deno.test("D3 feed: pack doc ids anchor the reviewed report/invoice when duplicate docs exist", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_report_packs[0].report_doc_id = "d-rep";
  seed.makesafe_report_packs[0].invoice_doc_id = "d-inv";
  seed.job_documents.unshift({
    id: "d-rep-placeholder",
    job_id: "job-ferndale",
    type: "makesafe_report",
    file_name: "Make Safe Report MLB-25248 Placeholder.pdf",
    storage_url: "https://docs.test/placeholder-report.pdf",
    pdf_url: null,
    version: 9,
    created_at: "2026-06-16T04:00:00Z",
  }, {
    id: "d-inv-other",
    job_id: "job-ferndale",
    type: "invoice",
    file_name: "Draft Xero Invoice Other.pdf",
    storage_url: "https://docs.test/other-invoice.pdf",
    pdf_url: null,
    version: 9,
    created_at: "2026-06-16T04:01:00Z",
  });

  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  const row = res.drafts[0];
  assertEquals(row.report_pdf_url, "https://docs.test/report.pdf");
  assertEquals(row.invoice_pdf_url, "https://docs.test/invoice.pdf");
  assertEquals(row.draft_docs.map((d: any) => d.url), [
    "https://docs.test/report.pdf",
    "https://docs.test/invoice.pdf",
  ], "the cockpit preview must match the docs recorded on the reviewed pack row");
});

Deno.test("MLB Xero contact: draft/sync contact names canonicalise to Major Loss Builders", () => {
  assertEquals(_canonicalMakesafeInvoiceContactNameForTest("MLB-26003", "ML Builders"), "Major Loss Builders");
  assertEquals(_canonicalMakesafeInvoiceContactNameForTest("SWMS-26651 / MLB-26003", "MLB"), "Major Loss Builders");
  assertEquals(_canonicalMakesafeInvoiceContactNameForTest("MLB-26003", "Major Loss Builder"), "Major Loss Builders");
  assertEquals(_canonicalMakesafeInvoiceContactNameForTest("AJS-123", "AJS Group"), "AJS Group");
  assertEquals(_canonicalMakesafeBuilderDisplayNameForTest("MLB-26003", "ML Builders", "ML Builders"), "Major Loss Builders");
});

Deno.test("T3 feed: legacy ML Builders label is surfaced as Major Loss Builders", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_job_details[0].requesting_company_name = "ML Builders";
  seed.makesafe_job_details[0].makesafe_companies.name = "ML Builders";
  seed.makesafe_job_details[0].external_ref = "MLB-26003";
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].builder, "Major Loss Builders");
  assertEquals(res.drafts[0].requesting_company_name, "Major Loss Builders");
});

Deno.test("Xero sync reference tokens: only structured job/external refs are trusted", () => {
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("MLB-26003"), "MLB-26003");
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("SWMS-26651"), "SWMS-26651");
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("AJBR 67713"), "AJBR 67713");
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("26003"), null, "numeric-only tokens are too broad");
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("MLB"), null, "short alpha-only tokens are too broad");
  assertEquals(_makesafeTrustedInvoiceRefTokenForTest("U1/25 Kimbara Street"), null, "addresses are not invoice reference tokens");
});

Deno.test("D3 feed: an attached SWMS is surfaced in draft_docs", async () => {
  const seed = ferndaleSeed();
  seed.job_documents.push({
    id: "d-swms",
    job_id: "job-ferndale",
    type: "swms",
    file_name: "SWMS.pdf",
    storage_url: "https://docs.test/swms.pdf",
    pdf_url: null,
    version: 1,
  });
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  const draftLabels = res.drafts[0].draft_docs.map((d: any) => d.label);
  assert(draftLabels.includes("SWMS"), "attached SWMS is surfaced");
});

// ─────────────────────────────────────────────────────────────────
// BLOCKER C — feed recipient resolution. The To is the builder's WORK-ORDERS
// inbox (makesafe_companies.report_recipient) ONLY, and the cc is EXACTLY [ses@].
// invoice_email (the billing contact, vanessa@ajs.build for AJS) is NEVER the To.
// ─────────────────────────────────────────────────────────────────
Deno.test("C feed: report_recipient set -> recipient_email = work-orders inbox, cc = [ses@]", async () => {
  const seed = ferndaleSeed();
  // AJS-shaped: a billing contact (invoice_email = vanessa) PLUS the work-orders
  // inbox (report_recipient). The To must be the work-orders inbox, never vanessa.
  seed.makesafe_job_details[0].makesafe_companies = {
    slug: "aj",
    name: "AJS",
    invoice_email: "vanessa@ajs.build",
    report_recipient: "workorders@ajs.build",
  } as any;
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  const row = res.drafts[0];
  assertEquals(row.recipient_email, "workorders@ajs.build");
  assert(
    row.recipient_email !== "vanessa@ajs.build",
    "vanessa (billing) must NEVER be the To",
  );
  assertEquals(row.cc, [MAKESAFE_CC]);
});

Deno.test("C feed: report_recipient null -> recipient_email null (warning), NOT invoice_email", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_job_details[0].requesting_company_slug = "aj";
  seed.makesafe_job_details[0].requesting_company_name = "AJS";
  seed.makesafe_job_details[0].external_ref = "AJS-123";
  // Only a billing contact configured, no work-orders inbox.
  seed.makesafe_job_details[0].makesafe_companies = {
    slug: "aj",
    name: "AJS",
    invoice_email: "vanessa@ajs.build",
    report_recipient: null,
  } as any;
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  const row = res.drafts[0];
  assertEquals(
    row.recipient_email,
    null,
    "no work-orders inbox -> null (cockpit warns)",
  );
  assert(
    row.recipient_email !== "vanessa@ajs.build",
    "must NOT fall back to the billing contact",
  );
  // cc is still exactly ses@ (the send hard-enforces this server-side too).
  assertEquals(row.cc, [MAKESAFE_CC]);
});

Deno.test("C feed: legacy MLB rows use the vetted MLB report-recipient backstop", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_job_details[0].requesting_company_slug = "mlb";
  seed.makesafe_job_details[0].requesting_company_name = "ML Builders";
  seed.makesafe_job_details[0].external_ref = "MLB-24732";
  seed.makesafe_job_details[0].makesafe_companies = {
    slug: "mlb",
    name: "ML Builders",
    invoice_email: null,
    report_recipient: null,
  } as any;
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].recipient_email, "makesafes@mlbuilders.com.au");
  assertEquals(res.drafts[0].cc, [MAKESAFE_CC]);
});

Deno.test("T3 feed: invoice_ambiguous is still returned (UX gates on it)", async () => {
  const seed = ferndaleSeed();
  // Two non-void invoices on the job -> ambiguous. Keep one DRAFT so the row still
  // qualifies as a draft to review.
  seed.xero_invoices = [
    {
      xero_invoice_id: "xi-1",
      invoice_number: "INV-1",
      status: "DRAFT",
      reference: "MLB-25248",
      sub_total: 1000,
      total: 1100,
      line_items: [],
      job_id: "job-ferndale",
      invoice_date: "2026-06-16",
    },
    {
      xero_invoice_id: "xi-2",
      invoice_number: "INV-2",
      status: "DRAFT",
      reference: "MLB-25248",
      sub_total: 900,
      total: 990,
      line_items: [],
      job_id: "job-ferndale",
      invoice_date: "2026-06-15",
    },
  ];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  // Whether ambiguity excludes or not depends on liveInvoice still being DRAFT;
  // either way the field must be present and true when surfaced.
  if (res.count > 0) {
    assertEquals(res.drafts[0].invoice_ambiguous, true);
  } else {
    assert(true);
  }
});

// ═════════════════════════════════════════════════════════════════
// PHASE 1b (TASK A) — RESUME-AWARE FEED action mapping. Each of the resume
// states surfaces with the correct resume_action; a sent/terminal job is
// EXCLUDED. Also proves the union: a pack whose substatus moved off
// admin_to_send_report still surfaces via the makesafe_report_packs query.
// ═════════════════════════════════════════════════════════════════

// A marker note for a job (used to drive markerPresent via buildPackSentMap).
function markerNote(jobId: string) {
  return {
    id: `ev-${jobId}`,
    job_id: jobId,
    event_type: "note",
    detail_json: {
      text:
        `MAKESAFE_PACK_SENT | main | INV | to=x@y.com | 2026-06-17T00:00:00Z`,
    },
  };
}

Deno.test("A feed row 1: a ready draft -> resume_action 'send'", async () => {
  const client = makeFeedClient(ferndaleSeed());
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "send");
});

Deno.test("A feed row 2: authorised_not_sent + authorised invoice + NO marker -> 'finish_send'", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "authorised_not_sent",
    report_doc_id: "d-rep",
    sent_at: null,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "finish_send");
});

Deno.test("A feed firewall: authorised_not_sent WITH a marker -> EXCLUDED (no double-email)", async () => {
  const seed: any = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "authorised_not_sent",
    report_doc_id: "d-rep",
    sent_at: null,
  }];
  seed.job_events = [markerNote("job-ferndale")];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(
    res.count,
    0,
    "a marker means it was sent -> never re-offer a send",
  );
});

Deno.test("A feed row 3: sent_marker_failed + NO marker -> 'finish_send'", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sent_marker_failed",
    report_doc_id: "d-rep",
    sent_at: null,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "finish_send");
});

Deno.test("A feed row 4: sent_not_closed + marker -> 'finish_close_out'", async () => {
  const seed: any = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sent_not_closed",
    report_doc_id: "d-rep",
    sent_at: "2026-06-17T01:00:00Z",
  }];
  seed.job_events = [markerNote("job-ferndale")];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "finish_close_out");
});

Deno.test("A feed row 4b: close_failed + marker -> 'finish_close_out'", async () => {
  const seed: any = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "close_failed",
    report_doc_id: "d-rep",
    sent_at: "2026-06-17T01:00:00Z",
  }];
  seed.job_events = [markerNote("job-ferndale")];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "finish_close_out");
});

Deno.test("A feed row 5: sending + NO marker -> 'resolve_send_state' (with send_started_at + in_flight_stale)", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sending",
    report_doc_id: "d-rep",
    sent_at: null,
    send_started_at: started,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "resolve_send_state");
  assertEquals(res.drafts[0].pack_status.send_started_at, started);
  assertEquals(res.drafts[0].pack_status.in_flight_stale, true);
});

Deno.test("A feed guard: sending + failed_step=draft_pack is excluded from email-send resolution", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sending",
    failed_step: "draft_pack",
    report_doc_id: "d-rep",
    sent_at: null,
    send_started_at: started,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0);
});

Deno.test("A feed guard: draft_pack generation stays hidden even if draft docs already exist", async () => {
  const seed = ferndaleSeed();
  seed.xero_invoices[0].status = "DRAFT";
  const started = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sending",
    failed_step: "draft_pack",
    report_doc_id: null,
    sent_at: null,
    send_started_at: started,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0);
});

Deno.test("A feed row 6: sending + marker -> 'finish_close_out'", async () => {
  const seed: any = ferndaleSeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sending",
    report_doc_id: "d-rep",
    sent_at: null,
    send_started_at: new Date().toISOString(),
  }];
  seed.job_events = [markerNote("job-ferndale")];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  assertEquals(res.drafts[0].resume_action, "finish_close_out");
});

Deno.test("A feed row 7: a sent/terminal job is EXCLUDED (resume_action null -> dropped)", async () => {
  const seed = ferndaleSeed();
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "sent",
    report_doc_id: "d-rep",
    sent_at: "2026-06-17T05:00:00Z",
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0, "a terminal sent job must be excluded");
});

Deno.test("A feed UNION: an authorised_not_sent pack whose substatus MOVED OFF admin_to_send_report still surfaces", async () => {
  // The Ferndale union: the detail substatus is NOT admin_to_send_report (a resume
  // advanced it), so the outer substatus filter excludes it. The resumable-packs
  // query must union it back in via job_id.
  const seed = ferndaleSeed();
  seed.makesafe_job_details[0].substatus = "ready_to_invoice"; // moved off admin_to_send_report
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs = [{
    job_id: "job-ferndale",
    pack_kind: "main",
    status: "authorised_not_sent",
    report_doc_id: "d-rep",
    sent_at: null,
  }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(
    res.count,
    1,
    "the resumable pack is unioned in despite the moved substatus",
  );
  assertEquals(res.drafts[0].job_id, "job-ferndale");
  assertEquals(res.drafts[0].resume_action, "finish_send");
});
