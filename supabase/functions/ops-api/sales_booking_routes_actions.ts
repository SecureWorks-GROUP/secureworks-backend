/** The owner's booking-routes door: read the rules, change one.
 *
 *  - `GET sales_booking_routes_read`: every rule in read order (disabled ones
 *    too), the people a rule may name, the trades and lead sources it may
 *    match, and the latest changes. Reads only.
 *  - `POST sales_booking_routes_write`: one change, `op` create | update |
 *    delete. Only the owner's signed session may change a rule (the same
 *    gate as an owner approval, `assertSalesBookingStampWriteAuth`); the
 *    database function writes the rule and its audit row (who, when, before,
 *    after, why) in one transaction and refuses an edit made against a stale
 *    read. `dry_run: true` checks the change and shows the resulting order
 *    without writing; a desk API key may run one.
 * Contract: docs/sales-booking-routes.md. Matching:
 * sales_booking_routes.ts.
 */
import {
  assertSalesBookingStampWriteAuth,
  type SalesBookingEnvGet,
  type SalesBookingPackAuth,
} from "./sales_booking_pack.ts";
import {
  loadSalesBookingRoutes,
  orderedSalesBookingRoutes,
  SALES_BOOKING_PIPELINE_TRADES,
  SALES_BOOKING_ROUTE_ID_RE,
  type SalesBookingRoute,
  validateSalesBookingRouteInput,
} from "./sales_booking_routes.ts";
import { SALES_BOOKING_SENDER_LINES } from "./sales_booking_sender.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

export class SalesBookingRoutesError extends Error {
  constructor(
    readonly reason: string,
    readonly status = 409,
    readonly detail: Obj | null = null,
  ) {
    super(reason);
    this.name = "SalesBookingRoutesError";
  }
}
function refuse(
  reason: string,
  status = 409,
  detail: Obj | null = null,
): never {
  throw new SalesBookingRoutesError(reason, status, detail);
}

export interface SalesBookingRouteChange {
  id: number;
  changed_at: string;
  route_id: string;
  op: string;
  before: Obj | null;
  after: Obj | null;
  changed_by_email: string;
  reason: string | null;
}

export interface SalesBookingRoutesDeps {
  /** Every stored rule; throws when unreadable or malformed. */
  loadRoutes(): Promise<SalesBookingRoute[]>;
  /** Latest changes, newest first; throws when unreadable. */
  loadChanges(limit: number): Promise<SalesBookingRouteChange[]>;
  /** `sales_booking_route_write`; throws `Error(<db message>)` on refusal. */
  writeRoute(args: {
    op: "create" | "update" | "delete";
    route_id: string;
    route: Obj | null;
    expected_updated_at: string | null;
    actor_user_id: string;
    actor_email: string;
    reason: string | null;
  }): Promise<Obj>;
  envGet?: SalesBookingEnvGet;
}

export const SALES_BOOKING_ROUTES_HOW =
  "Rules are read top to bottom; the first switched-on rule that fits a lead " +
  "decides who books it and which GHL calendar the visit goes into. A rule " +
  "fits when every filter it sets matches: trade (fencing or patio), lead " +
  "source (Stratco or normal), one GHL tag, one GHL pipeline. A lead " +
  "assigned to someone in GHL stays theirs and books into their first rule " +
  "for that trade. A lead no rule fits is shown but cannot be booked.";

function people() {
  return Object.values(SALES_BOOKING_SENDER_LINES).map((p) => ({
    person: p.person,
    name: p.name,
    line: p.line,
  }));
}

/** GET sales_booking_routes_read. */
export async function salesBookingRoutesReadAction(args: {
  method: string;
  deps: SalesBookingRoutesDeps;
}): Promise<Obj> {
  if (args.method !== "GET") {
    refuse("sales_booking_routes_read requires GET", 405);
  }
  let routes: SalesBookingRoute[];
  let changes: SalesBookingRouteChange[];
  try {
    [routes, changes] = await Promise.all([
      args.deps.loadRoutes(),
      args.deps.loadChanges(50),
    ]);
  } catch {
    refuse("booking_routes_unreadable", 503);
  }
  return {
    ok: true,
    how_it_works: SALES_BOOKING_ROUTES_HOW,
    routes,
    read_order: orderedSalesBookingRoutes(routes).map((r) => r.id),
    choices: {
      people: people(),
      match_trade: ["fencing", "patio"],
      match_lead_source: ["stratco", "normal"],
      pipelines: { ...SALES_BOOKING_PIPELINE_TRADES },
    },
    changes,
  };
}

const OPS = new Set(["create", "update", "delete"]);
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

