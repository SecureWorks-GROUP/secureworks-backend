// deno-lint-ignore-file no-explicit-any no-import-prefix
// The Jobs board's change stamp (pipeline_stamp.ts, P0-15.1): three small reads joined
// with '|'; a missing job_change_marks counts as empty; a failed jobs or job_events
// read means "not known" (null), so the screen loads the board.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readPipelineStamp } from "./pipeline_stamp.ts";
import { _authorizeOpsApiAction } from "./index.ts";

type Call = { table: string; select: string; filters: [string, string, any][]; order?: [string, any]; limit?: number };

/** A PostgREST fake: each table answers one fixed row, an error, or a throw. */
function fakeClient(answers: Record<string, { row?: Record<string, unknown> | null; error?: unknown; throws?: boolean }>) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, select: "", filters: [] };
      calls.push(call);
      const answer = answers[table] ?? { error: { code: "42P01", message: "relation does not exist" } };
      const q: any = {
        select(cols: string) {
          call.select = cols;
          return q;
        },
        eq(col: string, v: unknown) {
          call.filters.push(["eq", col, v]);
          return q;
        },
        order(col: string, opts: unknown) {
          call.order = [col, opts];
          return q;
        },
        limit(n: number) {
          call.limit = n;
          return q;
        },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          if (answer.throws) return Promise.reject(new Error("network")).then(resolve, reject);
          if (answer.error) return Promise.resolve({ data: null, error: answer.error }).then(resolve, reject);
          return Promise.resolve({ data: answer.row ? [answer.row] : [], error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const JOBS = { row: { updated_at: "2026-11-17T01:00:00+00:00" } };
const EVENTS = { row: { created_at: "2026-11-17T02:00:00+00:00" } };
const MARKS = { row: { last_marked_at: "2026-11-17T03:00:00+00:00" } };

Deno.test("pipeline stamp: three values joined with '|'", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: EVENTS, job_change_marks: MARKS });
  const out = await readPipelineStamp(client, "org-1");
  assertEquals(out, {
    stamp: "2026-11-17T01:00:00+00:00|2026-11-17T02:00:00+00:00|2026-11-17T03:00:00+00:00",
  });
});

Deno.test("pipeline stamp: a missing job_change_marks table counts as empty", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: EVENTS });
  const out = await readPipelineStamp(client, "org-1");
  assertEquals(out, { stamp: "2026-11-17T01:00:00+00:00|2026-11-17T02:00:00+00:00|" });
});

Deno.test("pipeline stamp: a job_change_marks read that throws counts as empty", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: EVENTS, job_change_marks: { throws: true } });
  const out = await readPipelineStamp(client, "org-1");
  assertEquals(out, { stamp: "2026-11-17T01:00:00+00:00|2026-11-17T02:00:00+00:00|" });
});

Deno.test("pipeline stamp: a failed jobs read is not known (null)", async () => {
  const client = fakeClient({ jobs: { error: { message: "boom" } }, job_events: EVENTS, job_change_marks: MARKS });
  assertEquals(await readPipelineStamp(client, "org-1"), { stamp: null });
});

Deno.test("pipeline stamp: a failed job_events read is not known (null)", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: { throws: true }, job_change_marks: MARKS });
  assertEquals(await readPipelineStamp(client, "org-1"), { stamp: null });
});

Deno.test("pipeline stamp: empty tables give empty values, not null", async () => {
  const client = fakeClient({ jobs: { row: null }, job_events: { row: null }, job_change_marks: { row: null } });
  assertEquals(await readPipelineStamp(client, "org-1"), { stamp: "||" });
});

Deno.test("pipeline stamp: exactly 3 reads, newest first, one row each, jobs scoped to the org", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: EVENTS, job_change_marks: MARKS });
  await readPipelineStamp(client, "org-1");
  assertEquals(client.calls.length, 3);
  assertEquals(client.calls.map((c) => c.table).sort(), ["job_change_marks", "job_events", "jobs"]);
  const byTable = Object.fromEntries(client.calls.map((c) => [c.table, c]));
  assertEquals(byTable.jobs.select, "updated_at");
  assertEquals(byTable.jobs.filters, [["eq", "org_id", "org-1"]]);
  assertEquals(byTable.job_events.select, "created_at");
  assertEquals(byTable.job_change_marks.select, "last_marked_at");
  for (const c of client.calls) {
    assertEquals(c.limit, 1);
    assertEquals(c.order?.[1], { ascending: false, nullsFirst: false });
  }
});

Deno.test("pipeline stamp: no org reads nothing and is not known", async () => {
  const client = fakeClient({ jobs: JOBS, job_events: EVENTS, job_change_marks: MARKS });
  assertEquals(await readPipelineStamp(client, ""), { stamp: null });
  assertEquals(client.calls.length, 0);
});

Deno.test("pipeline stamp: the front door keeps it staff only", () => {
  const url = new URL("https://x/ops-api?action=pipeline_stamp");
  assertEquals(_authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "admin" } }), { ok: true });
  const trade = _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "lead_installer" } });
  assertEquals(trade.ok ? null : trade.status, 403);
  const anon = _authorizeOpsApiAction({ url, authMode: "none" });
  assertEquals(anon.ok ? null : anon.status, 401);
});
