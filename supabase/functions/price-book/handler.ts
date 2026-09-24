// Quote v2, stage 1: the price book read action. PROGRAM BRANCH ONLY.
//
// The one door every tool and the terminal use to read what materials cost
// us. Read-only: it never writes a price, a proposal or a decision.
//
//   GET  ?action=current[&item_keys=a,b][&family=patio]
//        Current cost per item: blessed, else strongest-evidence provisional,
//        else `unpriced` (never a silent $0). Stock lengths and cut rule ride
//        along. SQL: price_book_current_costs.
//   GET  ?action=markup&family=patio
//        Default markup for a family. SQL:
//        price_book_current_markup. A scoper's per-line override lives on the
//        quote line (quote_line_markup_overrides), read in a later stage.
//   GET  ?action=allowances[&family=patio]
//        Current job-family allowances (flashings by girth band per metre,
//        fixings per m2, sundries per job). SQL: price_book_current_allowances.
//   POST ?action=cut  {item_key, pieces:[{length_mm, qty}], stock_lengths_mm?, rule?}
//        Required lengths to order lengths plus waste, through the ONE shared
//        cut-to-order function, using the item's current stock lengths and cut
//        rule unless the caller states them. When the item is costed per
//        lineal metre the bought length is costed too.
//
// Who may read: cost prices are internal. Server callers (service role key or
// service-role JWT, or OPS_AGENT_SERVER_KEY) and signed-in staff, estimator
// and sales users. Trades, crew and the public SW_API_KEY are refused.
// Deploy with JWT verification ON: the service-role JWT check decodes the
// claim and relies on the gateway having verified the signature.
//
// Contract: docs/quote-v2/price-book-v1.md.

import { isServiceRoleJwt } from "../_shared/service_role_jwt.ts";
import {
  CUT_RULES,
  type CutRule,
  CutToOrderError,
  costCutPlanPerLm,
  cutToOrder,
} from "../_shared/price_book/cut_to_order.ts";

export const PRICE_BOOK_READ_ROLES = new Set([
  "admin",
  "owner",
  "ops_manager",
  "estimator",
  "sales",
]);

