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
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildPackSentMapForTest,
  _createMakesafeDraftInvoiceForTest,
  _fetchAllByJobIdChunkedForTest,
  _makesafeDraftIdempotencyKey,
  _makesafeNormRefForTest,
  _makesafePipelineForTest,
} from "./index.ts";
import {
  _chunkByUrlBudget,
  _encodedIdCost,
  IN_URL_BUDGET,
} from "./makesafe_compact_reads.ts";

// A fake PostgREST client that serves a fixed row set for a table with real
// .range(from,to) pagination semantics (1000-row pages, slices the array) and
// applies .in()/.eq() predicates the way the real client does.
function makePagingClient(rowsByTable: Record<string, any[]>) {
  function builder(table: string) {
    let rows = (rowsByTable[table] || []).slice();
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
      text:
        "MAKESAFE_PACK_SENT | main | INV-0999 | to=builder@x.com | 2026-06-16T00:00:00Z",
    },
  });

  const client = makePagingClient({ job_events: events });
  const map = await _buildPackSentMapForTest(client, [JOB_SENT, JOB_UNSENT]);

  // The marker beyond the cap is NOT dropped — the sent job stays sent.
  assertEquals(
    map[JOB_SENT],
    true,
    "sent job must remain sent past the 1000-row cap",
  );
  // The unsent job (no marker anywhere) stays unset.
  assert(!map[JOB_UNSENT], "a job with no marker must not be marked sent");
});

Deno.test("T1: _fetchAllByJobIdChunked returns ALL rows across pages (no truncation at 1000)", async () => {
  const JOB = "job-1";
  const rows: any[] = [];
  for (let i = 0; i < 3210; i++) {
    rows.push({ job_id: JOB, event_type: "note", n: i });
  }
  const client = makePagingClient({ job_events: rows });
  const out = await _fetchAllByJobIdChunkedForTest(
    client,
    "job_events",
    "job_id, event_type, n",
    [JOB],
    (q: any) => q.eq("event_type", "note"),
  );
  assertEquals(out.length, 3210, "every row returned across all pages");
  // last row present (proves pagination did not stop at page 1).
  assert(
    out.some((r: any) => r.n === 3209),
    "the final row past the cap is present",
  );
});

