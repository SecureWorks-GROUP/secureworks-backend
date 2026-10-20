// deno-lint-ignore-file no-explicit-any no-import-prefix
// The paid close-out read block (job_closeout_read.ts): its shape, and that it reads the
// whole job list in one batched wave, never one query per job. Also the pipeline wiring:
// fencing and patio rows carry it for staff only, every other row never does.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadCloseoutBlocks } from "./job_closeout_read.ts";
import { _pipelineForTest } from "./index.ts";

type Row = Record<string, any>;
type Call = { table: string; select: string; filters: [string, string, any][] };

function read(row: Row, col: string): any {
  const path = col.match(/^(\w+)->>(\w+)$/);
  if (path) return row[path[1]]?.[path[2]] ?? null;
  return row[col];
}

/** A PostgREST fake over fixed tables that records every query. */
function fakeClient(
  tables: Record<string, Row[]>,
  opts: { fail?: string; boardJobs?: Row[] } = {},
) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const preds: ((r: Row) => boolean)[] = [];
      let sort: string | null = null;
      let board = false;
      const q: any = {
        select(cols: string) {
          call.select = cols;
          // The pipeline's own jobs read: answered with the board rows, unfiltered.
          board = table === "jobs" && cols.startsWith("id, type, status");
          return q;
        },
        // Filters these tests do not need to apply.
        or: () => q,
        not: () => q,
        is: () => q,
        neq: () => q,
        range: () => q,
        eq(col: string, v: any) {
          call.filters.push(["eq", col, v]);
          preds.push((r) => read(r, col) === v);
          return q;
        },
        in(col: string, vs: any[]) {
          call.filters.push(["in", col, vs]);
          preds.push((r) => vs.includes(read(r, col)));
          return q;
        },
        order(col: string) {
          sort = col;
          return q;
        },
        limit() {
          return q;
        },
        then(ok: any, bad: any) {
          if (opts.fail === table) {
            return Promise.resolve({ data: null, error: { message: "boom" } })
              .then(ok, bad);
          }
          if (board) {
            return Promise.resolve({ data: opts.boardJobs ?? [], error: null })
              .then(ok, bad);
          }
          let rows = (tables[table] ?? []).filter((r) =>
            preds.every((p) => p(r))
          );
          if (sort) {
            rows = [...rows].sort((a, b) =>
              String(b[sort!]).localeCompare(String(a[sort!]))
            );
          }
          return Promise.resolve({ data: rows, error: null }).then(ok, bad);
        },
      };
      return q;
    },
  };
}

const PAID_SHORT = "00000000-0000-4000-8000-000000000001";
const IN_REVIEW = "00000000-0000-4000-8000-000000000002";
const NO_CONTACT = "00000000-0000-4000-8000-000000000003";
const REFUSED = "00000000-0000-4000-8000-000000000004";
const CALLBACK = "00000000-0000-4000-8000-000000000005";
const MAKESAFE = "00000000-0000-4000-8000-000000000006";

function closeoutTables(): Record<string, Row[]> {
  return {
    job_closeout_state: [
      {
        job_id: PAID_SHORT,
        paid_less_than_quoted: true,
        shortfall_inc: "412.50",
      },
      // A cleared marker keeps its old shortfall in the row; the block shows none.
      { job_id: IN_REVIEW, paid_less_than_quoted: false, shortfall_inc: "9" },
    ],
    job_review_claims: [
      { job_id: IN_REVIEW, status: "sent", reason: null },
    ],
    job_events: [
      {
        job_id: IN_REVIEW,
        event_type: "status_changed",
        detail_json: { new_status: "get_review" },
        created_at: "2026-10-13T02:00:00.000Z",
      },
      {
        job_id: IN_REVIEW,
        event_type: "status_changed",
        detail_json: { new_status: "get_review" },
        created_at: "2026-10-01T02:00:00.000Z",
      },
      {
        job_id: NO_CONTACT,
        event_type: "status_changed",
        detail_json: { new_status: "get_review" },
        created_at: "2026-10-13T05:00:00.000Z",
      },
      {
        job_id: REFUSED,
        event_type: "review_request_not_sent",
        detail_json: { status: "refused", reason: null },
        created_at: "2026-10-13T06:00:00.000Z",
      },
    ],
    jobs: [
      { id: PAID_SHORT, is_callback: false },
      { id: IN_REVIEW, is_callback: false },
      { id: NO_CONTACT, is_callback: false },
      { id: REFUSED, is_callback: false },
      { id: CALLBACK, is_callback: true },
    ],
  };
}

