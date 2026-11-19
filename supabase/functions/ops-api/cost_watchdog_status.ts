// Read-only cost-watchdog status, and an acknowledgement that does not
// turn any switch back on.
//
// GET  ops-api?action=cost_watchdog_status
// POST ops-api?action=ack_cost_watchdog_trip   { trip_id, note? }
//
// Owner, admin, and ops_manager only. A trade session and a caller with no
// session are refused 403. The status read writes nothing. Acknowledging a
// trip stamps who saw it. It does not update feature_flags or a timer.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, apikey, x-client-info",
};

const STAFF = new Set(["admin", "owner", "ops_manager"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACK_KEYS = new Set(["trip_id", "note"]);
const NOTE_MAX = 500;

export const COST_WATCHDOG_SWITCH_KEYS = [
  "job_profit_refresh_v1",
  "reconcile_matcher_v1",
  "job-pages-refresh",
] as const;

export const COST_WATCHDOG_RECENT_LIMIT = 25;

const TRIP_COLUMNS = [
  "id",
  "org_id",
  "watchdog_name",
  "switch_key",
  "previous_value",
  "new_value",
  "metric_name",
  "metric_value",
  "threshold",
  "reason",
  "tripped_at",
  "acknowledged_at",
  "acknowledged_by",
  "ack_note",
].join(",");

export type CostWatchdogAuthMode =
  | "api_key"
  | "jwt"
  | "routine"
  | "agent_read"
  | "none";

export interface CostWatchdogActor {
  id?: string | null;
  role?: unknown;
}

interface SwitchRow {
  key?: unknown;
  enabled?: unknown;
  updated_at?: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function costWatchdogStaff(
  authMode: CostWatchdogAuthMode,
  actor: CostWatchdogActor | null | undefined,
): boolean {
  if (authMode !== "jwt" || !actor?.id || !UUID.test(actor.id)) return false;
  return STAFF.has(String(actor.role ?? "").toLowerCase());
}

function refused(): Response {
  return json({
    error: "An authorised operator session is required.",
    code: "operator_access_required",
  }, 403);
}

function switchesFrom(rows: SwitchRow[]): Array<{
  key: string;
  enabled: boolean | null;
  updated_at: string | null;
}> {
  const byKey = new Map<string, SwitchRow>();
  for (const row of rows) {
    const key = typeof row?.key === "string" ? row.key : "";
    if (key) byKey.set(key, row);
  }
  return [...COST_WATCHDOG_SWITCH_KEYS].sort().map((key) => {
    const row = byKey.get(key);
    const enabled = row?.enabled;
    return {
      key,
      enabled: typeof enabled === "boolean" ? enabled : null,
      updated_at: typeof row?.updated_at === "string" ? row.updated_at : null,
    };
  });
}

export async function costWatchdogStatusAction(
  // deno-lint-ignore no-explicit-any
  client: any,
  method: string,
  authMode: CostWatchdogAuthMode,
  actor: CostWatchdogActor | null | undefined,
): Promise<Response> {
  if (!costWatchdogStaff(authMode, actor)) return refused();
  if (method !== "GET") {
    return json({ error: "cost_watchdog_status requires GET" }, 405);
  }
  const [switches, trips, unacked] = await Promise.all([
    client.rpc("cost_watchdog_switches"),
    client.from("cost_watchdog_trips")
      .select(TRIP_COLUMNS)
      .order("tripped_at", { ascending: false })
      .limit(COST_WATCHDOG_RECENT_LIMIT),
    client.from("cost_watchdog_trips")
      .select("id", { count: "exact", head: true })
      .is("acknowledged_at", null),
  ]);
  if (switches?.error || trips?.error || unacked?.error ||
    typeof unacked?.count !== "number" || !Array.isArray(trips?.data)
  ) {
    return json({
      error: "cost watchdog status could not be read",
      code: "cost_watchdog_status_unreadable",
    }, 503);
  }
  const switchRows = Array.isArray(switches.data) ? switches.data : [];
  return json({
    switches: switchesFrom(switchRows),
    unacknowledged_trips_count: unacked.count,
    recent_trips: trips.data.slice(0, COST_WATCHDOG_RECENT_LIMIT),
  });
}

export async function ackCostWatchdogTripAction(
  // deno-lint-ignore no-explicit-any
  client: any,
  method: string,
  authMode: CostWatchdogAuthMode,
  actor: CostWatchdogActor | null | undefined,
  body: unknown,
): Promise<Response> {
  if (!costWatchdogStaff(authMode, actor)) return refused();
  if (method !== "POST") {
    return json({ error: "ack_cost_watchdog_trip requires POST" }, 405);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "A JSON object body is required.", code: "cost_watchdog_ack_invalid" }, 400);
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ACK_KEYS.has(key));
  if (unknown.length) {
    return json({
      error: `Unknown field: ${unknown.sort().join(", ")}.`,
      code: "cost_watchdog_ack_invalid",
    }, 400);
  }
  const tripId = typeof record.trip_id === "string" ? record.trip_id.trim() : "";
  if (!UUID.test(tripId)) {
    return json({ error: "trip_id must be a uuid.", code: "cost_watchdog_ack_invalid" }, 400);
  }
  let note: string | null = null;
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== "string") {
      return json({ error: "note must be text.", code: "cost_watchdog_ack_invalid" }, 400);
    }
    note = record.note.trim();
    if (note.length > NOTE_MAX) {
      return json({ error: "note is too long.", code: "cost_watchdog_ack_invalid" }, 400);
    }
    if (!note) note = null;
  }

  const existing = await client.from("cost_watchdog_trips")
    .select(TRIP_COLUMNS)
    .eq("id", tripId)
    .maybeSingle();
  if (existing?.error) {
    return json({
      error: "cost watchdog trip could not be read",
      code: "cost_watchdog_ack_unreadable",
    }, 503);
  }
  if (!existing?.data) {
    return json({
      error: "cost watchdog trip not found",
      code: "cost_watchdog_trip_not_found",
    }, 404);
  }
  if (existing.data.acknowledged_at) {
    return json({ trip: existing.data, already_acknowledged: true });
  }

  const acknowledgedAt = new Date().toISOString();
  const updated = await client.from("cost_watchdog_trips")
    .update({
      acknowledged_at: acknowledgedAt,
      acknowledged_by: actor!.id,
      ack_note: note,
    })
    .eq("id", tripId)
    .is("acknowledged_at", null)
    .select(TRIP_COLUMNS)
    .maybeSingle();
  if (updated?.error) {
    return json({
      error: "cost watchdog trip could not be acknowledged",
      code: "cost_watchdog_ack_failed",
    }, 503);
  }
  if (!updated?.data) {
    const again = await client.from("cost_watchdog_trips")
      .select(TRIP_COLUMNS)
      .eq("id", tripId)
      .maybeSingle();
    if (again?.data?.acknowledged_at) {
      return json({ trip: again.data, already_acknowledged: true });
    }
    return json({
      error: "cost watchdog trip not found",
      code: "cost_watchdog_trip_not_found",
    }, 404);
  }
  return json({ trip: updated.data, already_acknowledged: false });
}