/** POST sales_booking_routes_write. */
export async function salesBookingRoutesWriteAction(args: {
  method: string;
  auth: SalesBookingPackAuth;
  body: Obj;
  deps: SalesBookingRoutesDeps;
}): Promise<Obj> {
  const { body, deps } = args;
  if (args.method !== "POST") {
    refuse("sales_booking_routes_write requires POST", 405);
  }
  if ("dry_run" in body && typeof body.dry_run !== "boolean") {
    refuse("invalid_dry_run", 400);
  }
  const dryRun = body.dry_run === true;
  // A preview writes nothing, so a desk API key may run one. A change is the
  // owner's signed session only, exactly as an owner approval.
  let email = "ops-api:api_key";
  if (!(dryRun && args.auth.mode === "api_key")) {
    email = assertSalesBookingStampWriteAuth(args.auth, deps.envGet);
    if (!args.auth.userId) refuse("route_actor_required", 403);
  }
  const op = body.op;
  if (typeof op !== "string" || !OPS.has(op)) refuse("route_op_invalid", 400);
  const routeId = text(body.route_id);
  let route: SalesBookingRoute | null = null;
  if (op !== "delete") {
    const checked = validateSalesBookingRouteInput(routeId, body.route);
    if (!checked.ok) {
      refuse(checked.reason, 400, { field: checked.field });
    }
    route = checked.route;
  } else if (!SALES_BOOKING_ROUTE_ID_RE.test(routeId)) {
    refuse("route_field_invalid", 400, { field: "id" });
  }
  const expected = body.expected_updated_at;
  if (op !== "create" && (typeof expected !== "string" || !expected)) {
    refuse("route_expected_updated_at_required", 400);
  }
  const reason = body.reason == null ? null : text(body.reason) || null;
  if (reason && reason.length > 1000) refuse("route_reason_too_long", 400);

  let current: SalesBookingRoute[];
  try {
    current = await deps.loadRoutes();
  } catch {
    refuse("booking_routes_unreadable", 503);
  }
  const before = current.find((r) => r.id === routeId) ?? null;
  if (op === "create" && before) refuse("route_exists");
  if (op !== "create" && !before) refuse("route_not_found", 404);
  const next = current.filter((r) => r.id !== routeId);
  if (route) next.push(route);
  const preview = {
    op,
    route_id: routeId,
    before,
    after: route,
    read_order: orderedSalesBookingRoutes(next).map((r) => r.id),
  };
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      ...preview,
      // A live write refuses an edit made against an older read.
      stale: op !== "create" && before?.updated_at != null &&
        Date.parse(before.updated_at) !== Date.parse(String(expected)),
    };
  }
  let change: Obj;
  try {
    change = await deps.writeRoute({
      op: op as "create" | "update" | "delete",
      route_id: routeId,
      route: route
        ? {
          position: route.position,
          enabled: route.enabled,
          label: route.label,
          match_trade: route.match_trade,
          match_lead_source: route.match_lead_source,
          match_tag: route.match_tag,
          match_pipeline_id: route.match_pipeline_id,
          person: route.person,
          calendar_id: route.calendar_id,
          calendar_name: route.calendar_name,
        }
        : null,
      expected_updated_at: op === "create" ? null : String(expected),
      actor_user_id: args.auth.userId!,
      actor_email: email,
      reason,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? "");
    for (
      const [code, status] of [
        ["route_changed_since_read", 409],
        ["route_exists", 409],
        ["route_not_found", 404],
      ] as const
    ) if (message.includes(code)) refuse(code, status);
    refuse("booking_route_write_failed", 503);
  }
  let routes: SalesBookingRoute[] | null = null;
  try {
    routes = await deps.loadRoutes();
  } catch {
    routes = null; // the change stands; the screen re-reads.
  }
  return {
    ok: true,
    dry_run: false,
    change,
    routes,
    read_order: routes
      ? orderedSalesBookingRoutes(routes).map((r) => r.id)
      : null,
  };
}

// deno-lint-ignore no-explicit-any
type Client = { from(table: string): any; rpc(fn: string, args: Obj): any };

export function createSalesBookingRoutesDeps(
  client: Client,
): SalesBookingRoutesDeps {
  return {
    loadRoutes: () => loadSalesBookingRoutes(client),
    async loadChanges(limit) {
      const { data, error } = await client.from("sales_booking_route_changes")
        .select(
          "id,changed_at,route_id,op,before,after,changed_by_email,reason",
        )
        .order("id", { ascending: false }).limit(limit);
      if (error || !Array.isArray(data)) {
        throw new Error("booking_route_changes_unreadable");
      }
      return data;
    },
    async writeRoute(a) {
      const { data, error } = await client.rpc("sales_booking_route_write", {
        p_op: a.op,
        p_route_id: a.route_id,
        p_route: a.route,
        p_expected_updated_at: a.expected_updated_at,
        p_actor_user_id: a.actor_user_id,
        p_actor_email: a.actor_email,
        p_reason: a.reason,
      });
      if (error) throw new Error(String(error.message ?? "write_failed"));
      if (!data || typeof data !== "object") throw new Error("write_failed");
      return data;
    },
  };
}