const JOBS = [
  { id: PAID_SHORT, type: "fencing", status: "invoiced" },
  { id: IN_REVIEW, type: "patio", status: "get_review" },
  {
    id: NO_CONTACT,
    type: "fencing",
    status: "get_review",
    ghl_contact_id: null,
  },
  { id: REFUSED, type: "fencing", status: "get_review", ghl_contact_id: "c-9" },
  { id: CALLBACK, type: "fencing", status: "invoiced" },
  { id: MAKESAFE, type: "makesafe", status: "invoiced" },
];

Deno.test("closeout read: the block shape for each case", async () => {
  const client = fakeClient(closeoutTables());
  const blocks = await loadCloseoutBlocks(client, JOBS);
  assert(blocks);
  assertEquals(blocks.get(PAID_SHORT), {
    paid_less_than_quoted: true,
    shortfall_inc: 412.5,
    review: null,
    get_review_entered_at: null,
    archive_due_at: null,
    held: null,
    review_opt_out: false,
    review_claim_status: null,
  });
  // Newest get_review entry, archive due 24 hours later; the claim decides the review.
  assertEquals(blocks.get(IN_REVIEW), {
    paid_less_than_quoted: false,
    shortfall_inc: null,
    review: { status: "sent", reason: null },
    get_review_entered_at: "2026-10-13T02:00:00.000Z",
    archive_due_at: "2026-10-14T02:00:00.000Z",
    held: null,
    review_opt_out: false,
    review_claim_status: "sent",
  });
  // No claim and no event: null, even with no linked contact (nothing was recorded).
  assertEquals(blocks.get(NO_CONTACT)?.review, null);
  assertEquals(
    blocks.get(NO_CONTACT)?.archive_due_at,
    "2026-10-14T05:00:00.000Z",
  );
  // No claim: the newest not-sent row.
  assertEquals(blocks.get(REFUSED)?.review, {
    status: "not_sent",
    reason: "refused",
  });
  // In get_review but no entry row: no archive time.
  assertEquals(blocks.get(REFUSED)?.get_review_entered_at, null);
  assertEquals(blocks.get(REFUSED)?.archive_due_at, null);
  assertEquals(blocks.get(CALLBACK)?.held, "callback");
  assertEquals(blocks.has(MAKESAFE), false);
});

Deno.test("closeout read: the review switch and the claim status, read from the job when the row lacks it", async () => {
  const tables = closeoutTables();
  tables.jobs.find((j) => j.id === PAID_SHORT)!.review_opt_out = true;
  const blocks = await loadCloseoutBlocks(fakeClient(tables), [
    ...JOBS,
    // A caller that already holds the column is believed, never re-read.
    { id: CALLBACK, type: "fencing", status: "complete", review_opt_out: true },
  ]);
  assertEquals(blocks?.get(PAID_SHORT)?.review_opt_out, true);
  assertEquals(blocks?.get(PAID_SHORT)?.review_claim_status, null);
  assertEquals(blocks?.get(IN_REVIEW)?.review_opt_out, false);
  assertEquals(blocks?.get(IN_REVIEW)?.review_claim_status, "sent");
  assertEquals(blocks?.get(CALLBACK)?.review_opt_out, true);
});

