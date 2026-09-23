// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Context slice K4 (23 Sep 2026): the job read says how current its facts are.
// cadence design section 4 (review M2, M3) and 9.D: a `freshness` section in
// assemble_job_dossier, built from the read-only SQL function
// context_job_freshness (slice K1), plus sourceStatus.freshness.
//
// Named rows (cadence design section 10; row labels only). The freshness
// answers below are the LIVE answers of public.context_job_freshness for these
// jobs, recorded byte for byte from one read-only production read at
// 2026-09-23T14:28:39Z (BEGIN READ ONLY ... ROLLBACK, the function first
// confirmed STABLE). Job ids are the real ones; no customer detail is in them.
// The SQL contract
// supabase/tests/migration-contracts/20260924030000_context_evidence_cadence
// (section 10) proves the function builds such answers from the evidence, so
// the two tests chain: SQL judges, this module carries the answer to the job
// read unchanged.
//
// Pins:
//   R6  SWP-261456  draft lead, no evidence on the job: no facts read yet, 0
//                   newer items, no next read due; the job has a contact, so
//                   the customer's 3 unplaced messages are counted and named
//                   in the line ("N for the contact" branch of the design).
//   R13 SWF-26545   facts current to 22 Sep 06:30 Perth, nothing newer; the
//                   customer's texts that sit on the holding job (audit C5)
//                   show on this job as 4 messages not yet placed.
//   Section and status: the section is the SQL answer minus job_id, never
//   re-rendered; sourceStatus.freshness is {ok, state, count, code} with count
//   = newer items not yet read; sections_version is 3.
//   Failures: an RPC error, a thrown call, a NULL answer, or an answer of the
//   wrong shape or for another job leave the section null (never "fresh"),
//   state failed with a code, and diagnostics.ok false.
//   Read only: one call to context_job_freshness with the job id, no table
//   read, no write, no network call.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { freshnessFromRpc, readJobFreshness } from "./job_freshness.ts";
import { _assembleJobDossierForTest } from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

// ── recorded live answers (see header) ─────────────────────────────────────

// SWP-261456 (R6), as returned (no job_id key in the recorded answer).
const R6_JOB = "ace953b5-7ef7-44e0-8791-47cf70303121";
const R6_LIVE = {
  line:
    "No facts read yet; 0 newer items not yet read; 3 messages from this customer not yet placed on any job",
  runs_today: 0,
  next_due_at: null,
  unread_count: 0,
  blocked_reason: null,
  contact_missing: false,
  last_run_finished_at: null,
  unplaced_for_contact: { count: 3, newest_at: "2026-09-21T08:16:59.628Z" },
  oldest_unread_landed_at: null,
};

// SWF-26545 (R13), as returned.
const R13_JOB = "ff21f64b-4055-436a-b73d-c3f50c20ce43";
const R13_LIVE = {
  line:
    "Facts current to 22 Sep 06:30; 0 newer items not yet read; 4 messages from this customer not yet placed on any job",
  runs_today: 0,
  next_due_at: null,
  unread_count: 0,
  blocked_reason: null,
  contact_missing: false,
  last_run_finished_at: "2026-09-21T22:30:14.186355Z",
  unplaced_for_contact: { count: 4, newest_at: "2026-09-16T23:10:21.105Z" },
  oldest_unread_landed_at: null,
};

// ── fake client: one job row, recorded RPC answers, writes trapped ─────────

type Tables = Record<string, any[]>;
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

function fakeClient(
  tables: Tables,
  freshness: (args: any) => { data: unknown; error: unknown },
) {
  const reads: string[] = [];
  const rpcs: Array<{ fn: string; args: any }> = [];
  const writes: string[] = [];
  return {
    reads,
    rpcs,
    writes,
    async rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (fn === "context_job_freshness") return freshness(args);
      return { data: [], error: null };
    },
    from(table: string) {
      reads.push(table);
      const filters: Array<(r: any) => boolean> = [];
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.eq = (c: string, v: any) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      for (
        const m of [
          "select",
          "neq",
          "in",
          "gt",
          "ilike",
          "is",
          "or",
          "not",
          "gte",
          "lt",
          "lte",
          "contains",
          "range",
          "order",
          "limit",
        ]
      ) {
        q[m] = () => q;
      }
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

function jobTables(id: string, jobNumber: string): Tables {
  return {
    jobs: [{
      id,
      job_number: jobNumber,
      type: jobNumber.startsWith("SWP") ? "patio" : "fencing",
      status: "draft",
      client_name: "Row label only",
      client_email: null,
      ghl_contact_id: null,
      org_id: ORG,
      scope_json: null,
      pricing_json: null,
      scope_version: null,
      scope_updated_at: null,
    }],
  };
}

function answers(jobId: string, live: Record<string, unknown>) {
  return (args: any) => ({
    data: args?.p_job_id === jobId ? structuredClone(live) : null,
    error: null,
  });
}

function withoutJobId(live: Record<string, unknown>): any {
  const { job_id: _drop, ...rest } = live;
  return rest;
}

async function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the freshness read must not call the network");
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── named rows through the job read ────────────────────────────────────────

Deno.test("K4 R6 SWP-261456: a draft with no evidence reads 0 newer items and no next read, as the SQL rendered it", async () => {
  const client = fakeClient(
    jobTables(R6_JOB, "SWP-261456"),
    answers(R6_JOB, R6_LIVE),
  );
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: R6_JOB })
  );
  assertEquals(d.freshness, withoutJobId(R6_LIVE));
  assertEquals(d.freshness.unread_count, 0);
  assertEquals(d.freshness.next_due_at, null);
  assertEquals(d.freshness.line, R6_LIVE.line);
  // the job has a contact: its customer's unplaced messages are counted,
  // never "no contact on this job"
  assertEquals(d.freshness.contact_missing, false);
  assertEquals(d.freshness.unplaced_for_contact.count, 3);
  assert(!d.freshness.line.includes("no contact on this job"));
  assertEquals(d.diagnostics.sourceStatus.freshness, {
    ok: true,
    state: "ok",
    count: 0,
  });
  assertEquals(d.sections_version, 3);
  assertEquals(client.writes, []);
  const calls = client.rpcs.filter((r) => r.fn === "context_job_freshness");
  assertEquals(calls, [{
    fn: "context_job_freshness",
    args: { p_job_id: R6_JOB },
  }]);
});

