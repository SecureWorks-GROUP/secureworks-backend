// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listVisitOutcomesAction,
  parseVisitOutcome,
  recordVisitOutcomeAction,
  type VisitOutcomeDatabase,
  VisitOutcomeError,
} from "./visit_outcomes.ts";

const USER = "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73";
const AUTH = { mode: "jwt", userId: USER, isStaffOperator: true };
const INPUT = {
  booking_key: "booking:scope:123",
  contact_id: "ghl-contact",
  scoper_user_id: USER,
  scoper_name: "Nithin",
  visit_start: "2026-09-15T10:00:00+08:00",
  outcome: "happened",
};
function database(
  data: unknown = {},
  error: { code: string; message: string } | null = null,
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const requested: string[] = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      requested.push("rpc");
      calls.push({ name, args });
      return Promise.resolve({ data, error });
    },
    sendCustomerMessage: () => {
      requested.push("message");
      return Promise.resolve();
    },
    ghlRequest: () => {
      requested.push("ghl");
      return Promise.resolve();
    },
    calendarWrite: () => {
      requested.push("calendar");
      return Promise.resolve();
    },
  };
  return { db: db as VisitOutcomeDatabase, calls, requested };
}

Deno.test("record stores the authenticated actor, default quote obligation and only allowed fields", async () => {
  const row = {
    ...parseVisitOutcome(INPUT),
    id: "generated",
    recorded_at: "server-time",
  };
  const { db, calls, requested } = database(row);
  assertEquals(
    await recordVisitOutcomeAction(db, AUTH, {
      ...INPUT,
      id: "forged",
      recorded_at: "yesterday",
      recorded_by_user_id: "someone-else",
      source: "forged",
    }),
    { visit_outcome: row },
  );
  assertEquals(requested, ["rpc"]);
  assertEquals(calls, [{
    name: "record_visit_outcome",
    args: { p_record: parseVisitOutcome(INPUT), p_recorded_by_user_id: USER },
  }]);
  assertEquals(parseVisitOutcome(INPUT).quote_owed, true);
  assertEquals(
    parseVisitOutcome({ ...INPUT, quote_owed: false }).quote_owed,
    false,
  );
  assertEquals(parseVisitOutcome(INPUT).appointment_id, null);
  assertEquals(
    parseVisitOutcome(INPUT).visit_start,
    "2026-09-15T02:00:00.000Z",
  );
});

Deno.test("record normalizes singleton composite RPC rows and refuses empty or ambiguous success", async () => {
  const row = {
    ...parseVisitOutcome(INPUT),
    id: "generated",
    recorded_at: "server-time",
  };
  assertEquals(
    await recordVisitOutcomeAction(database([row]).db, AUTH, INPUT),
    { visit_outcome: row },
  );
  for (const data of [[], [row, row], {}, "bad response"]) {
    const err = await assertRejects(
      () => recordVisitOutcomeAction(database(data).db, AUTH, INPUT),
      VisitOutcomeError,
    );
    assertEquals(err.status, 503);
  }
});

Deno.test("all missed-visit reasons are accepted and quote_owed defaults false", () => {
  for (
    const reason of ["customer_not_home", "we_did_not_attend", "rescheduled"]
  ) {
    const row = parseVisitOutcome({
      ...INPUT,
      outcome: "did_not_happen",
      reason,
    });
    assertEquals(row.reason, reason);
    assertEquals(row.quote_owed, false);
  }
});

Deno.test("strict input constraints refuse malformed records before a write", async () => {
  const { db, calls } = database();
  for (
    const bad of [
      null,
      [],
      "oops",
      { ...INPUT, booking_key: "" },
      { ...INPUT, contact_id: null },
      { ...INPUT, scoper_user_id: "ghl-id" },
      { ...INPUT, scoper_name: "" },
      { ...INPUT, job_id: "job-1" },
      { ...INPUT, supersedes: "bad" },
      { ...INPUT, outcome: "unknown" },
      { ...INPUT, reason: "rescheduled" },
      { ...INPUT, outcome: "did_not_happen" },
      { ...INPUT, outcome: "did_not_happen", reason: "unknown" },
      { ...INPUT, outcome: "did_not_happen", reason: ["rescheduled"] },
      { ...INPUT, quote_owed: "false" },
      { ...INPUT, note: "a".repeat(201) },
      { ...INPUT, note: "two\nlines" },
      { ...INPUT, note: "two\r\nlines" },
      { ...INPUT, note: "two\u2028lines" },
      { ...INPUT, note: "null\0byte" },
      { ...INPUT, visit_start: "2026-09-15T10:00:00" },
      { ...INPUT, visit_start: "2026-02-30T10:00:00+08:00" },
      { ...INPUT, visit_start: "2026-09-15T24:00:00+08:00" },
      { ...INPUT, visit_start: "2026-09-15T10:00:00+25:00" },
    ]
  ) {
    await assertRejects(
      () => recordVisitOutcomeAction(db, AUTH, bad),
      VisitOutcomeError,
    );
  }
  assertEquals(calls.length, 0);
  assertEquals(
    parseVisitOutcome({ ...INPUT, note: "😀".repeat(200) }).note,
    "😀".repeat(200),
  );
  assertThrows(
    () => parseVisitOutcome({ ...INPUT, note: "😀".repeat(201) }),
    VisitOutcomeError,
  );
});

