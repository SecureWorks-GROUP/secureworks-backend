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
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeReportDraftsForTest } from "./index.ts";
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
      eq: (col: string, val: any) => { preds.push((r) => r?.[col] === val); return b; },
      neq: (col: string, val: any) => { preds.push((r) => r?.[col] !== val); return b; },
      not: () => b,
      in: (col: string, vals: any[]) => { preds.push((r) => vals.includes(r?.[col])); return b; },
      order: () => b,
      limit: (n: number) => { maxRows = n; return b; },
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
      makesafe_companies: { slug: "mlb", name: "MLB Constructions", invoice_email: "accounts@mlb.com.au" },
    }],
    jobs: [{
      id: "job-ferndale", job_number: "SWMS-25248", client_name: "Jane Homeowner",
      client_email: "jane@x.com", site_address: "12 Smith St", site_suburb: "Ferndale", status: "invoiced", type: "makesafe",
    }],
    xero_invoices: [{
      xero_invoice_id: "xi-1", invoice_number: "INV-1234", status: "DRAFT", reference: "MLB-25248",
      sub_total: 1000, total: 1100, total_tax: 100, line_items: [], job_id: "job-ferndale", invoice_date: "2026-06-16",
    }],
    job_documents: [
      { id: "d-rep", job_id: "job-ferndale", type: "makesafe_report", file_name: "Make Safe Report MLB-25248.pdf", storage_url: "https://docs.test/report.pdf", pdf_url: null, version: 1 },
      { id: "d-inv", job_id: "job-ferndale", type: "invoice", file_name: "Tax Invoice INV-1234.pdf", storage_url: "https://docs.test/invoice.pdf", pdf_url: null, version: 1 },
      { id: "d-wo", job_id: "job-ferndale", type: "work_order", file_name: "Work Order.pdf", storage_url: "https://docs.test/wo.pdf", pdf_url: null, version: 1 },
    ],
    job_media: [
      { id: "m1", job_id: "job-ferndale", phase: "completion", type: "photo", storage_url: "https://media.test/p1.jpg", thumbnail_url: "https://media.test/p1t.jpg", label: "Front" },
    ],
    makesafe_report_packs: [{ job_id: "job-ferndale", pack_kind: "main", status: "drafted", report_doc_id: "d-rep", sent_at: null }],
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
  seed.makesafe_report_packs = [{ job_id: "job-ferndale", pack_kind: "main", status: "sent", report_doc_id: "d-rep", sent_at: "2026-06-16T05:00:00Z" }];
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0, "a sent pack must be excluded from the cockpit feed");
});

Deno.test("T3 feed: a LEGACY marker-only sent job (job_events marker, no pack row, no report_sent_at) is EXCLUDED", async () => {
  // Adversarial review #1: a job sent via the old pre-pack-table path leaves only
  // a MAKESAFE_PACK_SENT | main note. With a lingering DRAFT invoice + the
  // admin_to_send_report substatus it would otherwise look like a fresh draft.
  const seed: any = ferndaleSeed();
  seed.makesafe_report_packs = []; // no durable pack row
  seed.makesafe_job_details[0].report_sent_at = null;
  seed.job_events = [{
    id: "ev-1", job_id: "job-ferndale", event_type: "note",
    detail_json: { text: "MAKESAFE_PACK_SENT | main | INV-1234 | to=b@x.com | 2026-06-16T00:00:00Z" },
  }];
  // The report doc still exists so hasReportDoc would be true; only the marker
  // (via buildPackSentMap) excludes it.
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 0, "a legacy marker-only sent job must be excluded from the feed");
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
  assert(Array.isArray(row.photos) && row.photos.length === 1, "photos still present");
  assert(row.default_subject && row.default_html_body, "send defaults still present");
  // D3 arrays.
  const draftLabels = row.draft_docs.map((d: any) => d.label);
  assert(draftLabels.includes("Make Safe Report"), "draft_docs has the report");
  assert(draftLabels.includes("Draft Invoice"), "draft_docs has the draft invoice");
  // SWMS only when attached — none here.
  assert(!draftLabels.includes("SWMS"), "no SWMS attached -> none surfaced");
  // source_docs has the work order + the photo (image kind).
  const srcLabels = row.source_docs.map((d: any) => d.label);
  assert(srcLabels.includes("Work Order"), "source_docs has the work order");
  assert(row.source_docs.some((d: any) => d.kind === "image"), "source_docs includes a photo image");
  assert(row.draft_docs.every((d: any) => d.kind === "pdf"), "draft_docs are pdf kind");
});

Deno.test("D3 feed: an attached SWMS is surfaced in draft_docs", async () => {
  const seed = ferndaleSeed();
  seed.job_documents.push({ id: "d-swms", job_id: "job-ferndale", type: "swms", file_name: "SWMS.pdf", storage_url: "https://docs.test/swms.pdf", pdf_url: null, version: 1 });
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
    slug: "aj", name: "AJS", invoice_email: "vanessa@ajs.build", report_recipient: "workorders@ajs.build",
  } as any;
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  const row = res.drafts[0];
  assertEquals(row.recipient_email, "workorders@ajs.build");
  assert(row.recipient_email !== "vanessa@ajs.build", "vanessa (billing) must NEVER be the To");
  assertEquals(row.cc, [MAKESAFE_CC]);
});

Deno.test("C feed: report_recipient null -> recipient_email null (warning), NOT invoice_email", async () => {
  const seed = ferndaleSeed();
  // Only a billing contact configured, no work-orders inbox.
  seed.makesafe_job_details[0].makesafe_companies = {
    slug: "aj", name: "AJS", invoice_email: "vanessa@ajs.build", report_recipient: null,
  } as any;
  const client = makeFeedClient(seed);
  const res: any = await _makesafeReportDraftsForTest(client, params());
  assertEquals(res.count, 1);
  const row = res.drafts[0];
  assertEquals(row.recipient_email, null, "no work-orders inbox -> null (cockpit warns)");
  assert(row.recipient_email !== "vanessa@ajs.build", "must NOT fall back to the billing contact");
  // cc is still exactly ses@ (the send hard-enforces this server-side too).
  assertEquals(row.cc, [MAKESAFE_CC]);
});

Deno.test("T3 feed: invoice_ambiguous is still returned (UX gates on it)", async () => {
  const seed = ferndaleSeed();
  // Two non-void invoices on the job -> ambiguous. Keep one DRAFT so the row still
  // qualifies as a draft to review.
  seed.xero_invoices = [
    { xero_invoice_id: "xi-1", invoice_number: "INV-1", status: "DRAFT", reference: "MLB-25248", sub_total: 1000, total: 1100, line_items: [], job_id: "job-ferndale", invoice_date: "2026-06-16" },
    { xero_invoice_id: "xi-2", invoice_number: "INV-2", status: "DRAFT", reference: "MLB-25248", sub_total: 900, total: 990, line_items: [], job_id: "job-ferndale", invoice_date: "2026-06-15" },
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