Deno.test("closeout read: rectification holds and has no archive time", async () => {
  const tables = closeoutTables();
  tables.job_events.push({
    job_id: PAID_SHORT,
    event_type: "status_changed",
    detail_json: { new_status: "get_review" },
    created_at: "2026-10-10T00:00:00.000Z",
  });
  const blocks = await loadCloseoutBlocks(fakeClient(tables), [
    {
      id: PAID_SHORT,
      type: "fencing",
      status: "rectification",
      is_callback: false,
    },
  ]);
  assertEquals(blocks?.get(PAID_SHORT)?.held, "rectification");
  assertEquals(
    blocks?.get(PAID_SHORT)?.get_review_entered_at,
    "2026-10-10T00:00:00.000Z",
  );
  assertEquals(blocks?.get(PAID_SHORT)?.archive_due_at, null);
});

Deno.test("closeout read: one batched query per table, whatever the job count", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
    type: i % 2 ? "fencing" : "patio",
    status: "get_review",
  }));
  const client = fakeClient(closeoutTables());
  await loadCloseoutBlocks(client, many);
  const perTable: Record<string, number> = {};
  for (const c of client.calls) {
    perTable[c.table] = (perTable[c.table] ?? 0) + 1;
  }
  assertEquals(perTable, {
    job_closeout_state: 1,
    job_review_claims: 1,
    job_events: 2, // review_request_not_sent and the get_review entries
    jobs: 1, // is_callback and review_opt_out, only because these rows lack them
  });
  for (const c of client.calls) {
    const inFilter = c.filters.find(([m]) => m === "in");
    assert(inFilter, `${c.table} read is not batched`);
    assertEquals((inFilter[2] as string[]).length, 40);
  }
});

Deno.test("closeout read: a draft gets the empty block and is never read", async () => {
  const client = fakeClient(closeoutTables());
  const blocks = await loadCloseoutBlocks(client, [
    { id: PAID_SHORT, type: "fencing", status: "draft" },
  ]);
  assertEquals(blocks?.get(PAID_SHORT), {
    paid_less_than_quoted: false,
    shortfall_inc: null,
    review: null,
    get_review_entered_at: null,
    archive_due_at: null,
    held: null,
    review_opt_out: false,
    review_claim_status: null,
  });
  assertEquals(client.calls.length, 0);
});

