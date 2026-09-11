/** Storage boundary only: collectors own definitions, evidence and missing values. */
export type JsonObject = Record<string, unknown>;
export interface PerformanceRow {
  org_id: string;
  week_start: string;
  lane: string;
  metrics: JsonObject;
  coverage: JsonObject;
  queues: JsonObject;
  notes: JsonObject | null;
  run_id: string;
  definition_version: string;
  computed_at: string;
}
export interface PerformanceStore {
  write(row: Omit<PerformanceRow, "notes">): Promise<PerformanceRow>;
  note(week: string, lane: string, text: string): Promise<PerformanceRow>;
  read(org: string, from: string, through: string): Promise<PerformanceRow[]>;
  weeks(org: string): Promise<string[]>;
}
export interface PerformanceCaller {
  mode: string;
  serviceRole: boolean;
  staff: boolean;
  orgId?: string;
  userId?: string;
}
export class PerformanceError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new PerformanceError(400, code);
};
function object(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`invalid_${key}`);
  }
  return value as JsonObject;
}
function text(value: unknown, key: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(`invalid_${key}`);
  }
  return value as string;
}
export function monday(value: unknown): string {
  const week = text(value, "week_start", 10);
  const date = new Date(`${week}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== week || date.getUTCDay() !== 1
  ) fail("invalid_week_start");
  return week;
}
function lane(value: unknown): string {
  if (value !== "patio" && value !== "fencing") fail("invalid_lane");
  return value as string;
}
function shift(week: string, days: number): string {
  return new Date(Date.parse(`${week}T00:00:00Z`) + days * 86400000)
    .toISOString().slice(0, 10);
}
export function latestClosedWeek(now: Date): string {
  const perth = new Date(now.getTime() + 8 * 3600000);
  return shift(
    perth.toISOString().slice(0, 10),
    -((perth.getUTCDay() + 6) % 7) - 7,
  );
}
function only(body: JsonObject, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    fail("unexpected_field");
  }
}
export async function salesPerformanceAction(
  store: PerformanceStore,
  action: string,
  method: string,
  params: URLSearchParams,
  input: unknown,
  caller: PerformanceCaller,
  now = new Date(),
): Promise<{ status: number; body: JsonObject }> {
  try {
    if (action === "sales_performance_write") {
      if (caller.mode !== "api_key" || !caller.serviceRole) {
        throw new PerformanceError(403, "service_role_required");
      }
    } else if (caller.mode !== "jwt" || !caller.userId) {
      throw new PerformanceError(401, "user_jwt_required");
    } else if (!caller.staff || !caller.orgId) {
      throw new PerformanceError(403, "operator_access_required");
    }
    const read = action === "sales_performance_read";
    if (method !== (read ? "GET" : "POST")) {
      throw new PerformanceError(405, "method_not_allowed");
    }
    if (read) {
      if (params.has("org_id") || params.has("lane")) fail("unexpected_scope");
      const closed = latestClosedWeek(now);
      const requested = params.has("week_start")
        ? monday(params.get("week_start"))
        : null;
      const available = await store.weeks(caller.orgId!);
      const latestStoredClosed = available.filter((value) =>
        value <= closed
      ).sort().reverse()[0] ?? null;
      const week = requested ?? latestStoredClosed ?? closed;
      const weeks = [0, 1, 2, 3].map((i) => shift(week, -7 * i));
      const rows = await store.read(caller.orgId!, weeks[3], week);
      return {
        status: 200,
        body: {
          rows,
          week_start: week,
          week_starts: weeks,
          latest_closed_week: closed,
          latest_stored_closed_week: latestStoredClosed,
          missing_latest_closed_week: !available.includes(closed),
          available_weeks: available,
          available_weeks_limit: 104,
          fetched_at: now.toISOString(),
        },
      };
    }
    const body = object(input, "body");
    const week = monday(body.week_start);
    const reportLane = lane(body.lane);
    if (action === "sales_performance_note") {
      only(body, ["week_start", "lane", "note"]);
      if (typeof body.note !== "string" || body.note.length > 10000) {
        fail("invalid_note");
      }
      const row = await store.note(week, reportLane, body.note as string);
      return { status: 200, body: { row } };
    }
    if (action !== "sales_performance_write") fail("unknown_action");
    only(body, [
      "org_id",
      "week_start",
      "lane",
      "metrics",
      "coverage",
      "queues",
      "run_id",
      "definition_version",
      "computed_at",
    ]);
    const org = text(body.org_id, "org_id");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        org,
      )
    ) fail("invalid_org_id");
    const coverage = object(body.coverage, "coverage");
    if (!Array.isArray(coverage.gaps)) fail("invalid_coverage_gaps");
    if (coverage.collection_complete !== true) fail("collection_incomplete");
    const computed = text(body.computed_at, "computed_at", 50);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        computed,
      ) ||
      !Number.isFinite(Date.parse(computed)) ||
      new Date(`${computed.slice(0, 10)}T00:00:00Z`).toISOString().slice(
          0,
          10,
        ) !== computed.slice(0, 10) ||
      Number(computed.slice(11, 13)) > 23 ||
      Date.parse(computed) > now.getTime()
    ) fail("invalid_computed_at");
    const row = await store.write({
      org_id: org,
      week_start: week,
      lane: reportLane,
      metrics: object(body.metrics, "metrics"),
      coverage,
      queues: object(body.queues, "queues"),
      run_id: text(body.run_id, "run_id"),
      definition_version: text(body.definition_version, "definition_version"),
      computed_at: computed,
    });
    return { status: 200, body: { row } };
  } catch (error) {
    if (error instanceof PerformanceError) {
      return {
        status: error.status,
        body: { error: error.code, code: error.code },
      };
    }
    return {
      status: 502,
      body: {
        error: "sales_performance_storage_failed",
        code: "sales_performance_storage_failed",
      },
    };
  }
}

// The SDK is deliberately confined to this adapter; tests exercise the same
// action with an executable store and SQL tests exercise database permissions.
// deno-lint-ignore no-explicit-any
export function salesPerformanceStore(client: any): PerformanceStore {
  // deno-lint-ignore no-explicit-any
  function unwrap(result: any) {
    if (result.error) {
      if (result.error.code === "P0002") {
        throw new PerformanceError(404, "report_not_found");
      }
      if (result.error.code === "42501") {
        throw new PerformanceError(403, "operator_access_required");
      }
      throw new Error("sales_performance_storage_failed");
    }
    return result.data;
  }
  return {
    async write(row) {
      return unwrap(
        await client.rpc(
          "sales_performance_write_v1",
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [`p_${key}`, value]),
          ),
        ),
      );
    },
    async note(week, reportLane, note) {
      return unwrap(
        await client.rpc("sales_performance_note_v1", {
          p_week_start: week,
          p_lane: reportLane,
          p_note: note,
        }),
      );
    },
    async read(org, from, through) {
      return unwrap(
        await client.from("sales_performance_weeks").select("*").eq(
          "org_id",
          org,
        )
          .gte("week_start", from).lte("week_start", through).order(
            "week_start",
            { ascending: false },
          ).order("lane"),
      );
    },
    async weeks(org) {
      const rows: { week_start: string }[] = unwrap(
        await client.from("sales_performance_weeks")
          .select("week_start").eq("org_id", org).order("week_start", {
            ascending: false,
          }).limit(208),
      );
      return [...new Set(rows.map((row) => row.week_start))].slice(0, 104);
    },
  };
}
