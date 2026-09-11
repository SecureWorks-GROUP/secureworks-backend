// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  latestClosedWeek,
  PerformanceError,
  salesPerformanceAction,
  salesPerformanceStore,
} from "./sales_performance.ts";
import type {
  PerformanceCaller,
  PerformanceRow,
  PerformanceStore,
} from "./sales_performance.ts";
const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const NOW = new Date("2026-09-11T08:00:00Z");
const staff: PerformanceCaller = {
  mode: "jwt",
  staff: true,
  serviceRole: false,
  orgId: ORG,
  userId: "captain",
};
const service: PerformanceCaller = {
  mode: "api_key",
  staff: true,
  serviceRole: true,
};
function payload(week = "2026-08-31", lane = "fencing") {
  return {
    org_id: ORG,
    week_start: week,
    lane,
    metrics: { enquiries: null },
    coverage: { collection_complete: true, gaps: ["calls unavailable"] },
    queues: {},
    run_id: "run-1",
    definition_version: "v1",
    computed_at: "2026-09-07T00:00:00Z",
  };
}
class MemoryStore implements PerformanceStore {
  rows = new Map<string, PerformanceRow>();
  calls = 0;
  key(org: string, week: string, lane: string) {
    return `${org}/${week}/${lane}`;
  }
  write(row: Omit<PerformanceRow, "notes">): Promise<PerformanceRow> {
    this.calls++;
    const key = this.key(row.org_id, row.week_start, row.lane);
    const result = { ...row, notes: this.rows.get(key)?.notes ?? null };
    this.rows.set(key, result);
    return Promise.resolve(result);
  }
  note(week: string, lane: string, text: string): Promise<PerformanceRow> {
    this.calls++;
    const key = this.key(ORG, week, lane);
    const row = this.rows.get(key);
    if (!row) {
      return Promise.reject(new PerformanceError(404, "report_not_found"));
    }
    const result = {
      ...row,
      notes: {
        text,
        author_id: "captain",
        author_name: "Sample Captain",
        updated_at: NOW.toISOString(),
      },
    };
    this.rows.set(key, result);
    return Promise.resolve(result);
  }
  read(org: string, from: string, through: string): Promise<PerformanceRow[]> {
    this.calls++;
    return Promise.resolve(
      [...this.rows.values()].filter((r) =>
        r.org_id === org && r.week_start >= from && r.week_start <= through
      ),
    );
  }
  weeks(org: string): Promise<string[]> {
    this.calls++;
    return Promise.resolve(
      [
        ...new Set(
          [...this.rows.values()].filter((r) => r.org_id === org).map((r) =>
            r.week_start
          ),
        ),
      ].sort().reverse(),
    );
  }
}
function action(
  store: PerformanceStore,
  action: string,
  input: unknown,
  caller = service,
  query = "",
  method = "POST",
) {
  return salesPerformanceAction(
    store,
    `sales_performance_${action}`,
    method,
    new URLSearchParams(query),
    input,
    caller,
    NOW,
  );
}
Deno.test("collector write refuses every non-service caller before touching storage", async () => {
  for (
    const caller of [
      staff,
      { ...service, serviceRole: false },
      { ...service, mode: "routine" },
      { ...service, mode: "agent_read" },
      { ...service, mode: "none" },
    ]
  ) {
    const db = new MemoryStore();
    assertEquals((await action(db, "write", payload(), caller)).status, 403);
    assertEquals(db.calls, 0);
  }
});
Deno.test("read and note require authenticated staff profile and tenant", async () => {
  for (const name of ["read", "note"]) {
    for (
      const caller of [service, { ...staff, userId: "" }, {
        ...staff,
        staff: false,
      }, { ...staff, orgId: "" }]
    ) {
      const db = new MemoryStore();
      const response = await action(
        db,
        name,
        { week_start: "2026-08-31", lane: "patio", note: "x" },
        caller,
        "",
        name === "read" ? "GET" : "POST",
      );
      assertEquals([401, 403].includes(response.status), true);
      assertEquals(db.calls, 0);
    }
  }
});
Deno.test("invalid report shapes and incomplete collection never publish", async () => {
  const bad = [
    { week_start: "2026-09-01" },
    { week_start: "2026-02-30" },
    { week_start: "2026-8-31" },
    { lane: "roofing" },
    { org_id: OTHER + "x" },
    { metrics: [] },
    { queues: null },
    { coverage: undefined },
    { coverage: {} },
    { coverage: { gaps: [] } },
    { coverage: { gaps: [], collection_complete: false } },
    { coverage: { gaps: [], collection_complete: "true" } },
    { notes: { text: "impersonation" } },
    { computed_at: "tomorrow" },
    { computed_at: "2026-02-30T00:00:00Z" },
    { computed_at: "2026-08-31T24:00:00Z" },
    { computed_at: "2026-10-01T00:00:00Z" },
    { run_id: "" },
    { definition_version: "" },
  ];
  for (const change of bad) {
    const db = new MemoryStore();
    assertEquals(
      (await action(db, "write", { ...payload(), ...change })).status,
      400,
      JSON.stringify(change),
    );
    assertEquals(db.calls, 0);
  }
});
Deno.test("known coverage gaps and null values survive unchanged; rerun keeps note", async () => {
  const db = new MemoryStore();
  const first = await action(db, "write", payload());
  assertEquals(first.status, 200);
  assertEquals((first.body.row as PerformanceRow).metrics, { enquiries: null });
  const note = await action(db, "note", {
    week_start: "2026-08-31",
    lane: "fencing",
    note: "Check source",
  }, staff);
  const rerun = await action(db, "write", {
    ...payload(),
    run_id: "run-2",
    metrics: { enquiries: 3 },
  });
  assertEquals(
    (rerun.body.row as PerformanceRow).notes,
    (note.body.row as PerformanceRow).notes,
  );
  assertEquals(db.rows.size, 1);
});
Deno.test("both request interleavings retain latest report and authored note (store contract)", async () => {
  for (const noteFirst of [true, false]) {
    const db = new MemoryStore();
    await action(db, "write", payload());
    const note = () =>
      action(db, "note", {
        week_start: "2026-08-31",
        lane: "fencing",
        note: "Coaching",
      }, staff);
    const rerun = () => action(db, "write", { ...payload(), run_id: "run-2" });
    await Promise.all(noteFirst ? [note(), rerun()] : [rerun(), note()]);
    const row = [...db.rows.values()][0];
    assertEquals(row.run_id, "run-2");
    assertEquals(row.notes?.text, "Coaching");
  }
});
Deno.test("note forbids caller attribution, org, metrics and missing report; empty note clears box", async () => {
  const db = new MemoryStore();
  const body = { week_start: "2026-08-31", lane: "fencing", note: "" };
  assertEquals((await action(db, "note", body, staff)).status, 404);
  await action(db, "write", payload());
  for (
    const change of [
      { author_id: "other" },
      { org_id: OTHER },
      { metrics: {} },
      { note: null },
      { note: "x".repeat(10001) },
    ]
  ) {
    assertEquals(
      (await action(db, "note", { ...body, ...change }, staff)).status,
      400,
    );
  }
  assertEquals((await action(db, "note", body, staff)).status, 200);
});
Deno.test("Perth Monday rollover chooses fully closed week", () => {
  assertEquals(
    latestClosedWeek(new Date("2026-09-13T15:59:59Z")),
    "2026-08-31",
  );
  assertEquals(
    latestClosedWeek(new Date("2026-09-13T16:00:00Z")),
    "2026-09-07",
  );
});
Deno.test("four consecutive calendar weeks, both lanes, no cross-org or old/current rows, freshness separate", async () => {
  const db = new MemoryStore();
  for (
    const week of [
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
    ]
  ) {
    for (const lane of ["patio", "fencing"]) {
      await db.write(payload(week, lane));
    }
  }
  await db.write({ ...payload(), org_id: OTHER });
  const result = await action(db, "read", {}, staff, "", "GET");
  const rows = result.body.rows as PerformanceRow[];
  assertEquals(rows.length, 8);
  assertEquals(result.body.week_start, "2026-08-31");
  assertEquals(result.body.week_starts, [
    "2026-08-31",
    "2026-08-24",
    "2026-08-17",
    "2026-08-10",
  ]);
  assertEquals(rows.every((r) => r.org_id === ORG), true);
  assertEquals(rows[0].computed_at, payload().computed_at);
  assertEquals(result.body.fetched_at, NOW.toISOString());
  assertEquals(
    (await action(db, "read", {}, staff, `org_id=${OTHER}`, "GET")).status,
    400,
  );
  assertEquals(
    (await action(db, "read", {}, staff, "week_start=2026-09-01", "GET"))
      .status,
    400,
  );
  assertEquals(
    (await action(db, "read", {}, staff, "week_start=2026-08-24", "GET")).body
      .week_start,
    "2026-08-24",
  );
});
Deno.test("latest stored closed week defaults with explicit missing-current warning", async () => {
  const db = new MemoryStore();
  await db.write(payload("2026-08-03"));
  const result = await action(db, "read", {}, staff, "", "GET");
  assertEquals((result.body.rows as PerformanceRow[]).length, 1);
  assertEquals(result.body.week_start, "2026-08-03");
  assertEquals(result.body.latest_closed_week, "2026-08-31");
  assertEquals(result.body.missing_latest_closed_week, true);
  const empty = await action(new MemoryStore(), "read", {}, staff, "", "GET");
  assertEquals(empty.body.week_start, "2026-08-31");
  assertEquals(empty.body.rows, []);
  assertEquals(
    (await action(db, "write", payload(), service, "", "GET")).status,
    405,
  );
  assertEquals((await action(db, "read", {}, staff)).status, 405);
});
Deno.test("adapter sends no notes in report RPC and no authored identity in note RPC", async () => {
  const calls: unknown[] = [];
  const store = salesPerformanceStore({
    rpc(name: string, params: unknown) {
      calls.push({ name, params });
      return Promise.resolve({ data: payload(), error: null });
    },
  });
  await store.write(payload());
  await store.note("2026-08-31", "fencing", "hello");
  assertEquals(calls, [
    {
      name: "sales_performance_write_v1",
      params: Object.fromEntries(
        Object.entries(payload()).map(([k, v]) => [`p_${k}`, v]),
      ),
    },
    {
      name: "sales_performance_note_v1",
      params: {
        p_week_start: "2026-08-31",
        p_lane: "fencing",
        p_note: "hello",
      },
    },
  ]);
});
Deno.test("storage failures return safe failure, never a success receipt", async () => {
  const db = salesPerformanceStore({
    rpc: () =>
      Promise.resolve({
        data: null,
        error: { code: "XX000", message: "sensitive internals" },
      }),
  });
  const result = await action(db, "write", payload());
  assertEquals(result.status, 502);
  assertEquals(result.body.error, "sales_performance_storage_failed");
});