export const PRICE_BOOK_FAMILIES = new Set(["fencing", "patio", "stratco", "misc"]);

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface PriceBookDeps {
  env: (name: string) => string | undefined;
  /** Role of the signed-in user for this token, or null when not a user. */
  userRole: (token: string) => Promise<string | null>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  now?: () => Date;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function refuse(status: number, code: string, error: string): Response {
  return json({ ok: false, code, error }, status);
}

type AuthDecision =
  | { ok: true; caller: "server" | "user"; role: string | null }
  | { ok: false; response: Response };

export async function authorizePriceBookRead(
  req: Request,
  deps: PriceBookDeps,
): Promise<AuthDecision> {
  const shared = deps.env("SW_API_KEY") || null;
  const service = deps.env("SUPABASE_SERVICE_ROLE_KEY") || null;
  const agent = deps.env("OPS_AGENT_SERVER_KEY") || null;
  const xApiKey = req.headers.get("x-api-key");
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  const presents = (secret: string | null) =>
    !!secret && secret !== shared && (xApiKey === secret || bearer === secret);
  if (presents(service) || presents(agent) || (bearer && isServiceRoleJwt(bearer))) {
    return { ok: true, caller: "server", role: null };
  }
  if (!bearer || (shared && bearer === shared)) {
    return {
      ok: false,
      response: refuse(401, "user_jwt_required", "A signed-in session is required."),
    };
  }
  const role = await deps.userRole(bearer).catch(() => null);
  if (role === null) {
    return {
      ok: false,
      response: refuse(401, "user_jwt_required", "A signed-in session is required."),
    };
  }
  if (!PRICE_BOOK_READ_ROLES.has(role.toLowerCase())) {
    return {
      ok: false,
      response: refuse(403, "operator_access_required", "Cost prices are internal."),
    };
  }
  return { ok: true, caller: "user", role };
}

interface CurrentRow {
  item_key: string;
  status: "blessed" | "provisional" | "unpriced";
  unit: string;
  cost_ex_gst: number | string | null;
  stock_lengths_mm: number[] | null;
  cut_rule: CutRule | null;
  kerf_mm: number | string | null;
  [key: string]: unknown;
}

function parseKeys(raw: string | null): string[] | null {
  if (!raw) return null;
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  return keys.length ? [...new Set(keys)] : null;
}

async function currentRows(
  deps: PriceBookDeps,
  itemKeys: string[] | null,
  family: string | null,
): Promise<{ rows: CurrentRow[] } | { response: Response }> {
  const { data, error } = await deps.rpc("price_book_current_costs", {
    p_item_keys: itemKeys,
    p_family: family,
  });
  if (error) {
    return {
      response: refuse(502, "price_book_unreadable", "The price book could not be read."),
    };
  }
  return { rows: (Array.isArray(data) ? data : []) as CurrentRow[] };
}

async function actionCurrent(url: URL, deps: PriceBookDeps): Promise<Response> {
  const family = url.searchParams.get("family");
  if (family && !PRICE_BOOK_FAMILIES.has(family)) {
    return refuse(400, "family_unknown", "family must be fencing, patio, stratco or misc.");
  }
  const itemKeys = parseKeys(url.searchParams.get("item_keys"));
  const read = await currentRows(deps, itemKeys, family);
  if ("response" in read) return read.response;
  const counts = { blessed: 0, provisional: 0, unpriced: 0 };
  for (const row of read.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const found = new Set(read.rows.map((r) => r.item_key));
  return json({
    ok: true,
    read_at: (deps.now?.() ?? new Date()).toISOString(),
    counts,
    // Asked-for keys the price book does not know: never priced by guess.
    unknown_item_keys: (itemKeys ?? []).filter((k) => !found.has(k)),
    items: read.rows,
  });
}

async function actionMarkup(url: URL, deps: PriceBookDeps): Promise<Response> {
  const family = url.searchParams.get("family");
  if (!family || !PRICE_BOOK_FAMILIES.has(family)) {
    return refuse(400, "family_unknown", "family must be fencing, patio, stratco or misc.");
  }
  const { data, error } = await deps.rpc("price_book_current_markup", {
    p_family: family,
  });
  if (error) {
    return refuse(502, "price_book_unreadable", "The price book could not be read.");
  }
  const row = Array.isArray(data) ? data[0] ?? null : null;
  return json({
    ok: true,
    family,
    markup: row ?? { status: "unset", value: null },
  });
}

async function actionAllowances(url: URL, deps: PriceBookDeps): Promise<Response> {
  const family = url.searchParams.get("family");
  if (family && !PRICE_BOOK_FAMILIES.has(family)) {
    return refuse(400, "family_unknown", "family must be fencing, patio, stratco or misc.");
  }
  const { data, error } = await deps.rpc("price_book_current_allowances", { p_family: family });
  if (error) {
    return refuse(502, "price_book_unreadable", "The price book could not be read.");
  }
  return json({ ok: true, family, allowances: Array.isArray(data) ? data : [] });
}

async function actionCut(req: Request, deps: PriceBookDeps): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return refuse(400, "body_invalid", "Send a JSON body.");
  }
  const itemKey = typeof body.item_key === "string" ? body.item_key : "";
  if (!itemKey) return refuse(400, "item_key_missing", "item_key is required.");
  const read = await currentRows(deps, [itemKey], null);
  if ("response" in read) return read.response;
  const item = read.rows[0];
  if (!item) return refuse(404, "item_unknown", `No price book item ${itemKey}.`);

  const statedRule = body.rule as CutRule | undefined;
  if (statedRule !== undefined && !CUT_RULES.includes(statedRule)) {
    return refuse(400, "cut_rule_unknown", "rule must be one_per_stick, nest or cut_to_size.");
  }
  const rule = statedRule ?? item.cut_rule;
  if (!rule) {
    return refuse(409, "cut_rule_unknown_for_item", `${itemKey} has no cut rule; state one.`);
  }
  const stock = Array.isArray(body.stock_lengths_mm)
    ? body.stock_lengths_mm as number[]
    : item.stock_lengths_mm ?? undefined;
  if (rule !== "cut_to_size" && !stock?.length) {
    return refuse(
      409,
      "stock_lengths_unknown",
      `${itemKey} has no stock lengths recorded; state them or record them first.`,
    );
  }
  const kerf = item.kerf_mm == null ? undefined : Number(item.kerf_mm);

  try {
    const plan = cutToOrder({
      rule,
      pieces: body.pieces as { length_mm: number; qty: number }[],
      stock_lengths_mm: stock,
      kerf_mm: kerf,
    });
    const costPerLm = item.unit === "lm" && item.cost_ex_gst != null
      ? Number(item.cost_ex_gst)
      : null;
    return json({
      ok: true,
      item_key: itemKey,
      price_status: item.status,
      stock_lengths_source: Array.isArray(body.stock_lengths_mm) ? "caller" : "price_book",
      rule_source: statedRule ? "caller" : "price_book",
      plan,
      cost: costPerLm ? { per_lm_ex_gst: costPerLm, ...costCutPlanPerLm(plan, costPerLm) } : null,
    });
  } catch (e) {
    if (e instanceof CutToOrderError) return refuse(400, e.code, e.message);
    throw e;
  }
}

export async function handlePriceBookRequest(
  req: Request,
  deps: PriceBookDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const auth = await authorizePriceBookRead(req, deps);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  try {
    if (action === "current" && req.method === "GET") return await actionCurrent(url, deps);
    if (action === "markup" && req.method === "GET") return await actionMarkup(url, deps);
    if (action === "allowances" && req.method === "GET") return await actionAllowances(url, deps);
    if (action === "cut" && req.method === "POST") return await actionCut(req, deps);
    return refuse(400, "action_unknown", "Use GET current, GET markup, GET allowances or POST cut.");
  } catch (_) {
    return refuse(500, "price_book_error", "The price book read failed.");
  }
}