Deno.test("T1: _fetchAllByJobIdChunked chunks the id list (>200 ids) and still returns all matching rows", async () => {
  // 450 job ids -> 3 id-chunks of <=200. One row per job; assert all 450 returned.
  const ids = Array.from({ length: 450 }, (_, i) => `job-${i}`);
  const rows = ids.map((id) => ({
    job_id: id,
    event_type: "note",
    marker: true,
  }));
  const client = makePagingClient({ job_events: rows });
  const out = await _fetchAllByJobIdChunkedForTest(
    client,
    "job_events",
    "job_id, event_type, marker",
    ids,
    (q: any) => q.eq("event_type", "note"),
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
// Optionally enforces the live encoded-.in() URL budget (adversary F7) so an
// unchunked restrict list fails exactly like the Supabase gateway.
function makePipelineClient(
  rowsByTable: Record<string, any[]>,
  opts: {
    maxInEncodedBytes?: number;
    inCalls?: Array<
      { table: string; column: string; values: any[]; encodedBytes: number }
    >;
  } = {},
) {
  function builder(table: string) {
    const rows = (rowsByTable[table] || []).slice();
    const preds: Array<(r: any) => boolean> = [];
    let queryError: { message: string } | null = null;
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
        const encodedBytes = vals.reduce(
          (n, id) => n + _encodedIdCost(String(id)),
          0,
        );
        opts.inCalls?.push({
          table,
          column: col,
          values: vals.slice(),
          encodedBytes,
        });
        if (
          opts.maxInEncodedBytes != null &&
          encodedBytes > opts.maxInEncodedBytes
        ) {
          queryError = {
            message:
              `${table}.${col} encoded .in() list is ${encodedBytes} bytes ` +
              `(budget ${opts.maxInEncodedBytes})`,
          };
        }
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      order: () => b,
      limit: () => b,
      range: async (from: number, to: number) => {
        if (queryError) return { data: null, error: queryError };
        const data = rows.filter((r) => preds.every((p) => p(r))).slice(
          from,
          to + 1,
        );
        return { data, error: null };
      },
      // Single-row terminals (e.g. the report_type lookup in the createMakesafeDraftInvoice
      // $0 gate). Return the first matching row or null, mirroring real Supabase.
      maybeSingle: async () => {
        if (queryError) return { data: null, error: queryError };
        const data = rows.filter((r) => preds.every((p) => p(r)))[0] ?? null;
        return { data, error: null };
      },
      single: async () => {
        if (queryError) return { data: null, error: queryError };
        const data = rows.filter((r) => preds.every((p) => p(r)))[0] ?? null;
        return { data, error: null };
      },
      then: (resolve: (v: any) => any) => {
        if (queryError) return resolve({ data: null, error: queryError });
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
      id,
      job_number: `SWMS-${1000 + i}`,
      type: "makesafe",
      status: "invoiced",
      site_lat: -31.9,
      site_lng: 115.8,
      metadata: {},
      created_at: recentDate,
      completed_at: recentDate,
    });
    // Mark them complete + sent so they sit in completed/archive (full-history).
    details.push({
      job_id: id,
      substatus: "complete",
      requesting_company_name: "Acme",
    });
    invoices.push({
      job_id: id,
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      invoice_number: `INV-${i}`,
      invoice_date: recentDate.slice(0, 10),
    });
    reports.push({ job_id: id, status: "submitted", submitted_at: recentDate });
    docs.push({
      job_id: id,
      type: "general",
      file_name: `Make Safe Report SWMS-${1000 + i}.pdf`,
    });
    docs.push({
      job_id: id,
      type: "general",
      file_name: `Tax Invoice INV-${i}.pdf`,
    });
    packs.push({
      job_id: id,
      pack_kind: "main",
      status: "sent",
      report_doc_id: `d-${i}`,
      sent_at: recentDate,
    });
    events.push({
      job_id: id,
      event_type: "note",
      detail_json: {
        text:
          `MAKESAFE_PACK_SENT | main | INV-${i} | to=b@x.com | ${recentDate}`,
      },
    });
  }

  const client = makePipelineClient({
    jobs,
    makesafe_job_details: details,
    xero_invoices: invoices,
    job_service_reports: reports,
    job_documents: docs,
    makesafe_report_packs: packs,
    job_assignments: [],
    job_events: events,
  });

  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams(),
  );
  assertEquals(res.total, N, "full history returned (not capped at 200)");
  const all = Object.values(res.columns).flat() as any[];
  assertEquals(all.length, N, "every job is placed in a column");
  // The sent jobs must NOT be in report_ready (they are sent+closed).
  assertEquals(
    res.columns.report_ready.length,
    0,
    "no sent job re-surfaces as report_ready",
  );
  // They land in completed (recent) — proving the archive/completed path works at scale.
  assert(
    res.columns.completed.length === N,
    "all sent+recent jobs are completed",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// T5 — D2 idempotency hardening for create_makesafe_draft_invoice (DRAFT-only).
// ════════════════════════════════════════════════════════════════════════════

Deno.test("T5: make-safe draft idempotency key is STABLE per (job, reference) regardless of time", () => {
  const k1 = _makesafeDraftIdempotencyKey("job-9", "MLB-25248");
  const k2 = _makesafeDraftIdempotencyKey("job-9", "MLB-25248");
  assertEquals(
    k1,
    k2,
    "identical job+reference -> identical key (no time component)",
  );
  // Different job or reference -> different key.
  assert(
    _makesafeDraftIdempotencyKey("job-9", "MLB-25248") !==
      _makesafeDraftIdempotencyKey("job-10", "MLB-25248"),
  );
  assert(
    _makesafeDraftIdempotencyKey("job-9", "MLB-25248") !==
      _makesafeDraftIdempotencyKey("job-9", "MLB-25249"),
  );
  // Reference whitespace/case normalised (matches the dup-guard's _norm).
  assertEquals(
    _makesafeDraftIdempotencyKey("job-9", " MLB-25248 "),
    _makesafeDraftIdempotencyKey("job-9", "mlb-25248"),
  );
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
  assertEquals(
    _makesafeNormRefForTest("AJBR 67713"),
    _makesafeNormRefForTest("AJBR-67713"),
  );
  assertEquals(
    _makesafeNormRefForTest("AJBR-67713"),
    _makesafeNormRefForTest("AJBR67713"),
  );
});

Deno.test("B2: draft idempotency key is identical for spaced vs hyphenated vs compact refs", () => {
  const spaced = _makesafeDraftIdempotencyKey("job-x", "AJBR 67713");
  const hyphen = _makesafeDraftIdempotencyKey("job-x", "AJBR-67713");
  const compact = _makesafeDraftIdempotencyKey("job-x", "AJBR67713");
  assertEquals(
    spaced,
    hyphen,
    "spaced and hyphenated refs must yield the same idempotency key",
  );
  assertEquals(
    hyphen,
    compact,
    "hyphenated and compact refs must yield the same idempotency key",
  );
});

Deno.test("T5: a second createMakesafeDraftInvoice with the same job/reference returns skipped (no duplicate)", async () => {
  // Simulate the first call having already created the invoice: seed it into the
  // ACCREC scan. The dup-guard must short-circuit to skipped BEFORE any Xero call.
  // Since f16a4a1 the default is to UPDATE the existing draft in place (revise
  // packs); update_existing_draft:false selects the explicit skip/dedup path.
  const existing = {
    xero_invoice_id: "xi-1",
    invoice_number: "INV-0700",
    reference: "MLB-25248",
    status: "DRAFT",
    job_id: "job-dup",
    invoice_type: "ACCREC",
    invoice_date: "2026-06-16",
  };
  const client = makePipelineClient({ xero_invoices: [existing] });
  const res: any = await _createMakesafeDraftInvoiceForTest(client, {
    job_id: "job-dup",
    reference: "MLB-25248",
    contact_name: "MLB Constructions",
    line_items: [{
      description: "Make safe labour",
      quantity: 1,
      unit_price: 500,
    }],
    update_existing_draft: false,
  });
  assertEquals(res.skipped, true, "second create is skipped (dup-guard)");
  assertEquals(res.existing_invoice.invoice_number, "INV-0700");
});

// ════════════════════════════════════════════════════════════════════════════
// F7 residual — allocated-trade restrict list must stay under IN_URL_BUDGET.
// ~37 encoded bytes/UUID → 163 ids exceed the 6000-byte gateway budget. An
// ordinary trade with a large assignment history must still see exactly their
// assigned make-safe jobs (never unassigned / wrong-type) across multi-chunk
// `.in('id', …)` reads, with stable Board ordering and no overlong request.
// ════════════════════════════════════════════════════════════════════════════

function uuidJobId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

Deno.test("F7: >163 allocated job ids chunk under IN_URL_BUDGET and return exact assigned make-safes only", async () => {
  // 250 UUID job ids → multi-chunk under budget (~162/chunk). Plus 3 authority
  // leakage baits: an unassigned make-safe, a patio job, a fencing job.
  const ASSIGNED_N = 250;
  assert(
    _chunkByUrlBudget(
      Array.from({ length: ASSIGNED_N }, (_, i) => uuidJobId(i)),
    )
      .length > 1,
    "fixture must force multi-chunk restrict",
  );
  // Sanity: a single unchunked list of 250 UUIDs exceeds the live budget.
  const unchunkedBytes = Array.from(
    { length: ASSIGNED_N },
    (_, i) => uuidJobId(i),
  )
    .reduce((n, id) => n + _encodedIdCost(id), 0);
  assert(
    unchunkedBytes > IN_URL_BUDGET,
    `unchunked ${ASSIGNED_N} UUIDs (${unchunkedBytes}B) must exceed IN_URL_BUDGET`,
  );

  const recentDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const jobs: any[] = [];
  const details: any[] = [];
  const assignedIds: string[] = [];

  for (let i = 0; i < ASSIGNED_N; i++) {
    const id = uuidJobId(i);
    assignedIds.push(id);
    jobs.push({
      id,
      job_number: `SWMS-${20000 + i}`,
      type: "makesafe",
      status: "pending",
      client_name: `Client ${i}`,
      site_address: `${i} Trade St`,
      site_lat: -31.9,
      site_lng: 115.8,
      metadata: {},
      // Distinct created_at so stable Board order is created_at desc, id desc.
      created_at: new Date(Date.parse(recentDate) - i * 1000).toISOString(),
      updated_at: recentDate,
      completed_at: null,
    });
    details.push({
      job_id: id,
      substatus: "company_contact_required",
      requesting_company_name: "Acme",
      cycle_number: 1,
      reattend_count: 0,
      attendance_cycle_id: null,
    });
  }

  const UNASSIGNED = uuidJobId(9000);
  const PATIO = uuidJobId(9001);
  const FENCE = uuidJobId(9002);
  jobs.push({
    id: UNASSIGNED,
    job_number: "SWMS-UNASSIGNED",
    type: "makesafe",
    status: "pending",
    client_name: "Other Trade",
    site_address: "9 Leak St",
    metadata: {},
    created_at: recentDate,
    updated_at: recentDate,
    completed_at: null,
  });
  details.push({
    job_id: UNASSIGNED,
    substatus: "company_contact_required",
    requesting_company_name: "Acme",
    cycle_number: 1,
    reattend_count: 0,
  });
  jobs.push({
    id: PATIO,
    job_number: "SWP-1",
    type: "patio",
    status: "pending",
    client_name: "Patio Client",
    site_address: "1 Patio St",
    metadata: {},
    created_at: recentDate,
    updated_at: recentDate,
    completed_at: null,
  });
  jobs.push({
    id: FENCE,
    job_number: "SWF-1",
    type: "fencing",
    status: "pending",
    client_name: "Fence Client",
    site_address: "1 Fence St",
    metadata: {},
    created_at: recentDate,
    updated_at: recentDate,
    completed_at: null,
  });

  const inCalls: Array<{
    table: string;
    column: string;
    values: any[];
    encodedBytes: number;
  }> = [];
  const client = makePipelineClient(
    {
      jobs,
      makesafe_job_details: details,
      xero_invoices: [],
      job_service_reports: [],
      job_documents: [],
      makesafe_report_packs: [],
      makesafe_report_pack_cycles: [],
      job_assignments: [],
      job_events: [],
    },
    { maxInEncodedBytes: IN_URL_BUDGET, inCalls },
  );

  // Ordinary trade: restrict to assigned make-safe ids only (as loadMakesafeAssignedJobIds returns).
  const res: any = await _makesafePipelineForTest(
    client,
    new URLSearchParams("history=all"),
    assignedIds,
  );

  const allCards = Object.values(res.columns).flat() as any[];
  const returnedIds = allCards.map((c) => c.id);
  assertEquals(
    returnedIds.length,
    ASSIGNED_N,
    "trade sees exactly its assigned make-safe jobs",
  );
  assertEquals(
    new Set(returnedIds).size,
    ASSIGNED_N,
    "no duplicate cards across restrict chunks",
  );
  assertEquals(
    returnedIds.slice().sort(),
    assignedIds.slice().sort(),
    "returned id set equals assigned set",
  );
  assert(
    !returnedIds.includes(UNASSIGNED),
    "unassigned make-safe must not leak",
  );
  assert(!returnedIds.includes(PATIO), "patio job must not leak");
  assert(!returnedIds.includes(FENCE), "fencing job must not leak");
  // Stable Board ordering inside the stage column: jobs are walked in
  // created_at desc, id desc after multi-chunk merge (all unassigned-contact
  // fixtures land in `new`).
  const newCol = res.columns.new as any[];
  assertEquals(newCol.length, ASSIGNED_N, "all fixtures land in new");
  for (let i = 1; i < newCol.length; i++) {
    const prev = newCol[i - 1];
    const cur = newCol[i];
    const cmpCreated = String(cur.created_at || "").localeCompare(
      String(prev.created_at || ""),
    );
    assert(
      cmpCreated < 0 ||
        (cmpCreated === 0 &&
          String(cur.id || "").localeCompare(String(prev.id || "")) <= 0),
      "Board order must stay created_at desc, id desc across chunks",
    );
  }

  // Every issued jobs.id .in() stayed under the URL budget (multi-chunk).
  const jobsIdIns = inCalls.filter((c) =>
    c.table === "jobs" && c.column === "id"
  );
  assert(
    jobsIdIns.length > 1,
    `restrict must issue multiple jobs.id .in() chunks, got ${jobsIdIns.length}`,
  );
  for (const call of jobsIdIns) {
    assert(
      call.encodedBytes <= IN_URL_BUDGET,
      `jobs.id .in() ${call.encodedBytes}B exceeds IN_URL_BUDGET ${IN_URL_BUDGET}`,
    );
  }
  // Chunk merge covers every assigned id exactly once across restrict chunks.
  const mergedRestrictIds = jobsIdIns.flatMap((c) => c.values);
  assertEquals(
    new Set(mergedRestrictIds).size,
    ASSIGNED_N,
    "restrict chunks together cover every assigned id once",
  );
});

Deno.test("F7: unchunked 163+ UUID restrict would exceed IN_URL_BUDGET (the live bug class)", () => {
  // Pure budget proof: the number the adversary named (163) is over budget as a
  // single list. The production path must never issue such a list.
  const ids = Array.from({ length: 163 }, (_, i) => uuidJobId(i));
  const bytes = ids.reduce((n, id) => n + _encodedIdCost(id), 0);
  assert(
    bytes > IN_URL_BUDGET,
    `163 UUIDs encode to ${bytes}B > ${IN_URL_BUDGET}`,
  );
  const chunks = _chunkByUrlBudget(ids);
  assert(chunks.length > 1, "budget chunker must split 163 UUIDs");
  for (const c of chunks) {
    const b = c.reduce((n, id) => n + _encodedIdCost(id), 0);
    assert(b <= IN_URL_BUDGET, `chunk ${b}B must stay under budget`);
  }
  assertEquals(chunks.reduce((n, c) => n + c.length, 0), 163);
});
