// deno-lint-ignore-file no-import-prefix no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";

const tradeId = "00000000-0000-4000-8000-000000000016";
const officeId = "00000000-0000-4000-8000-000000000017";
const serverKey = `sb_secret_${crypto.randomUUID()}`;
type Row = Record<string, any>;

function fixture() {
  const rates: Row[] = [{
    id: "ZZTEST-old",
    user_id: tradeId,
    hourly_rate: 37.65,
    effective_from: "2001-01-01",
    effective_to: null,
    created_by: tradeId,
    created_at: "2001-01-01T00:00:00Z",
  }];
  let failRead = false;
  let rateReads = 0;
  async function call(
    action: string,
    role: "office" | "trade" | "server" = "office",
    body?: Row,
    params = "",
  ) {
    const originalFetch = globalThis.fetch;
    const previousKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
    Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ ZZTEST: serverKey }));
    globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method || "GET";
      if (url.hostname !== "127.0.0.1") {
        throw new Error("ZZTEST forbids external fetch");
      }
      if (url.pathname === "/auth/v1/user") {
        return Promise.resolve(
          Response.json({
            id: role === "trade" ? tradeId : officeId,
            email: "",
            aud: "authenticated",
          }),
        );
      }
      if (url.pathname === "/rest/v1/users") {
        return Promise.resolve(
          Response.json({
            org_id: "00000000-0000-4000-8000-000000000001",
            role: role === "trade" ? "trade" : "ops_manager",
          }),
        );
      }
      if (url.pathname === "/rest/v1/trade_invoices") {
        return Promise.resolve(Response.json([]));
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        return Promise.resolve(Response.json(null));
      }
      if (url.pathname !== "/rest/v1/trade_rates") {
        throw new Error(`Unexpected ZZTEST path ${url.pathname}`);
      }
      const matches = (row: Row) =>
        [...url.searchParams].every(([key, value]) => {
          if (key === "user_id") return row.user_id === value.slice(3);
          if (key === "effective_to") return row.effective_to === null;
          if (key === "effective_from") {
            return value.startsWith("gt.")
              ? row.effective_from > value.slice(3)
              : row.effective_from <= value.slice(4);
          }
          return true;
        });
      if (method === "POST") {
        const row = {
          id: "ZZTEST-new",
          effective_to: null,
          created_at: "2031-01-01T00:00:00Z",
          ...JSON.parse(String(init?.body)),
        };
        rates.push(row);
        return Promise.resolve(Response.json(row, { status: 201 }));
      }
      if (method === "PATCH") {
        rates.filter(matches).forEach((row) =>
          Object.assign(row, JSON.parse(String(init?.body)))
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      rateReads++;
      if (failRead) {
        return Promise.resolve(
          Response.json({ message: "ZZTEST rate read failed" }, {
            status: 500,
          }),
        );
      }
      let rows = rates.filter(matches).sort((a, b) =>
        b.effective_from.localeCompare(a.effective_from)
      );
      const select = url.searchParams.get("select") || "";
      rows = rows.map((row) => ({
        ...row,
        ...(select.includes("users:")
          ? { users: { name: "ZZTEST trade" } }
          : {}),
        ...(select.includes("set_by:")
          ? {
            set_by: row.created_by
              ? {
                name: row.created_by === tradeId
                  ? "ZZTEST trade"
                  : "ZZTEST office",
              }
              : null,
          }
          : {}),
      }));
      if (
        (init?.headers as Record<string, string>)?.accept?.includes(
          "object+json",
        ) || select === "effective_from"
      ) {
        return Promise.resolve(Response.json(rows[0] || null));
      }
      return Promise.resolve(Response.json(rows));
    }) as typeof fetch;
    try {
      const response = await _opsApiRequestHandlerForTest(
        new Request(`http://127.0.0.1:9/ops-api?action=${action}${params}`, {
          method: body ? "POST" : "GET",
          headers: {
            ...(role === "server"
              ? { "x-api-key": serverKey }
              : { authorization: "Bearer ZZTEST-session" }),
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      return { status: response.status, body: await response.json() };
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKeys === undefined) Deno.env.delete("SUPABASE_SECRET_KEYS");
      else Deno.env.set("SUPABASE_SECRET_KEYS", previousKeys);
    }
  }
  return {
    rates,
    call,
    fail: () => {
      failRead = true;
    },
    recover: () => {
      failRead = false;
    },
    reads: () => rateReads,
  };
}

Deno.test("rate audit: office session is stored and both staff reads show the setter without rewriting old attribution", async () => {
  const s = fixture();
  const set = await s.call("set_trade_rate_ops", "office", {
    user_id: tradeId,
    hourly_rate: 41.25,
    actorUserId: tradeId,
  });
  assertEquals(set.status, 200);
  assertEquals(s.rates[1].created_by, officeId);
  assertEquals(s.rates[0].created_by, tradeId);
  const history = await s.call(
    "trade_rate_history",
    "office",
    undefined,
    `&user_id=${tradeId}`,
  );
  assertEquals(history.status, 200);
  assertEquals(
    history.body.rates.map((
      r: Row,
    ) => [r.user_id, r.trade_name, r.set_by_kind, r.set_by_name, r.set_at]),
    [
      [
        tradeId,
        "ZZTEST trade",
        "office",
        "ZZTEST office",
        "2031-01-01T00:00:00Z",
      ],
      [tradeId, "ZZTEST trade", "not_recorded", null, "2001-01-01T00:00:00Z"],
    ],
  );
  const current = await s.call("list_trade_invoices");
  assertEquals(current.status, 200);
  assertEquals(
    current.body.rates.map((
      r: Row,
    ) => [r.hourly_rate, r.effective_from, r.set_by_kind, r.set_by_name]),
    [
      [41.25, s.rates[1].effective_from, "office", "ZZTEST office"],
    ],
  );
  s.rates[1].created_by = null;
  const edited = await s.call("trade_rate_history");
  assertEquals([
    edited.body.rates[0].set_by_kind,
    edited.body.rates[0].set_by_name,
  ], ["not_recorded", null]);
  assertEquals(
    (await s.call(
      "trade_rate_history",
      "office",
      undefined,
      "&user_id=ZZTEST-missing",
    )).body.rates,
    [],
  );
});

Deno.test("rate audit: server key alone records no person", async () => {
  const s = fixture();
  const result = await s.call("set_trade_rate_ops", "server", {
    user_id: tradeId,
    hourly_rate: 41.25,
    actorUserId: officeId,
  });
  assertEquals(result.status, 200);
  assertEquals(s.rates[1].created_by, null);
});

Deno.test("rate audit: trade sign-in cannot set a rate or read office rate history", async () => {
  const s = fixture();
  const before = structuredClone(s.rates);
  for (
    const action of [
      "set_trade_rate",
      "set_trade_rate_ops",
      "trade_rate_history",
    ]
  ) {
    const response = await s.call(
      action,
      "trade",
      action.startsWith("set_")
        ? { user_id: tradeId, hourly_rate: 41.25 }
        : undefined,
    );
    assertEquals(response.status, 403, action);
  }
  assertEquals(s.rates, before);
  assertEquals(s.reads(), 0);
});

Deno.test("rate audit: history rejects a write method and reports an unreadable read as an error", async () => {
  const s = fixture();
  assertEquals((await s.call("trade_rate_history", "office", {})).status, 405);
  assertEquals(s.reads(), 0);
  s.fail();
  assertEquals((await s.call("trade_rate_history")).status, 500);
  assertEquals((await s.call("list_trade_invoices")).status, 500);
  s.recover();
  const retry = await s.call("trade_rate_history");
  assertEquals(retry.status, 200);
  assertEquals(retry.body.rates[0].set_by_kind, "not_recorded");
  assertEquals(s.rates.length, 1);
});