Deno.test("writes require operator JWT and POST; reads admit server operators but never routine/trade callers", async () => {
  const { db, calls } = database();
  for (const mode of ["none", "api_key", "routine", "agent_read"]) {
    await assertRejects(
      () => recordVisitOutcomeAction(db, { ...AUTH, mode }, INPUT),
      VisitOutcomeError,
    );
  }
  await assertRejects(
    () => recordVisitOutcomeAction(db, { ...AUTH, userId: null }, INPUT),
    VisitOutcomeError,
  );
  await assertRejects(
    () =>
      recordVisitOutcomeAction(db, { ...AUTH, isStaffOperator: false }, INPUT),
    VisitOutcomeError,
  );
  await assertRejects(
    () => recordVisitOutcomeAction(db, AUTH, INPUT, "GET"),
    VisitOutcomeError,
  );
  const query = {
    since: "2026-09-01T00:00:00+08:00",
    until: "2026-10-01T00:00:00+08:00",
  };
  for (
    const auth of [
      { ...AUTH, isStaffOperator: false },
      { ...AUTH, mode: "routine" },
      { ...AUTH, mode: "none" },
    ]
  ) {
    await assertRejects(
      () => listVisitOutcomesAction(db, auth, query),
      VisitOutcomeError,
    );
  }
  await assertRejects(
    () => listVisitOutcomesAction(db, AUTH, query, "POST"),
    VisitOutcomeError,
  );
  assertEquals(calls.length, 0);
  await listVisitOutcomesAction(
    db,
    { mode: "api_key", isStaffOperator: true },
    query,
  );
  assertEquals(calls.length, 1);
});

Deno.test("reader passes half-open range, optional filters, history and pagination to one snapshot RPC", async () => {
  const page = {
    outcomes: [],
    history: [],
    limit: 20,
    offset: 40,
    has_more: false,
  };
  const { db, calls } = database(page);
  const query = {
    since: "2026-09-14T00:00:00+08:00",
    until: "2026-09-21T00:00:00+08:00",
    scoper_user_id: USER,
    contact_id: "ghl-contact",
    include_history: "true",
    limit: "20",
    offset: "40",
  };
  assertEquals(await listVisitOutcomesAction(db, AUTH, query), page);
  assertEquals(calls, [{
    name: "list_visit_outcomes",
    args: {
      p_since: "2026-09-13T16:00:00.000Z",
      p_until: "2026-09-20T16:00:00.000Z",
      p_scoper_user_id: USER,
      p_contact_id: "ghl-contact",
      p_include_history: true,
      p_limit: 20,
      p_offset: 40,
    },
  }]);
  await listVisitOutcomesAction(db, AUTH, {
    since: query.since,
    until: query.until,
  });
  assertEquals(calls[1].args.p_limit, 100);
  assertEquals(calls[1].args.p_include_history, false);
});

Deno.test("reader rejects invalid or unbounded ranges and pagination", async () => {
  const { db, calls } = database();
  const query = {
    since: "2026-09-01T00:00:00Z",
    until: "2026-10-01T00:00:00Z",
  };
  for (
    const patch of [
      { since: undefined },
      { until: query.since },
      { until: "2028-01-01T00:00:00Z" },
      { scoper_user_id: "bad" },
      { contact_id: "" },
      { include_history: "yes" },
      { limit: 501 },
      { limit: 0 },
      { offset: -1 },
      { limit: 1.5 },
      { limit: false },
      { limit: "" },
    ]
  ) {
    await assertRejects(
      () => listVisitOutcomesAction(db, AUTH, { ...query, ...patch }),
      VisitOutcomeError,
    );
  }
  assertEquals(calls.length, 0);
});

Deno.test("RPC errors fail loudly instead of returning an empty business record", async () => {
  for (
    const [code, status] of [["P0001", 409], ["23514", 400], [
      "42703",
      503,
    ]] as const
  ) {
    const { db } = database(null, { code, message: "database error" });
    const err = await assertRejects(
      () => recordVisitOutcomeAction(db, AUTH, INPUT),
      VisitOutcomeError,
    );
    assertEquals(err.status, status);
  }
  const { db } = database(null);
  assertEquals(
    (await assertRejects(
      () => recordVisitOutcomeAction(db, AUTH, INPUT),
      VisitOutcomeError,
    )).status,
    503,
  );
});
