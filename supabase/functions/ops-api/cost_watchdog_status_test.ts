// deno-lint-ignore-file no-explicit-any
// Cost watchdog status is a staff read. Acknowledging a trip does not turn a
// switch back on. Run: deno test --allow-read supabase/functions/ops-api/cost_watchdog_status_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  COST_WATCHDOG_RECENT_LIMIT,
  COST_WATCHDOG_SWITCH_KEYS,
  ackCostWatchdogTripAction,
  costWatchdogStatusAction,
  type CostWatchdogAuthMode,
} from "./cost_watchdog_status.ts";

const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const TRIP = "00000000-0000-4000-8000-0000000000bb";

type Call = { op: string; table: string; payload?: unknown };

function chain(result: Record<string, unknown>, calls: Call[], op: string, table: string, payload?: unknown) {
  calls.push({ op, table, payload });
  const api: any = {
    select() {
      return api;
    },
    eq() {
      return api;
    },
    is() {
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    update(next: unknown) {
      return chain(result, calls, "update", table, next);
    },
    insert(next: unknown) {
      return chain(result, calls, "insert", table, next);
    },
    delete() {
      return chain(result, calls, "delete", table);
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(onFulfilled: any, onRejected: any) {
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return api;
}

function client(seed: {
  switches?: unknown;
  trips?: unknown;
  count?: number;
  existing?: Record<string, unknown> | null;
  updated?: Record<string, unknown> | null;
  switchError?: boolean;
  countError?: boolean;
}) {
  const calls: Call[] = [];
  return {
    calls,
    rpc(name: string) {
      calls.push({ op: "rpc", table: name });
      if (seed.switchError) return Promise.resolve({ data: null, error: { message: "ZZTEST" } });
      return Promise.resolve({ data: seed.switches ?? [], error: null });
    },
    from(table: string) {
      if (table === "cost_watchdog_trips") {
        return {
          select(_cols: string, opts?: { head?: boolean }) {
            if (opts?.head) {
              calls.push({ op: "count", table });
              const result = seed.countError
                ? { data: null, error: { message: "ZZTEST" }, count: null }
                : { data: null, error: null, count: seed.count ?? 0 };
              return chain(result, calls, "count-query", table);
            }
            calls.push({ op: "select", table });
            return chain({ data: seed.trips ?? [], error: null }, calls, "select-query", table);
          },
          update(payload: unknown) {
            calls.push({ op: "update", table, payload });
            return chain(
              { data: seed.updated ?? null, error: null },
              calls,
              "update-query",
              table,
              payload,
            );
          },
          insert(payload: unknown) {
            calls.push({ op: "insert", table, payload });
            return chain({ data: null, error: null }, calls, "insert-query", table, payload);
          },
          delete() {
            calls.push({ op: "delete", table });
            return chain({ data: null, error: null }, calls, "delete-query", table);
          },
        };
      }
      return {
        select() {
          calls.push({ op: "select", table });
          return chain({ data: seed.existing ?? null, error: null }, calls, "select-query", table);
        },
        update(payload: unknown) {
          calls.push({ op: "update", table, payload });
          return chain({ data: null, error: { message: "ZZTEST write" } }, calls, "update-query", table, payload);
        },
        insert() {
          calls.push({ op: "insert", table });
          return chain({ data: null, error: { message: "ZZTEST write" } }, calls, "insert-query", table);
        },
        delete() {
          calls.push({ op: "delete", table });
          return chain({ data: null, error: { message: "ZZTEST write" } }, calls, "delete-query", table);
        },
      };
    },
  };
}

function staff(role: string) {
  return { id: ACTOR, role };
}

Deno.test("status is refused for a trade and for a caller with no session", async () => {
  const blocked: Array<[CostWatchdogAuthMode, { id?: string; role?: string } | null]> = [
    ["none", null],
    ["jwt", null],
    ["jwt", { role: "trade", id: ACTOR }],
    ["jwt", { role: "crew", id: ACTOR }],
    ["jwt", { role: "sales", id: ACTOR }],
    ["jwt", { role: "lead_installer", id: ACTOR }],
    ["api_key", staff("owner")],
    ["routine", staff("admin")],
    ["agent_read", staff("ops_manager")],
    ["jwt", { role: "owner" }],
  ];
  for (const [mode, actor] of blocked) {
    const store = client({});
    const response = await costWatchdogStatusAction(store, "GET", mode, actor);
    assertEquals(response.status, 403, mode + " " + (actor?.role ?? "anon"));
    assertEquals(store.calls.length, 0);
  }
});

Deno.test("status lists the watched switches and the latest trips, and writes nothing", async () => {
  const trips = Array.from({ length: 30 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    switch_key: "job_profit_refresh_v1",
    reason: "ZZTEST",
  }));
  const store = client({
    switches: [
      { key: "reconcile_matcher_v1", enabled: false, updated_at: "2026-11-20T00:00:00Z" },
      { key: "job_profit_refresh_v1", enabled: true, updated_at: "2026-11-20T00:00:00Z" },
    ],
    trips,
    count: 4,
  });
  for (const role of ["owner", "admin", "ops_manager", "OWNER"]) {
    const response = await costWatchdogStatusAction(store, "GET", "jwt", staff(role));
    assertEquals(response.status, 200, role);
    const body = await response.json();
    assertEquals(body.switches.map((row: { key: string }) => row.key), [...COST_WATCHDOG_SWITCH_KEYS].sort());
    assertEquals(body.switches.find((row: { key: string }) => row.key === "job-pages-refresh").enabled, null);
    assertEquals(body.switches.find((row: { key: string }) => row.key === "reconcile_matcher_v1").enabled, false);
    assertEquals(body.unacknowledged_trips_count, 4);
    assertEquals(body.recent_trips.length, COST_WATCHDOG_RECENT_LIMIT);
  }
  assert(store.calls.every((call) => call.op === "rpc" || call.op === "select" || call.op === "count" || call.op === "select-query" || call.op === "count-query"));
  assert(store.calls.every((call) => call.table === "cost_watchdog_switches" || call.table === "cost_watchdog_trips"));
  assertEquals(store.calls.some((call) => call.op === "update" || call.op === "insert" || call.op === "delete"), false);
});

Deno.test("status refuses a write method and an unreadable count", async () => {
  const method = await costWatchdogStatusAction(client({}), "POST", "jwt", staff("owner"));
  assertEquals(method.status, 405);
  const broken = client({ countError: true, switches: [], trips: [] });
  const response = await costWatchdogStatusAction(broken, "GET", "jwt", staff("admin"));
  assertEquals(response.status, 503);
});

Deno.test("acknowledging a trip stamps the actor and does not enable a switch", async () => {
  const open = {
    id: TRIP,
    switch_key: "reconcile_matcher_v1",
    new_value: false,
    acknowledged_at: null,
    reason: "ZZTEST",
  };
  const stamped = {
    ...open,
    acknowledged_at: "2026-11-20T01:00:00Z",
    acknowledged_by: ACTOR,
    ack_note: "ZZTEST seen",
  };
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      if (table !== "cost_watchdog_trips") {
        calls.push({ op: "touch", table });
        throw new Error("ack touched " + table);
      }
      let mode = "select";
      const api: any = {
        select() {
          return api;
        },
        eq() {
          return api;
        },
        is() {
          return api;
        },
        update(payload: unknown) {
          mode = "update";
          calls.push({ op: "update", table, payload });
          return api;
        },
        maybeSingle() {
          if (mode === "update") return Promise.resolve({ data: stamped, error: null });
          calls.push({ op: "select", table });
          return Promise.resolve({ data: open, error: null });
        },
      };
      return api;
    },
  };
  const denied = await ackCostWatchdogTripAction(db, "POST", "jwt", { id: ACTOR, role: "trade" }, {
    trip_id: TRIP,
  });
  assertEquals(denied.status, 403);
  assertEquals(calls.length, 0);

  const response = await ackCostWatchdogTripAction(db, "POST", "jwt", staff("ops_manager"), {
    trip_id: TRIP,
    note: " ZZTEST seen ",
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.already_acknowledged, false);
  assertEquals(body.trip.acknowledged_by, ACTOR);
  assertEquals(body.trip.new_value, false);
  const update = calls.find((call) => call.op === "update");
  const payload = update?.payload as Record<string, unknown>;
  assertEquals(payload.acknowledged_by, ACTOR);
  assertEquals(payload.ack_note, "ZZTEST seen");
  assertEquals("enabled" in payload, false);
  assertEquals(calls.some((call) => call.table !== "cost_watchdog_trips"), false);
});

Deno.test("a second acknowledgement does not rewrite the first, and a missing trip is 404", async () => {
  const calls: Call[] = [];
  const db = {
    calls,
    from(table: string) {
      const api: any = {
        select() {
          return api;
        },
        eq() {
          return api;
        },
        is() {
          return api;
        },
        update(payload: unknown) {
          calls.push({ op: "update", table, payload });
          return api;
        },
        maybeSingle() {
          calls.push({ op: "select", table });
          return Promise.resolve({
            data: { id: TRIP, acknowledged_at: "2026-11-20T01:00:00Z", new_value: false },
            error: null,
          });
        },
      };
      return api;
    },
  };
  const again = await ackCostWatchdogTripAction(db, "POST", "jwt", staff("owner"), { trip_id: TRIP });
  assertEquals(again.status, 200);
  assertEquals((await again.json()).already_acknowledged, true);
  assertEquals(calls.some((call) => call.op === "update"), false);

  const missingDb = {
    from(_table: string) {
      const api: any = {
        select() {
          return api;
        },
        eq() {
          return api;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
      };
      return api;
    },
  };
  const missing = await ackCostWatchdogTripAction(missingDb, "POST", "jwt", staff("admin"), {
    trip_id: TRIP,
  });
  assertEquals(missing.status, 404);
});

Deno.test("acknowledgement rejects a bad body and a non-POST", async () => {
  const store = client({});
  assertEquals((await ackCostWatchdogTripAction(store, "GET", "jwt", staff("owner"), {})).status, 405);
  assertEquals((await ackCostWatchdogTripAction(store, "POST", "jwt", staff("owner"), { trip_id: "ZZTEST" })).status, 400);
  assertEquals((await ackCostWatchdogTripAction(store, "POST", "jwt", staff("owner"), {
    trip_id: TRIP,
    enabled: true,
  })).status, 400);
  assertEquals(store.calls.length, 0);
});
