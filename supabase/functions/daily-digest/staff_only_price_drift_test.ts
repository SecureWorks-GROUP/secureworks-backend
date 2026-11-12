/**
 * The daily digest's price drift section must never read a staff_only
 * scope_tool_defaults row (a staff policy such as the commission percentage)
 * as a material price (_shared/supplier_price_defaults.ts).
 *
 * Drives the real daily-digest request handler with every database call
 * answered by a fetch spy. The spy ignores PostgREST filters, so a staff_only
 * row reaches the comparison and must be skipped there too. All figures are
 * synthetic.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "OPS_AGENT_SERVER_KEY",
  "ANTHROPIC_API_KEY",
];
const BASE_ENV = {
  // A closed local port: anything the fetch spy does not answer fails loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = env[name];
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

type FetchCall = { url: URL; method: string; body: any };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const table = (url: URL) => url.pathname.split("/rest/v1/")[1];

// One staff policy row, one real material default, and one recent supplier
// price with no material code (which the matcher pairs with every default).
const COMMISSION_ROW = {
  scope_tool: "fence-designer",
  category: "staff_only",
  item_key: "commission-pct",
  item_description: "Commission percentage",
  material_code: null,
  unit: "%",
  default_price: 15,
  default_cost_rate: null,
};
const POST_ROW = {
  scope_tool: "fence-designer",
  category: "fencing_posts",
  item_key: "steel-post",
  item_description: "Steel fence post",
  material_code: null,
  unit: "each",
  default_price: 10,
  default_cost_rate: null,
};
const LEDGER_ROW = {
  supplier_name: "Supplier A",
  material_category: "fencing",
  material_code: "",
  item_description: "steel fence post",
  unit_price: 20,
  captured_at: new Date().toISOString(),
};

Deno.test("price drift never reads a staff_only row as a material price", async () => {
  const handle = await withEnv(
    BASE_ENV,
    async () => (await import("./index.ts"))._dailyDigestRequestHandlerForTest,
  );
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers).get("accept") ?? "";
    let body: any = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch { /* keep raw */ }
    }
    calls.push({ url, method, body });
    const one = accept.includes("vnd.pgrst.object");
    if (url.pathname.includes("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        return Promise.resolve(json(one ? null : [], 201));
      }
      let found: unknown[] = [];
      if (table(url) === "scope_tool_defaults") found = [COMMISSION_ROW, POST_ROW];
      if (table(url) === "material_price_ledger") found = [LEDGER_ROW];
      return Promise.resolve(json(one ? (found[0] ?? null) : found));
    }
    return Promise.resolve(json({ success: true, content: [] }));
  }) as typeof fetch;

  try {
    await withEnv(BASE_ENV, async () => {
      const res = await handle(
        new Request("https://example.invalid/daily-digest", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: "{}",
        }),
      );
      await res.body?.cancel();
    });
  } finally {
    globalThis.fetch = original;
  }

  // The read asks the database to leave staff_only rows out.
  const defaultsReads = calls.filter((c) =>
    c.method === "GET" && table(c.url) === "scope_tool_defaults"
  );
  assertEquals(defaultsReads.length, 1);
  const categoryFilter = defaultsReads[0].url.searchParams.get("category") ?? "";
  assert(categoryFilter.startsWith("not.in."), categoryFilter);
  assert(categoryFilter.includes("staff_only"), categoryFilter);

  const drift = calls
    .filter((c) => c.method === "POST" && table(c.url) === "ai_annotations")
    .flatMap((c) => Array.isArray(c.body) ? c.body : [c.body])
    .filter((row) => row?.annotation_type === "price_drift");
  // The staff policy row is never reported as a price drift ...
  assertEquals(
    drift.filter((row) => row.structured_data?.item_key === "commission-pct"),
    [],
  );
  // ... while a real material default still is.
  assertEquals(
    drift.map((row) => row.structured_data?.item_key),
    ["steel-post"],
  );
});