Deno.test("closeout read: a big board reads each table's chunks one at a time", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(2000 + i).padStart(12, "0")}`,
    type: "fencing",
    status: "invoiced",
    is_callback: false,
    review_opt_out: false,
  }));
  const base = fakeClient(closeoutTables());
  let inFlight = 0;
  let peak = 0;
  const client = {
    calls: base.calls,
    from(table: string) {
      const q = base.from(table);
      const then = q.then;
      q.then = (ok: any, bad: any) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((r) => setTimeout(r, 1)).then(() => {
          inFlight--;
          return then(ok, bad);
        });
      };
      return q;
    },
  };
  const blocks = await loadCloseoutBlocks(client, many);
  assertEquals(blocks?.size, 120);
  // Three chunks of 50 per table, four tables read (no jobs read): never all at once.
  assertEquals(client.calls.length, 12);
  assert(peak <= 4, `peak in-flight ${peak}`);
});

Deno.test("closeout read: no closeout jobs reads nothing; a failed read is null", async () => {
  const idle = fakeClient(closeoutTables());
  const none = await loadCloseoutBlocks(idle, [
    { id: MAKESAFE, type: "makesafe", status: "invoiced" },
  ]);
  assertEquals(none?.size, 0);
  assertEquals(idle.calls.length, 0);
  const broken = fakeClient(closeoutTables(), { fail: "job_review_claims" });
  assertEquals(await loadCloseoutBlocks(broken, JOBS), null);
});

Deno.test("closeout read: it only ever selects", async () => {
  const client = fakeClient(closeoutTables());
  await loadCloseoutBlocks(client, JOBS);
  // The fake has no insert/update/upsert/delete; reaching here proves none was called.
  assert(client.calls.length > 0);
});

// ── The pipeline wiring ──────────────────────────────────────────────────────

function pipelineJob(id: string, type: string, status: string): Row {
  return {
    id,
    type,
    status,
    client_name: "Resident",
    client_phone: null,
    site_address: null,
    site_suburb: "Perth",
    pj_total_inc: null,
    pj_total: null,
    pj_split_neighbours: null,
    pj_job_neighbours: null,
    ghl_contact_id: null,
    ghl_opportunity_id: null,
    job_number: `SWF-${id.slice(-4)}`,
    accepted_at: null,
    approvals_at: null,
    deposit_at: null,
    processing_at: null,
    scheduled_at: null,
    completed_at: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-13T00:00:00Z",
    deposit_invoice_id: null,
    deposit_amount: null,
    council_required: null,
    org_id: "00000000-0000-0000-0000-000000000001",
  };
}

function pipelineClient(opts: { fail?: string } = {}) {
  return fakeClient(closeoutTables(), {
    ...opts,
    boardJobs: [
      pipelineJob(PAID_SHORT, "fencing", "invoiced"),
      pipelineJob(IN_REVIEW, "patio", "get_review"),
      pipelineJob(MAKESAFE, "makesafe", "invoiced"),
    ],
  });
}

Deno.test("pipeline: fencing and patio rows carry closeout for staff only", async () => {
  const staff = await _pipelineForTest(
    pipelineClient(),
    new URLSearchParams(),
    { includeCloseout: true },
  );
  const rows = Object.values(staff.columns).flat() as Row[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  assertEquals(byId.get(PAID_SHORT)?.closeout?.paid_less_than_quoted, true);
  assertEquals(byId.get(IN_REVIEW)?.closeout?.review, {
    status: "sent",
    reason: null,
  });
  assertEquals("closeout" in (byId.get(MAKESAFE) ?? {}), false);
  // The review switch and the claim status are read from the block only.
  assertEquals(byId.get(PAID_SHORT)?.closeout.review_opt_out, false);
  assertEquals(byId.get(PAID_SHORT)?.closeout.review_claim_status, null);
  assertEquals(byId.get(IN_REVIEW)?.closeout.review_claim_status, "sent");
  for (const id of [PAID_SHORT, IN_REVIEW, MAKESAFE]) {
    assertEquals("review_opt_out" in (byId.get(id) ?? {}), false);
    assertEquals("review_claim_status" in (byId.get(id) ?? {}), false);
  }

  const notStaff = await _pipelineForTest(
    pipelineClient(),
    new URLSearchParams(),
  );
  for (const r of Object.values(notStaff.columns).flat() as Row[]) {
    assertEquals("closeout" in r, false);
    assertEquals("review_opt_out" in r, false);
    assertEquals("review_claim_status" in r, false);
  }
});

Deno.test("pipeline: an opted-out card says so in its closeout block", async () => {
  const tables = closeoutTables();
  tables.jobs.find((j) => j.id === PAID_SHORT)!.review_opt_out = true;
  const result = await _pipelineForTest(
    fakeClient(tables, {
      boardJobs: [pipelineJob(PAID_SHORT, "fencing", "complete")],
    }),
    new URLSearchParams(),
    { includeCloseout: true },
  );
  const row = (Object.values(result.columns).flat() as Row[])[0];
  assertEquals(row.closeout.review_opt_out, true);
  assertEquals("review_opt_out" in row, false);
});

Deno.test("pipeline: a failed closeout read nulls the block and says so", async () => {
  const client = pipelineClient({ fail: "job_review_claims" });
  const result: any = await _pipelineForTest(client, new URLSearchParams(), {
    includeCloseout: true,
  });
  const rows = Object.values(result.columns).flat() as Row[];
  const fencing = rows.find((r) => r.id === PAID_SHORT);
  assertEquals(fencing?.closeout, null);
  assertEquals("review_opt_out" in (fencing ?? {}), false);
  assertEquals("review_claim_status" in (fencing ?? {}), false);
  assert(result.enrichment_errors.includes("pipeline.closeout"));
});