Deno.test("K4 R13 SWF-26545: texts parked on the holding job show on this job as not yet placed", async () => {
  const client = fakeClient(
    jobTables(R13_JOB, "SWF-26545"),
    answers(R13_JOB, R13_LIVE),
  );
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: R13_JOB })
  );
  assertEquals(d.freshness, withoutJobId(R13_LIVE));
  assertEquals(d.freshness.unplaced_for_contact.count, 4);
  assertEquals(d.freshness.last_run_finished_at, "2026-09-21T22:30:14.186355Z");
  assert(d.freshness.line.startsWith("Facts current to 22 Sep 06:30; "));
  assertEquals(d.freshness.contact_missing, false);
  assert(
    /\d+ messages? from this customer not yet placed on any job$/.test(
      d.freshness.line,
    ),
  );
  assertEquals(d.diagnostics.sourceStatus.freshness.ok, true);
  assertEquals(
    d.diagnostics.sourceStatus.freshness.count,
    R13_LIVE.unread_count,
  );
  assertEquals(client.writes, []);
});

// ── failures: unknown with a reason, never "fresh" ─────────────────────────

Deno.test("K4 failure: an RPC error leaves freshness null with the code and diagnostics not ok", async () => {
  const client = fakeClient(
    jobTables(R6_JOB, "SWP-261456"),
    () => ({ data: null, error: { code: "57014", message: "timeout" } }),
  );
  const d: any = await _assembleJobDossierForTest(client, { job_id: R6_JOB });
  assertEquals(d.freshness, null);
  assertEquals(d.diagnostics.sourceStatus.freshness, {
    ok: false,
    state: "failed",
    count: 0,
    code: "57014",
  });
  assertEquals(d.diagnostics.ok, false);
  assertEquals(client.writes, []);
});

Deno.test("K4 failure: a thrown call, a NULL answer, a foreign job or a wrong shape are refused with a code", async () => {
  const cases: Array<[string, (args: any) => any]> = [
    ["read_threw", () => {
      throw new Error("socket closed");
    }],
    ["empty_payload", () => ({ data: null, error: null })],
    ["invalid_shape", () => ({
      data: { ...R6_LIVE, job_id: R13_JOB },
      error: null,
    })],
    ["invalid_shape", () => ({ data: [R6_LIVE], error: null })],
    ["invalid_shape", () => ({
      data: { ...R6_LIVE, unread_count: "0" },
      error: null,
    })],
    ["invalid_shape", () => ({
      data: { ...R6_LIVE, line: "" },
      error: null,
    })],
    ["invalid_shape", () => ({
      data: { ...R6_LIVE, unplaced_for_contact: null },
      error: null,
    })],
    ["read_failed", () => ({ data: null, error: { message: "no code" } })],
  ];
  for (const [code, answer] of cases) {
    const client = fakeClient(jobTables(R6_JOB, "SWP-261456"), answer);
    const r = await readJobFreshness(client, R6_JOB);
    assertEquals(r.freshness, null, code);
    assertEquals(r.status, { ok: false, state: "failed", count: 0, code });
  }
});

// ── read only ──────────────────────────────────────────────────────────────

Deno.test("K4 read only: one context_job_freshness call, no table read, no write, no network", async () => {
  const client = fakeClient({}, answers(R13_JOB, R13_LIVE));
  const r = await noNetwork(() => readJobFreshness(client, R13_JOB));
  assertEquals(r.status, {
    ok: true,
    state: "ok",
    count: R13_LIVE.unread_count,
  });
  assertEquals(client.rpcs, [{
    fn: "context_job_freshness",
    args: { p_job_id: R13_JOB },
  }]);
  assertEquals(client.reads, []);
  assertEquals(client.writes, []);
});

Deno.test("K4 section is the SQL answer unchanged: the line and every value are passed through, never re-derived", () => {
  const held = {
    ...R6_LIVE,
    last_run_finished_at: "2026-09-23T05:10:00+00:00",
    unread_count: 3,
    oldest_unread_landed_at: "2026-09-23T05:20:00+00:00",
    next_due_at: "2026-09-24T00:00:00+00:00",
    runs_today: 6,
    blocked_reason: "daily_ceiling",
    contact_missing: false,
    unplaced_for_contact: { count: 2, newest_at: "2026-09-23T05:25:00+00:00" },
    line: "any text the SQL function rendered",
  };
  assertEquals(freshnessFromRpc(held, R6_JOB), withoutJobId(held));
  // an unknown future blocked reason is carried, not dropped
  assertEquals(
    freshnessFromRpc({ ...held, blocked_reason: "some_future_reason" }, R6_JOB)
      ?.blocked_reason,
    "some_future_reason",
  );
});

Deno.test("K4 an answer carrying its own job_id (the K1 body) is accepted and the key dropped; another job's is refused", () => {
  assertEquals(
    freshnessFromRpc({ ...R13_LIVE, job_id: R13_JOB }, R13_JOB),
    withoutJobId(R13_LIVE),
  );
  assertEquals(
    freshnessFromRpc({ ...R13_LIVE, job_id: R6_JOB }, R13_JOB),
    null,
  );
});
