// T1 (money-safety) — pagination of the make-safe pack-sent map.
//
// THE BUG THIS GUARDS: buildPackSentMap did ONE unpaginated .in() read over
// job_events. PostgREST caps a single response at 1000 rows. Over full make-safe
// history the note stream exceeds 1000 rows, so a MAKESAFE_PACK_SENT|main marker
// sitting BEYOND the first 1000 rows was silently dropped -> a SENT job looked
// unsent and would re-surface as "ready to send". That is a money/comms-safety
// hazard (it could re-trigger a send on an already-closed pack).
//
// We drive _buildPackSentMapForTest with a FAKE client that returns >1000
// job_events rows across .range() pages, with the pack-sent marker for a sent job
// placed on a row WAY past row 1000. We assert packSent stays true for that job.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_pagination_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildPackSentMapForTest,
  _createMakesafeDraftInvoiceForTest,
  _fetchAllByJobIdChunkedForTest,
  _makesafeDraftIdempotencyKey,
  _makesafeNormRefForTest,
  _makesafePipelineForTest,
} from "./index.ts";

// A fake PostgREST client that serves a fixed row set for a table with real
// .range(from,to) pagination semantics (1000-row pages, slices the array) and
// applies .in()/.eq() predicates the way the real client does.
function makePagingClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    let rows = (rowsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { preds.push((r) => r?.[col] === val); return b; },
      neq: (col: string, val: any) => { preds.push((r) => r?.[col] !== val); return b; },
      not: () => b,
      in: (col: string, vals: any[]) => { preds.push((r) => vals.includes(r?.[col])); return b; },
      order: () => b,
      range: async (from: number, to: number) => {
        const filtered = rows.filter((r) => preds.every((p) => p(r)));
        // PostgREST .range is inclusive of `to`; cap page size at 1000 like prod.
        const data = filtered.slice(from, to + 1);
        return { data, error: null };
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("T1: buildPackSentMap keeps a SENT job sent when its marker is BEYOND the 1000-row cap", async () => {
  const JOB_SENT = "job-sent";
  const JOB_UNSENT = "job-unsent";

  // 2500 noise note rows (no marker), then the sent marker for JOB_SENT at the
  // very end (row index ~2500 — far past a single 1000-row page).
  const events: any[] = [];
  for (let i = 0; i < 2500; i++) {
    events.push({
      job_id: i % 2 === 0 ? JOB_SENT : JOB_UNSENT,
      event_type: "note",
      detail_json: { text: `routine note ${i}` },
    });
  }
  // The decisive marker, last row in the set (would be dropped by a 1000-cap read).
  events.push({
    job_id: JOB_SENT,
    event_type: "note",
    detail_json: {
      text: "MAKESAFE_PACK_SENT | main | INV-0999 | to=builder@x.com | 2026-06-16T00:00:00Z",
    },
  });

  const client = makePagingClient({ job_events: events });
  const map = await _buildPackSentMapForTest(client, [JOB_SENT, JOB_UNSENT]);

  // The marker beyond the cap is NOT dropped — the sent job stays sent.
  assertEquals(map[JOB_SENT], true, "sent job must remain sent past the 1000-row cap");
  // The unsent job (no marker anywhere) stays unset.
  assert(!map[JOB_UNSENT], "a job with no marker must not be marked sent");
});

Deno.test("T1: _fetchAllByJobIdChunked returns ALL rows across pages (no truncation at 1000)", async () => {
  const JOB = "job-1";
  const rows: any[] = [];
  for (let i = 0; i < 3210; i++) rows.push({ job_id: JOB, event_type: "note", n: i });
  const client = makePagingClient({ job_events: rows });
  const out = await _fetchAllByJobIdChunkedForTest(
    client, "job_events", "job_id, event_type, n", [JOB], (q: any) => q.eq("event_type", "note"),
  );
  assertEquals(out.length, 3210, "every row returned across all pages");
  // last row present (proves pagination did not stop at page 1).
  assert(out.some((r: any) => r.n === 3209), "the final row past the cap is present");
});

Deno.test("T1: _fetchAllByJobIdChunked chunks the id list (>200 ids) and still returns all matching rows", async () => {
  // 450 job ids -> 3 id-chunks of <=200. One row per job; assert all 450 returned.
  const ids = Array.from({ length: 450 }, (_, i) => `job-${i}`);
  const rows = ids.map((id) => ({ job_id: id, event_type: "note", marker: true }));
  const client = makePagingClient({ job_events: rows });
  const out = await _fetchAllByJobIdChunkedForTest(
    client, "job_events", "job_id, event_type, marker", ids, (q: any) => q.eq("event_type", "note"),
  );
  assertEquals(out.length, 450, "all rows across all id-chunks returned");
});

Deno.test("T1: empty job set short-circuits to an empty map (no query)", async () => {
  const client = makePagingClient({ job_events: [] });
  const map = await _buildPackSentMapForTest(client, []);
  assertEquals(Object.keys(map).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// T4 — makesafePipeline lifts the .limit(200): the board shows the FULL history,
// and a sent job among >200 is correctly NOT in report_ready (ties T1+T2).
// ════════════════════════════════════════════════════════════════════════════

// A richer paging client that supports the full pipeline (all tables + .range).
function makePipelineClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    const rows = (rowsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { preds.push((r) => r?.[col] === val); return b; },
      neq: (col: string, val: any) => { preds.push((r) => r?.[col] !== val); return b; },
      not: () => b,
      in: (col: string, vals: any[]) => { preds.push((r) => vals.includes(r?.[col])); return b; },
      order: () => b,
      limit: () => b,
      range: async (from: number, to: number) => {
        const data = rows.filter((r) => preds.every((p) => p(r))).slice(from, to + 1);
        return { data, error: null };
      },
      then: (resolve: (v: any) => any) =>
        resolve({ data: rows.filter((r) => preds.every((p) => p(r))), error: null }),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

Deno.test("T4: pipeline returns >200 jobs (no limit) and a sent job is NOT in report_ready", async () => {
  const N = 260;
  const jobs: any[] = [];
  const details: any[] = [];
  const invoices: any[] = [];
  const reports: any[] = [];
  const docs: any[] = [];
  const packs: any[] = [];
  const events: any[] = [];

  const recentDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (let i = 0; i < N; i++) {
    const id = `job-${i}`;
    jobs.push({
      id, job_number: `SWMS-${1000 + i}`, type: "makesafe", status: "invoiced",
      site_lat: -31.9, site_lng: 115.8, metadata: {}, created_at: recentDate, completed_at: recentDate,
    });
    // Mark them complete + sent so they sit in completed/archive (full-history).
    details.push({ job_id: id, substatus: "complete", requesting_company_name: "Acme" });
    invoices.push({ job_id: id, status: "AUTHORISED", invoice_type: "ACCREC", invoice_number: `INV-${i}`, invoice_date: recentDate.slice(0, 10) });
    reports.push({ job_id: id, status: "submitted", submitted_at: recentDate });
    docs.push({ job_id: id, type: "general", file_name: `Make Safe Report SWMS-${1000 + i}.pdf` });
    docs.push({ job_id: id, type: "general", file_name: `Tax Invoice INV-${i}.pdf` });
    packs.push({ job_id: id, pack_kind: "main", status: "sent", report_doc_id: `d-${i}`, sent_at: recentDate });
    events.push({
      job_id: id, event_type: "note",
      detail_json: { text: `MAKESAFE_PACK_SENT | main | INV-${i} | to=b@x.com | ${recentDate}` },
    });
  }

  const client = makePipelineClient({
    jobs, makesafe_job_details: details, xero_invoices: invoices,
    job_service_reports: reports, job_documents: docs, makesafe_report_packs: packs,
    job_assignments: [], job_events: events,
  });

  const res: any = await _makesafePipelineForTest(client, new URLSearchParams());
  assertEquals(res.total, N, "full history returned (not capped at 200)");
  const all = (Object.values(res.columns).flat() as any[]);
  assertEquals(all.length, N, "every job is placed in a column");
  // The sent jobs must NOT be in report_ready (they are sent+closed).
  assertEquals(res.columns.report_ready.length, 0, "no sent job re-surfaces as report_ready");
  // They land in completed (recent) — proving the archive/completed path works at scale.
  assert(res.columns.completed.length === N, "all sent+recent jobs are completed");
});

// ════════════════════════════════════════════════════════════════════════════
// T5 — D2 idempotency hardening for create_makesafe_draft_invoice (DRAFT-only).
// ════════════════════════════════════════════════════════════════════════════

Deno.test("T5: make-safe draft idempotency key is STABLE per (job, reference) regardless of time", () => {
  const k1 = _makesafeDraftIdempotencyKey("job-9", "MLB-25248");
  const k2 = _makesafeDraftIdempotencyKey("job-9", "MLB-25248");
  assertEquals(k1, k2, "identical job+reference -> identical key (no time component)");
  // Different job or reference -> different key.
  assert(_makesafeDraftIdempotencyKey("job-9", "MLB-25248") !== _makesafeDraftIdempotencyKey("job-10", "MLB-25248"));
  assert(_makesafeDraftIdempotencyKey("job-9", "MLB-25248") !== _makesafeDraftIdempotencyKey("job-9", "MLB-25249"));
  // Reference whitespace/case normalised (matches the dup-guard's _norm).
  assertEquals(_makesafeDraftIdempotencyKey("job-9", " MLB-25248 "), _makesafeDraftIdempotencyKey("job-9", "mlb-25248"));
  // No time component: stays identical across a simulated time gap.
  assert(!k1.includes(":"), "key has no ISO time component");
});

// ════════════════════════════════════════════════════════════════════════════
// BLOCKER B pt2 — hyphen-robust _makesafeNormRef. 'AJBR 67713' == 'AJBR-67713'
// == 'AJBR67713' all collapse to 'ajbr67713', so the DRAFT idempotency key + the
// dup-scan match hyphen/space variants of the same external_ref. Mirrors
// makesafe_send_pack.ts:normRef (both sites changed together).
// ════════════════════════════════════════════════════════════════════════════
Deno.test("B2: _makesafeNormRef collapses space/hyphen/compact variants to one key", () => {
  assertEquals(_makesafeNormRefForTest("AJBR 67713"), "ajbr67713");
  assertEquals(_makesafeNormRefForTest("AJBR-67713"), "ajbr67713");
  assertEquals(_makesafeNormRefForTest("AJBR67713"), "ajbr67713");
  assertEquals(_makesafeNormRefForTest("AJBR 67713"), _makesafeNormRefForTest("AJBR-67713"));
  assertEquals(_makesafeNormRefForTest("AJBR-67713"), _makesafeNormRefForTest("AJBR67713"));
});

Deno.test("B2: draft idempotency key is identical for spaced vs hyphenated vs compact refs", () => {
  const spaced = _makesafeDraftIdempotencyKey("job-x", "AJBR 67713");
  const hyphen = _makesafeDraftIdempotencyKey("job-x", "AJBR-67713");
  const compact = _makesafeDraftIdempotencyKey("job-x", "AJBR67713");
  assertEquals(spaced, hyphen, "spaced and hyphenated refs must yield the same idempotency key");
  assertEquals(hyphen, compact, "hyphenated and compact refs must yield the same idempotency key");
});

Deno.test("T5: a second createMakesafeDraftInvoice with the same job/reference returns skipped (no duplicate)", async () => {
  // Simulate the first call having already created the invoice: seed it into the
  // ACCREC scan. The dup-guard must short-circuit to skipped BEFORE any Xero call.
  const existing = {
    xero_invoice_id: "xi-1", invoice_number: "INV-0700", reference: "MLB-25248",
    status: "DRAFT", job_id: "job-dup", invoice_type: "ACCREC", invoice_date: "2026-06-16",
  };
  const client = makePipelineClient({ xero_invoices: [existing] });
  const res: any = await _createMakesafeDraftInvoiceForTest(client, {
    job_id: "job-dup",
    reference: "MLB-25248",
    contact_name: "MLB Constructions",
    line_items: [{ description: "Make safe labour", quantity: 1, unit_price: 500 }],
  });
  assertEquals(res.skipped, true, "second create is skipped (dup-guard)");
  assertEquals(res.existing_invoice.invoice_number, "INV-0700");
});
