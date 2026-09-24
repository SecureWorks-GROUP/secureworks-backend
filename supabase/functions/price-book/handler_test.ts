// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handlePriceBookRequest, type PriceBookDeps } from "./handler.ts";

const ENV: Record<string, string> = {
  SW_API_KEY: "public-shared-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  OPS_AGENT_SERVER_KEY: "agent-secret",
};

const ROWS = [
  {
    item_key: "steel-rhs-100x50x2",
    family: "patio",
    category: "steel",
    description: "100x50x2 RHS",
    unit: "lm",
    status: "provisional",
    cost_ex_gst: "26.5734",
    stock_lengths_mm: [5500, 6500, 8000],
    cut_rule: "one_per_stick",
    kerf_mm: "3.00",
  },
  {
    item_key: "flashing-custom",
    family: "patio",
    category: "flashing",
    description: "Custom flashing",
    unit: "lm",
    status: "unpriced",
    cost_ex_gst: null,
    stock_lengths_mm: null,
    cut_rule: null,
    kerf_mm: null,
  },
];

function deps(over: Partial<PriceBookDeps> = {}): PriceBookDeps & {
  calls: { fn: string; args: Record<string, unknown> }[];
} {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    env: (n) => ENV[n],
    userRole: (token) =>
      Promise.resolve(
        token === "jwt-estimator" ? "estimator" : token === "jwt-trade" ? "trade" : null,
      ),
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "price_book_current_costs") {
        const keys = args.p_item_keys as string[] | null;
        return Promise.resolve({
          data: ROWS.filter((r) => !keys || keys.includes(r.item_key)),
          error: null,
        });
      }
      if (fn === "price_book_current_markup") {
        return Promise.resolve({
          data: [{ family: "patio", value: 1.35, status: "provisional" }],
          error: null,
        });
      }
      if (fn === "price_book_current_allowances") {
        return Promise.resolve({
          data: [{ family: "patio", allowance_key: "flashing", basis: "per_lm_by_girth_band", girth_min_mm: 0, girth_max_mm: 100, cost_ex_gst: "5.4148" }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: "unknown" } });
    },
    now: () => new Date("2026-09-24T05:00:00Z"),
    ...over,
  };
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://x.test/price-book${path}`, { headers });
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return new Request(`https://x.test/price-book${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SERVER = { "x-api-key": "service-secret" };

Deno.test("no credentials, the public shared key, or no user session: 401", async () => {
  const cases: Record<string, string>[] = [
    {},
    { "x-api-key": "public-shared-key" },
    { authorization: "Bearer public-shared-key" },
    { authorization: "Bearer not-a-user" },
  ];
  for (const headers of cases) {
    const res = await handlePriceBookRequest(get("?action=current", headers), deps());
    assertEquals(res.status, 401);
    assertEquals((await res.json()).code, "user_jwt_required");
  }
});

Deno.test("a trade session is refused: cost prices are internal", async () => {
  const d = deps();
  const res = await handlePriceBookRequest(
    get("?action=current", { authorization: "Bearer jwt-trade" }),
    d,
  );
  assertEquals(res.status, 403);
  assertEquals((await res.json()).code, "operator_access_required");
  assertEquals(d.calls.length, 0);
});

Deno.test("server secrets and an estimator session may read", async () => {
  const cases: Record<string, string>[] = [
    SERVER,
    { authorization: "Bearer agent-secret" },
    { authorization: "Bearer jwt-estimator" },
  ];
  for (const headers of cases) {
    const res = await handlePriceBookRequest(get("?action=current", headers), deps());
    assertEquals(res.status, 200);
  }
});

Deno.test("current: counts by status and names unknown keys instead of guessing", async () => {
  const d = deps();
  const res = await handlePriceBookRequest(
    get("?action=current&item_keys=steel-rhs-100x50x2,flashing-custom,nope", SERVER),
    d,
  );
  const body = await res.json();
  assertEquals(body.counts, { blessed: 0, provisional: 1, unpriced: 1 });
  assertEquals(body.unknown_item_keys, ["nope"]);
  assertEquals(body.items.length, 2);
  assertEquals(d.calls[0].args, {
    p_item_keys: ["steel-rhs-100x50x2", "flashing-custom", "nope"],
    p_family: null,
  });
  assertEquals(body.read_at, "2026-09-24T05:00:00.000Z");
});

Deno.test("current: an unreadable price book is a 502, never an empty list", async () => {
  const res = await handlePriceBookRequest(
    get("?action=current", SERVER),
    deps({ rpc: () => Promise.resolve({ data: null, error: { message: "down" } }) }),
  );
  assertEquals(res.status, 502);
  assertEquals((await res.json()).code, "price_book_unreadable");
});

Deno.test("current and markup refuse an unknown family", async () => {
  for (const path of ["?action=current&family=decking", "?action=markup&family=decking", "?action=markup"]) {
    const res = await handlePriceBookRequest(get(path, SERVER), deps());
    assertEquals(res.status, 400);
  }
});

Deno.test("markup: returns the family default", async () => {
  const d = deps();
  const res = await handlePriceBookRequest(get("?action=markup&family=patio", SERVER), d);
  const body = await res.json();
  assertEquals(body.markup.value, 1.35);
  assertEquals(d.calls[0].args, { p_family: "patio" });
});

Deno.test("allowances: returns the current rows for a family", async () => {
  const d = deps();
  const res = await handlePriceBookRequest(get("?action=allowances&family=patio", SERVER), d);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.allowances[0].allowance_key, "flashing");
  assertEquals(d.calls[0], { fn: "price_book_current_allowances", args: { p_family: "patio" } });
});

Deno.test("cut: 6 m of 100x50 buys one 6.5 m length from the item's stock list", async () => {
  const res = await handlePriceBookRequest(
    post("?action=cut", { item_key: "steel-rhs-100x50x2", pieces: [{ length_mm: 6000, qty: 1 }] }, SERVER),
    deps(),
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.plan.order, [{ length_mm: 6500, qty: 1, special_order: false }]);
  assertEquals(body.stock_lengths_source, "price_book");
  assertEquals(body.rule_source, "price_book");
  assertEquals(body.cost.per_lm_ex_gst, 26.5734);
  assertEquals(body.cost.waste_ex_gst, 13.29);
});

Deno.test("cut: no stock lengths and no rule recorded is a 409, not a guess", async () => {
  let res = await handlePriceBookRequest(
    post("?action=cut", { item_key: "flashing-custom", pieces: [{ length_mm: 100, qty: 1 }] }, SERVER),
    deps(),
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "cut_rule_unknown_for_item");
  res = await handlePriceBookRequest(
    post("?action=cut", { item_key: "flashing-custom", rule: "nest", pieces: [{ length_mm: 100, qty: 1 }] }, SERVER),
    deps(),
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, "stock_lengths_unknown");
  res = await handlePriceBookRequest(
    post("?action=cut", { item_key: "flashing-custom", rule: "cut_to_size", pieces: [{ length_mm: 7500, qty: 2 }] }, SERVER),
    deps(),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).plan.waste_mm, 0);
});

Deno.test("cut: bad pieces, unknown rule and unknown item refuse with a code", async () => {
  const cases: [unknown, number, string][] = [
    [{ item_key: "steel-rhs-100x50x2", pieces: [{ length_mm: -1, qty: 1 }] }, 400, "cut_piece_invalid"],
    [{ item_key: "steel-rhs-100x50x2", rule: "guess", pieces: [{ length_mm: 1, qty: 1 }] }, 400, "cut_rule_unknown"],
    [{ item_key: "nope", pieces: [{ length_mm: 1, qty: 1 }] }, 404, "item_unknown"],
    [{ pieces: [] }, 400, "item_key_missing"],
  ];
  for (const [body, status, code] of cases) {
    const res = await handlePriceBookRequest(post("?action=cut", body, SERVER), deps());
    assertEquals(res.status, status);
    assertEquals((await res.json()).code, code);
  }
});

Deno.test("the read action has no write verbs", async () => {
  for (const [method, path] of [["POST", "?action=current"], ["GET", "?action=cut"], ["POST", "?action=propose"]]) {
    const res = await handlePriceBookRequest(
      new Request(`https://x.test/price-book${path}`, { method, headers: SERVER, body: method === "POST" ? "{}" : undefined }),
      deps(),
    );
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, "action_unknown");
  }
});
