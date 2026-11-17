// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  parseSavingsGoalInput,
  readMySavingsGoal,
  setMySavingsGoal,
} from "./trade_savings_goal.ts";
import { TRADE_PREVIEW_READS } from "./trade_owner_preview.ts";

const TRADE_1 = "trade-1";
const TRADE_2 = "trade-2";
const NOW = () => "2026-11-18T01:00:00.000Z";

// In-memory trade_savings_goals, one row per user_id, with optional faults.
function fakeStore(fail: { read?: boolean; write?: boolean; throwRead?: boolean } = {}) {
  const rows = new Map<string, any>();
  const writes: any[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "trade_savings_goals");
      const q: any = { op: "select", filters: [] as Array<[string, unknown]>, payload: null, opts: null };
      const chain: any = {
        select() { return chain; },
        eq(col: string, val: unknown) { q.filters.push([col, val]); return chain; },
        upsert(payload: any, opts: any) { q.op = "upsert"; q.payload = payload; q.opts = opts; return chain; },
        delete() { q.op = "delete"; return chain; },
        maybeSingle() {
          if (fail.throwRead) return Promise.reject(new Error("network"));
          if (fail.read) return Promise.resolve({ data: null, error: { message: "boom" } });
          const userId = q.filters.find(([c]: any) => c === "user_id")?.[1];
          return Promise.resolve({ data: rows.get(String(userId)) ?? null, error: null });
        },
        single() {
          writes.push({ op: q.op, payload: q.payload, opts: q.opts });
          if (fail.write) return Promise.resolve({ data: null, error: { message: "boom" } });
          rows.set(q.payload.user_id, { ...q.payload });
          return Promise.resolve({ data: { ...q.payload }, error: null });
        },
        then(resolve: any, reject: any) {
          // A bare delete().eq(...) is awaited directly.
          writes.push({ op: q.op, filters: q.filters });
          if (fail.write) return Promise.resolve({ error: { message: "boom" } }).then(resolve, reject);
          const userId = q.filters.find(([c]: any) => c === "user_id")?.[1];
          rows.delete(String(userId));
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
  return { client, rows, writes };
}

const GOAL = { label: "New ute", target_amount: 20000, saved_amount: 2500.5, target_date: "2027-06-30" };

Deno.test("set, read, change, clear: the caller's goal round-trips", async () => {
  const { client, rows } = fakeStore();
  assertEquals((await readMySavingsGoal(client, TRADE_1)).body, { ok: true, goal: null });

  const set = await setMySavingsGoal(client, TRADE_1, GOAL, NOW);
  assertEquals(set.status, 200);
  assertEquals(set.body, {
    ok: true,
    goal: { ...GOAL, updated_at: NOW() },
  });

  const read = await readMySavingsGoal(client, TRADE_1);
  assertEquals(read.status, 200);
  assertEquals(read.body, { ok: true, goal: { ...GOAL, updated_at: NOW() } });

  const changed = await setMySavingsGoal(client, TRADE_1, { label: "  Holiday  ", target_amount: "5000", saved_amount: "", target_date: "" }, NOW);
  assertEquals(changed.body, {
    ok: true,
    goal: { label: "Holiday", target_amount: 5000, saved_amount: 0, target_date: null, updated_at: NOW() },
  });
  assertEquals(rows.size, 1);

  const cleared = await setMySavingsGoal(client, TRADE_1, { clear: true }, NOW);
  assertEquals(cleared, { status: 200, body: { ok: true, goal: null } });
  assertEquals(rows.size, 0);
  assertEquals((await readMySavingsGoal(client, TRADE_1)).body, { ok: true, goal: null });
});

Deno.test("a second trade cannot read or change the first trade's goal", async () => {
  const { client, rows } = fakeStore();
  await setMySavingsGoal(client, TRADE_1, GOAL, NOW);
  const before = JSON.stringify(rows.get(TRADE_1));

  assertEquals((await readMySavingsGoal(client, TRADE_2)).body, { ok: true, goal: null });
  await setMySavingsGoal(client, TRADE_2, { label: "Tools", target_amount: 900 }, NOW);
  await setMySavingsGoal(client, TRADE_2, { clear: true }, NOW);

  assertEquals(JSON.stringify(rows.get(TRADE_1)), before);
  assertEquals(rows.has(TRADE_2), false);
});

Deno.test("a user id in the body is ignored: the row lands under the session trade", async () => {
  const { client, rows, writes } = fakeStore();
  await setMySavingsGoal(client, TRADE_2, { label: "Theirs", target_amount: 100 }, NOW);
  const trade2Before = JSON.stringify(rows.get(TRADE_2));

  const answer = await setMySavingsGoal(client, TRADE_1, {
    ...GOAL,
    user_id: TRADE_2,
    userId: TRADE_2,
    id: TRADE_2,
    updated_at: "1999-01-01T00:00:00Z",
    extra: "not stored",
  }, NOW);
  assertEquals(answer.status, 200);

  const upsert = writes.at(-1);
  // Built field by field: exactly the goal columns, under the session id.
  assertEquals(Object.keys(upsert.payload).sort(), [
    "label", "saved_amount", "target_amount", "target_date", "updated_at", "user_id",
  ]);
  assertEquals(upsert.payload.user_id, TRADE_1);
  assertEquals(upsert.payload.updated_at, NOW());
  assertEquals(upsert.opts, { onConflict: "user_id" });
  assertEquals(JSON.stringify(rows.get(TRADE_2)), trade2Before);

  // Clearing with a body user id clears only the caller's own goal.
  await setMySavingsGoal(client, TRADE_1, { clear: true, user_id: TRADE_2 }, NOW);
  assertEquals(rows.has(TRADE_1), false);
  assertEquals(JSON.stringify(rows.get(TRADE_2)), trade2Before);
});

Deno.test("invalid inputs refuse 400 goal_invalid naming the field, and write nothing", async () => {
  const cases: Array<[any, string]> = [
    [{ ...GOAL, label: undefined }, "label"],
    [{ ...GOAL, label: "   " }, "label"],
    [{ ...GOAL, label: "x".repeat(61) }, "label"],
    [{ ...GOAL, label: 42 }, "label"],
    // PostgreSQL text refuses NUL: a 400 naming the label, never a 503.
    [{ ...GOAL, label: "Ute\u0000fund" }, "label"],
    [{ ...GOAL, label: "\u0000" }, "label"],
    // A lone UTF-16 surrogate cannot be stored either: 400, never 503.
    [{ ...GOAL, label: JSON.parse('"\\uD800"') }, "label"],
    [{ ...GOAL, label: "Ute\uDC00fund" }, "label"],
    [{ ...GOAL, label: "Ute fund\uD83D" }, "label"],
    [{ ...GOAL, label: "\uDE97\uD83D" }, "label"],
    [{ ...GOAL, target_amount: 0 }, "target_amount"],
    [{ ...GOAL, target_amount: 0.004 }, "target_amount"],
    [{ ...GOAL, target_amount: -5 }, "target_amount"],
    [{ ...GOAL, target_amount: 1e10 }, "target_amount"],
    [{ ...GOAL, target_amount: null }, "target_amount"],
    [{ ...GOAL, target_amount: "" }, "target_amount"],
    [{ ...GOAL, target_amount: true }, "target_amount"],
    [{ ...GOAL, target_amount: [5] }, "target_amount"],
    [{ ...GOAL, target_amount: "1e3" }, "target_amount"],
    [{ ...GOAL, target_amount: Number.NaN }, "target_amount"],
    [{ ...GOAL, saved_amount: -0.01 }, "saved_amount"],
    // Negative is refused before rounding: -0.004 must not pass as 0.
    [{ ...GOAL, saved_amount: -0.004 }, "saved_amount"],
    [{ ...GOAL, saved_amount: -1e-9 }, "saved_amount"],
    [{ ...GOAL, saved_amount: "-0.004" }, "saved_amount"],
    [{ ...GOAL, target_amount: -0.004 }, "target_amount"],
    [{ ...GOAL, saved_amount: 1e21 }, "saved_amount"],
    [{ ...GOAL, target_amount: 9999999999.995 }, "target_amount"],
    [{ ...GOAL, saved_amount: "abc" }, "saved_amount"],
    [{ ...GOAL, saved_amount: false }, "saved_amount"],
    [{ ...GOAL, target_date: "2026-02-30" }, "target_date"],
    [{ ...GOAL, target_date: "0000-01-01" }, "target_date"],
    [{ ...GOAL, target_date: "30/06/2027" }, "target_date"],
    [{ ...GOAL, target_date: 20270630 }, "target_date"],
    [null, "label"],
    [[], "label"],
    [{ clear: "true" }, "label"],
  ];
  for (const [body, field] of cases) {
    const { client, writes } = fakeStore();
    const answer = await setMySavingsGoal(client, TRADE_1, body, NOW);
    assertEquals(answer.status, 400, JSON.stringify(body));
    assertEquals((answer.body as any).code, "goal_invalid");
    assertEquals((answer.body as any).field, field, JSON.stringify(body));
    assertEquals(writes.length, 0);
  }
});

Deno.test("boundaries the table accepts are accepted", () => {
  const ok = (body: any) => parseSavingsGoalInput(body).kind === "set";
  assert(ok({ ...GOAL, label: "x".repeat(60) }));
  // 60 code points that are 120 UTF-16 units still fit.
  assert(ok({ ...GOAL, label: "\u{1F697}".repeat(60) }));
  // A valid surrogate pair (an emoji) beside text is still accepted.
  assert(ok({ ...GOAL, label: "Ute \u{1F697} fund" }));
  assertEquals(parseSavingsGoalInput({ ...GOAL, label: "\u{1F697}".repeat(61) }).kind, "invalid");
  assert(ok({ ...GOAL, target_amount: 0.01 }));
  assert(ok({ ...GOAL, target_amount: 9999999999.99 }));
  assert(ok({ ...GOAL, saved_amount: 0 }));
  assert(ok({ ...GOAL, saved_amount: undefined }));
  assert(ok({ ...GOAL, target_date: null }));
  assert(ok({ ...GOAL, target_date: "2024-02-29" }));
  // No rule the spec lacks: a past date and saved above target both pass.
  assert(ok({ ...GOAL, target_date: "2020-01-01" }));
  assert(ok({ ...GOAL, saved_amount: 30000 }));
});

Deno.test("amounts round on the decimal digits, as numeric(12,2) stores them", () => {
  const amounts = (body: any) => {
    const parsed = parseSavingsGoalInput(body);
    assertEquals(parsed.kind, "set", JSON.stringify(body));
    const f = (parsed as any).fields;
    return [f.target_amount, f.saved_amount];
  };
  // Binary Math.round(1.005 * 100) gives 1.00; the column stores 1.01.
  assertEquals(amounts({ ...GOAL, target_amount: "1.005", saved_amount: "1.005" }), [1.01, 1.01]);
  assertEquals(amounts({ ...GOAL, target_amount: 1.005, saved_amount: 1.005 }), [1.01, 1.01]);
  assertEquals(amounts({ ...GOAL, target_amount: "2.675", saved_amount: 1.0049 }), [2.68, 1]);
  assertEquals(amounts({ ...GOAL, target_amount: " 1200.50 ", saved_amount: "0.004" }), [1200.5, 0]);
  assertEquals(amounts({ ...GOAL, target_amount: 9999999999.99, saved_amount: 1e-7 }), [9999999999.99, 0]);
  assertEquals(amounts({ ...GOAL, target_amount: "0.005", saved_amount: "9999999999.994" }), [0.01, 9999999999.99]);
});

Deno.test("a refused set writes nothing and a valid retry then saves", async () => {
  const { client, rows } = fakeStore();
  await setMySavingsGoal(client, TRADE_1, GOAL, NOW);
  const before = JSON.stringify(rows.get(TRADE_1));
  const refused = await setMySavingsGoal(client, TRADE_1, { ...GOAL, target_amount: 0 }, NOW);
  assertEquals(refused.status, 400);
  assertEquals(JSON.stringify(rows.get(TRADE_1)), before);
  const retried = await setMySavingsGoal(client, TRADE_1, { ...GOAL, target_amount: 25000 }, NOW);
  assertEquals(retried.status, 200);
  assertEquals(rows.get(TRADE_1).target_amount, 25000);
});

Deno.test("a failed read is 503 goal_unreadable, never 'no goal'", async () => {
  for (const fail of [{ read: true }, { throwRead: true }]) {
    const { client } = fakeStore(fail);
    const answer = await readMySavingsGoal(client, TRADE_1);
    assertEquals(answer.status, 503);
    assertEquals((answer.body as any).code, "goal_unreadable");
    assert(!("goal" in answer.body));
  }
});

Deno.test("a failed write is 503 goal_unsaved and the saved goal stays", async () => {
  const store = fakeStore();
  await setMySavingsGoal(store.client, TRADE_1, GOAL, NOW);
  const failing = fakeStore({ write: true });
  failing.rows.set(TRADE_1, store.rows.get(TRADE_1));
  const before = JSON.stringify(failing.rows.get(TRADE_1));
  for (const body of [{ ...GOAL, label: "Changed" }, { clear: true }]) {
    const answer = await setMySavingsGoal(failing.client, TRADE_1, body, NOW);
    assertEquals(answer.status, 503);
    assertEquals((answer.body as any).code, "goal_unsaved");
    // The write may have landed: tell the caller to reload, never "nothing changed".
    assert(!/nothing changed/i.test((answer.body as any).error));
    assert(/reload/i.test((answer.body as any).error));
    assertEquals(JSON.stringify(failing.rows.get(TRADE_1)), before);
  }
});

Deno.test("a row the office changed by hand reads back as stored", async () => {
  const { client, rows } = fakeStore();
  rows.set(TRADE_1, {
    user_id: TRADE_1, label: "Edited", target_amount: "1500.00", saved_amount: "0.00",
    target_date: null, updated_at: "2026-11-17T00:00:00Z",
  });
  assertEquals((await readMySavingsGoal(client, TRADE_1)).body, {
    ok: true,
    goal: { label: "Edited", target_amount: 1500, saved_amount: 0, target_date: null, updated_at: "2026-11-17T00:00:00Z" },
  });
});

Deno.test("no session user id is a programming fault, not a read of everyone", async () => {
  const { client } = fakeStore();
  let threw = false;
  try { await readMySavingsGoal(client, ""); } catch { threw = true; }
  assert(threw);
});

// ── Wiring in index.ts ──────────────────────────────────────────────────────
const INDEX_SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

Deno.test("ops-api wires both actions to the session trade, off the preview reads", () => {
  const profileStart = INDEX_SRC.indexOf("const OPS_API_PROFILE_SCOPED_JWT_ACTIONS = new Set([");
  assert(profileStart >= 0);
  const profile = INDEX_SRC.slice(profileStart, INDEX_SRC.indexOf("])", profileStart));
  assert(profile.includes("'my_savings_goal'"));
  assert(profile.includes("'set_my_savings_goal'"));

  const outer = INDEX_SRC.match(/case 'my_jobs':[\s\S]*?case 'submit_makesafe_report': \{/);
  assert(outer);
  assert(outer[0].includes("case 'my_savings_goal':"));
  assert(outer[0].includes("case 'set_my_savings_goal':"));

  const read = INDEX_SRC.match(/case 'my_savings_goal': \{[\s\S]*?\n {10}\}/);
  assert(read);
  assert(read[0].includes("readMySavingsGoal(client, tradeUser.id)"));
  assert(read[0].includes("req.method !== 'GET'"));
  const write = INDEX_SRC.match(/case 'set_my_savings_goal': \{[\s\S]*?\n {10}\}/);
  assert(write);
  assert(write[0].includes("setMySavingsGoal(client, tradeUser.id, body)"));
  assert(write[0].includes("req.method !== 'POST'"));
  // The only user id is the session's: neither case reads one from the request.
  for (const src of [read[0], write[0]]) {
    assert(!/body\??\.user_?id/i.test(src));
    assert(!/searchParams\.get\('user_?id'\)/i.test(src));
  }

  // The owner's view-as-trade preview cannot reach a trade's private goal.
  assert(!TRADE_PREVIEW_READS.has("my_savings_goal"));
  assert(!TRADE_PREVIEW_READS.has("set_my_savings_goal"));
});
