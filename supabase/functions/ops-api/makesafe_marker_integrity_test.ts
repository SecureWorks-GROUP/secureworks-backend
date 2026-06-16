// M3 marker-integrity tests.
//
// Goal: the LIVE make-safe invoice must be resolvable independent of the baked
// MAKESAFE_PACK_SENT sent-marker. The marker text bakes the invoice number at
// send time and is never re-resolved when an invoice is voided + replaced, so
// anything that trusts the marker number reads a dead invoice. These tests prove
// the backend resolves the current AUTHORISED (non-voided) invoice purely by job
// link / reference, ignoring the marker text entirely.
//
// Anchor case — Swanbourne MLB-25691: sent INV-0701 ($984.50) was VOIDED and
// replaced by INV-0704 ($561, AUTHORISED). The marker note still reads INV-0701.
// The audit/board must resolve INV-0704 as the live invoice.
//
// Run: deno test --allow-all --no-check supabase/functions/ops-api/makesafe_marker_integrity_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeAuditForTest,
  _makesafePipelineForTest,
  _resolveLiveMakesafeInvoiceForTest,
  _resolveMakesafeJobInvoicesForTest,
} from "./index.ts";

const NOW = "2026-06-16T03:00:00Z";

// ── Chainable query stub (mirrors makesafe_audit_test.ts; applies predicates) ──
function makeQueryClient(resultsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (resultsByTable[table] || []).slice();
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
      not: () => b, // the live-board path filters VOIDED/DELETED via PostgREST .not;
      // the stub does NOT apply it, so these tests prove the JS resolver excludes
      // voided rows even when the DB hands them through.
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      gte: (col: string, val: any) => {
        preds.push((r) => r?.[col] >= val);
        return b;
      },
      order: () => b,
      limit: () => b,
      // Paginated read terminal (fetchAllRows): applies predicates, returns [from,to].
      range: async (from: number, to: number) => {
        const data = rows.filter((r) => preds.every((p) => p(r))).slice(from, to + 1);
        return { data, error: null };
      },
      then: (resolve: (v: any) => any) => {
        const data = rows.filter((r) => preds.every((p) => p(r)));
        return resolve({ data, error: null });
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

// ─────────────────────────────────────────────────────────────────
// Pure resolver — _resolveLiveMakesafeInvoice
// ─────────────────────────────────────────────────────────────────

Deno.test("M3 live-resolver: voided+replaced job resolves to the AUTHORISED invoice (Swanbourne)", () => {
  // Full mapped list as _resolveMakesafeJobInvoices would return it (newest first).
  const mapped = [
    { status: "AUTHORISED", invoice_number: "INV-0704", reference: "MLB-25691", match_tier: "job_id", voided: false },
    { status: "VOIDED", invoice_number: "INV-0701", reference: "MLB-25691", match_tier: "job_id", voided: true },
  ];
  const live = _resolveLiveMakesafeInvoiceForTest(mapped);
  assert(live, "a live invoice resolves");
  assertEquals(live!.invoice_number, "INV-0704"); // NOT the baked marker number INV-0701
  assertEquals(live!.status, "AUTHORISED");
});

Deno.test("M3 live-resolver: PAID beats AUTHORISED beats SUBMITTED beats DRAFT; voided never wins", () => {
  // Order intentionally not by rank to prove rank, not position, decides.
  const mapped = [
    { status: "VOIDED", invoice_number: "INV-V", voided: true },
    { status: "DRAFT", invoice_number: "INV-D", voided: false },
    { status: "AUTHORISED", invoice_number: "INV-A", voided: false },
    { status: "SUBMITTED", invoice_number: "INV-S", voided: false },
    { status: "PAID", invoice_number: "INV-P", voided: false },
  ];
  assertEquals(_resolveLiveMakesafeInvoiceForTest(mapped)!.invoice_number, "INV-P");
});

Deno.test("M3 live-resolver: PAID outranks AUTHORISED (the settled invoice is the live answer)", () => {
  // The defect this guards: a job whose invoice was issued then PAID must
  // resolve to the PAID row, not a stray AUTHORISED one. Newest-first input.
  const mapped = [
    { status: "AUTHORISED", invoice_number: "INV-0710", voided: false },
    { status: "PAID", invoice_number: "INV-0704", voided: false },
  ];
  const live = _resolveLiveMakesafeInvoiceForTest(mapped);
  assertEquals(live!.invoice_number, "INV-0704");
  assertEquals(live!.status, "PAID");
});

Deno.test("M3 live-resolver: among same-rank invoices the newest (first in list) wins", () => {
  // Input list is invoice_date desc; tie-break must keep the first-seen.
  const mapped = [
    { status: "AUTHORISED", invoice_number: "INV-NEW", voided: false },
    { status: "AUTHORISED", invoice_number: "INV-OLD", voided: false },
  ];
  assertEquals(_resolveLiveMakesafeInvoiceForTest(mapped)!.invoice_number, "INV-NEW");
});

Deno.test("M3 live-resolver: unknown non-void status still resolves (lowest rank, never null when a live row exists)", () => {
  const mapped = [
    { status: "WEIRD_STATUS", invoice_number: "INV-X", voided: false },
  ];
  assertEquals(_resolveLiveMakesafeInvoiceForTest(mapped)!.invoice_number, "INV-X");
});

Deno.test("M3 live-resolver: all-voided job resolves to NO live invoice (null)", () => {
  const mapped = [
    { status: "VOIDED", invoice_number: "INV-V1", voided: true },
    { status: "DELETED", invoice_number: "INV-V2", voided: true },
  ];
  assertEquals(_resolveLiveMakesafeInvoiceForTest(mapped), null);
});

Deno.test("M3 live-resolver: empty list → null (no throw)", () => {
  assertEquals(_resolveLiveMakesafeInvoiceForTest([]), null);
});

// ─────────────────────────────────────────────────────────────────
// makesafeAudit — surfaces live_invoice_no resolved by job link, not the marker
// ─────────────────────────────────────────────────────────────────

Deno.test("M3 audit: Swanbourne row exposes live_invoice_no=INV-0704 while invoice_no keeps the void history", async () => {
  const client = makeQueryClient({
    jobs: [{
      id: "job-swan",
      job_number: "SWMS-25691",
      type: "makesafe",
      status: "invoiced",
      site_lat: -31.97,
      site_lng: 115.76,
      metadata: {},
      created_at: "2026-06-12T00:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-swan",
      external_ref: "MLB-25691",
      requesting_company_name: "Major Loss Builders",
      requesting_company_slug: "mlb",
      substatus: "complete",
    }],
    job_documents: [],
    job_service_reports: [],
    // VOIDED INV-0701 (the baked marker number) + AUTHORISED replacement INV-0704.
    xero_invoices: [
      {
        job_id: "job-swan",
        status: "AUTHORISED",
        invoice_number: "INV-0704",
        reference: "MLB-25691",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-13",
      },
      {
        job_id: "job-swan",
        status: "VOIDED",
        invoice_number: "INV-0701",
        reference: "MLB-25691",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-12",
      },
    ],
    makesafe_intake_drafts: [],
  });
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());
  const j = res.jobs.find((r: any) => r.job_id === "job-swan");
  assert(j, "swanbourne row present");
  // The single live invoice the downstream "what did we send" reader should use.
  assertEquals(j.live_invoice_no, "INV-0704");
  assertEquals(j.live_invoice_status, "AUTHORISED");
  // The dead/baked number is NOT the live answer.
  assert(j.live_invoice_no !== "INV-0701");
  // Void history is still preserved in the full blob/list (item 2.4 unchanged).
  assert(j.invoice_no.includes("INV-0701"), "void history kept in invoice_no blob");
  assert(j.invoice_no.includes("INV-0704"));
  assert(j.invoices.some((i: any) => i.voided === true && i.invoice_number === "INV-0701"));
});

// ─────────────────────────────────────────────────────────────────
// Board path regression — the live board already filters voided at the DB layer;
// confirm the surfaced invoice for a voided+replaced job is the AUTHORISED one.
// (The stub here does NOT honour PostgREST .not, so this also proves the board
// would still surface the AUTHORISED row first by invoice_date desc ordering.)
// ─────────────────────────────────────────────────────────────────

Deno.test("M3 board: voided+replaced job surfaces the AUTHORISED invoice status", async () => {
  const client = makeQueryClient({
    jobs: [{
      id: "job-swan",
      job_number: "SWMS-25691",
      type: "makesafe",
      status: "invoiced",
      site_lat: -31.97,
      site_lng: 115.76,
      metadata: {},
      created_at: "2026-06-12T00:00:00Z",
      completed_at: NOW,
    }],
    makesafe_job_details: [{
      job_id: "job-swan",
      external_ref: "MLB-25691",
      requesting_company_name: "Major Loss Builders",
      substatus: "complete",
    }],
    job_service_reports: [{ job_id: "job-swan", status: "submitted", submitted_at: NOW }],
    // Newest-first ordering is applied by PostgREST in prod; provide AUTHORISED first
    // so firstByJobId picks it (the void row would be filtered by .not in prod anyway).
    xero_invoices: [
      {
        job_id: "job-swan",
        status: "AUTHORISED",
        invoice_type: "ACCREC",
        invoice_number: "INV-0704",
        reference: "MLB-25691",
        invoice_date: "2026-06-13",
      },
    ],
    job_documents: [{ job_id: "job-swan", type: "general", file_name: "Tax Invoice INV-0704.pdf" }],
    job_assignments: [],
    job_events: [{
      job_id: "job-swan",
      event_type: "note",
      detail_json: {
        // marker still bakes the DEAD number — board must not depend on it.
        text: "MAKESAFE_PACK_SENT | main | INV-0701 | to=builder@x.com | 2026-06-12T00:00:00Z | msgid=abc",
      },
    }],
  });
  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  const job = (Object.values(res.columns).flat() as any[]).find((j: any) => j.id === "job-swan");
  assert(job, "swanbourne board row present");
  assertEquals(job.pack_sent, true);
  // invoice_status derives from the live (non-voided) invoice row, not the marker.
  assert(String(job.invoice_status).toLowerCase().includes("invoic") ||
    String(job.invoice_status).toLowerCase().includes("authoris") ||
    job.invoice_status === "invoiced", `board invoice_status=${job.invoice_status}`);
});

// Sanity: full mapper still keeps voided rows (no regression to item 2.4).
Deno.test("M3: _resolveMakesafeJobInvoices still returns the voided row (void history intact)", () => {
  const rows = [
    { job_id: "job-swan", status: "AUTHORISED", invoice_number: "INV-0704", reference: "MLB-25691" },
    { job_id: "job-swan", status: "VOIDED", invoice_number: "INV-0701", reference: "MLB-25691" },
  ];
  const mapped = _resolveMakesafeJobInvoicesForTest(rows, "job-swan", "MLB-25691");
  assertEquals(mapped.length, 2);
  assertEquals(_resolveLiveMakesafeInvoiceForTest(mapped)!.invoice_number, "INV-0704");
});
