/**
 * Isolated registered ops-api for Booking review.
 * Authenticated staff actor + org_id. SQL on booking_test. No live send/calendar.
 */
import { dispatch, SalesBookingError, type Adapters, type BookingActor } from "./sales_booking.ts";
import { createPsqlBookingDb } from "./sales_booking_pg.ts";

const PORT = Number(Deno.env.get("BOOKING_API_PORT") || 4176);
const TOKEN = Deno.env.get("BOOKING_REVIEW_BEARER") || "booking-isolated-review";
const ACTOR: BookingActor = {
  org_id: Deno.env.get("BOOKING_ORG_ID") || "00000000-0000-0000-0000-000000000001",
  user_id: Deno.env.get("BOOKING_ACTOR_ID") || "00000000-0000-0000-0000-000000000002",
  role: "ops_manager",
};

const MCP = Deno.env.get("SW_MCP") || `${Deno.env.get("HOME")}/.local/bin/sw-mcp`;

async function mcpCall(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dir = await Deno.makeTempDir({ prefix: "booking-mcp-" });
  const argsFile = `${dir}/args.json`;
  const outFile = `${dir}/out.json`;
  await Deno.writeTextFile(argsFile, JSON.stringify(args));
  const cmd = new Deno.Command(MCP, {
    args: ["call", tool, "--args-file", argsFile, "--out", outFile],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr) || `mcp ${tool} exit ${out.code}`);
  }
  const parsed = JSON.parse(await Deno.readTextFile(outFile));
  if (parsed.result?.content?.[0]?.text) return JSON.parse(parsed.result.content[0].text);
  return parsed.result || parsed;
}

const adapters: Adapters = {
  listOpportunities: async () => ({ items: [], next: null, complete: false }),
  calendarEvents: async (scoperUserId, since, until) => {
    const raw = await mcpCall("sw_scoper_calendar_events", {
      scoper_user_id: scoperUserId,
      since,
      until,
      timezone: "Australia/Perth",
    });
    return {
      ok: raw.ok !== false,
      mailbox: raw.mailbox,
      retrieved_at: raw.retrieved_at || new Date().toISOString(),
      coverage: raw.coverage || { operational_leave: "not_read" },
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  },
  coverageForResource: async () => ({
    leave_intervals: null,
    travel_minutes: null,
    calendar_retrieved_at: new Date().toISOString(),
    leave_retrieved_at: null,
    travel_retrieved_at: null,
  }),
};

function actorFrom(req: Request): BookingActor | null {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== TOKEN) return null;
  return ACTOR;
}

const db = createPsqlBookingDb();

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

Deno.serve({ hostname: "127.0.0.1", port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({
      ok: true,
      entry: "ops-api",
      actions: ["sales_booking_assess", "sales_booking_draft", "sales_booking_read"],
      org_id: ACTOR.org_id,
      sql: "booking_test",
      send: "held",
    }, { headers: cors });
  }
  const action = url.searchParams.get("action") || "";
  if (!action.startsWith("sales_booking_")) {
    return Response.json({ ok: false, error: "unknown action" }, { status: 404, headers: cors });
  }
  const actor = actorFrom(req);
  if (!actor) return Response.json({ ok: false, error: "operator_required", code: "operator_required" }, { status: 401, headers: cors });
  let body: Record<string, unknown> = {};
  if (req.method !== "GET") {
    try { body = await req.json(); } catch { body = {}; }
  }
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { if (k !== "action") params[k] = v; });
  try {
    const out = await dispatch(action, params, body, adapters, db, req.method, actor);
    return Response.json({ ...out, actor_org_id: actor.org_id, actor_id: actor.user_id, actor_role: actor.role }, { headers: cors });
  } catch (e) {
    const err = e as SalesBookingError;
    const status = err.status || 500;
    return Response.json({ ok: false, error: err.message, code: err.code || "error" }, { status, headers: cors });
  }
});

console.log("Booking ops-api http://127.0.0.1:" + PORT + "/?action=sales_booking_assess");
