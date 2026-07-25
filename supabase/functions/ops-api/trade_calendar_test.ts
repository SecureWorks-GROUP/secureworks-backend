// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  handleTradeCalendarAction,
  type TradeAuthContext,
  tradeCalendarEvents,
} from "./index.ts";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";

const HENRY: TradeAuthContext = {
  id: "henry",
  email: "henry@example.com",
  orgId: TENANT_A,
  role: "lead_installer",
  managedVerticals: ["fencing"],
};

const ROWS = [
  {
    assignment_id: "henry-fence",
    job_id: "job-henry",
    user_id: "henry",
    job_number: "SWF-1",
    job_type: "fencing",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-14",
    scheduled_end: null,
    assigned_to: "Henry",
  },
  {
    assignment_id: "other-fence-overlap",
    job_id: "job-other",
    user_id: "alyx",
    job_number: "SWF-2",
    job_type: "fencing",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-10",
    scheduled_end: "2026-07-13",
    assigned_to: "Alyx",
  },
  {
    assignment_id: "other-fence-null-end",
    job_id: "job-null",
    user_id: "israel",
    job_number: "SWF-3",
    job_type: "fencing",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-20",
    scheduled_end: null,
    assigned_to: "Israel",
  },
  {
    assignment_id: "old-null-end",
    job_id: "job-old",
    user_id: "israel",
    job_number: "SWF-4",
    job_type: "fencing",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-12",
    scheduled_end: null,
  },
  {
    assignment_id: "patio-a",
    job_id: "job-patio",
    user_id: "nithin",
    job_number: "SWP-1",
    job_type: "patio",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  },
  {
    assignment_id: "henry-patio",
    job_id: "job-henry-patio",
    user_id: "henry",
    job_number: "SWP-2",
    job_type: "patio",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-16",
    scheduled_end: null,
  },
  {
    assignment_id: "decking-a",
    job_id: "job-deck",
    user_id: "deck",
    job_number: "SWD-1",
    job_type: "decking",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  },
  {
    assignment_id: "makesafe-a",
    job_id: "job-ms",
    user_id: "hugo",
    job_number: "SWMS-1",
    job_type: "general",
    org_id: TENANT_A,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  },
  {
    assignment_id: "fence-b",
    job_id: "job-b",
    user_id: "tenant-b-user",
    job_number: "SWF-B",
    job_type: "fencing",
    org_id: TENANT_B,
    assignment_status: "scheduled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  },
  {
    assignment_id: "cancelled-fence",
    job_id: "job-cancelled",
    user_id: "alyx",
    job_number: "SWF-C",
    job_type: "fencing",
    org_id: TENANT_A,
    assignment_status: "cancelled",
    scheduled_date: "2026-07-15",
    scheduled_end: null,
  },
];

type QueryCapture = {
  select: string;
  eq: Record<string, unknown>;
  neq: Record<string, unknown>;
  lte: Record<string, string>;
  or: string[];
  limit: number | null;
};

function calendarClient(
  viewer: TradeAuthContext,
  rows = ROWS,
): { client: any; captures: QueryCapture[] } {
  const captures: QueryCapture[] = [];

  function from(table: string) {
    if (table === "users") {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () =>
          Promise.resolve({
            data: {
              id: viewer.id,
              org_id: viewer.orgId,
              role: viewer.role,
              managed_verticals: viewer.managedVerticals,
            },
            error: null,
          }),
      };
      return b;
    }

    if (table !== "calendar_events") {
      throw new Error(`unexpected table ${table}`);
    }

    const capture: QueryCapture = {
      select: "",
      eq: {},
      neq: {},
      lte: {},
      or: [],
      limit: null,
    };
    captures.push(capture);
    const b: any = {
      select: (value: string) => {
        capture.select = value;
        return b;
      },
      eq: (column: string, value: unknown) => {
        capture.eq[column] = value;
        return b;
      },
      neq: (column: string, value: unknown) => {
        capture.neq[column] = value;
        return b;
      },
      lte: (column: string, value: string) => {
        capture.lte[column] = value;
        return b;
      },
      or: (value: string) => {
        capture.or.push(value);
        return b;
      },
      order: () => b,
      limit: (value: number) => {
        capture.limit = value;
        return b;
      },
      then: (resolve: (value: unknown) => void) => {
        let result = rows.slice();
        for (const [column, value] of Object.entries(capture.eq)) {
          result = result.filter((row: any) => row[column] === value);
        }
        for (const [column, value] of Object.entries(capture.neq)) {
          result = result.filter((row: any) => row[column] !== value);
        }
        if (capture.lte.scheduled_date) {
          result = result.filter((row: any) =>
            row.scheduled_date != null &&
            row.scheduled_date <= capture.lte.scheduled_date
          );
        }
        for (const clause of capture.or) {
          if (clause.startsWith("scheduled_end.gte.")) {
            const from =
              clause.match(/scheduled_end\.gte\.(\d{4}-\d{2}-\d{2})/)?.[1] ||
              "";
            result = result.filter((row: any) =>
              (row.scheduled_end != null && row.scheduled_end >= from) ||
              (row.scheduled_end == null && row.scheduled_date >= from)
            );
            continue;
          }
          const conditions = clause.split(",");
          result = result.filter((row: any) =>
            conditions.some((condition: string) => {
              const [column, op, ...rest] = condition.split(".");
              const value = rest.join(".");
              if (op === "eq") return String(row[column] || "") === value;
              if (op === "ilike") {
                return String(row[column] || "").toLowerCase().startsWith(
                  value.replace(/%$/, "").toLowerCase(),
                );
              }
              return false;
            })
          );
        }
        resolve({
          data: result.slice(0, capture.limit || result.length),
          error: null,
        });
      },
    };
    return b;
  }

  return {
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: { id: viewer.id, email: viewer.email } },
            error: null,
          }),
      },
      from,
    },
    captures,
  };
}

function params(mode: "all" | "mine", type?: string): URLSearchParams {
  const value: Record<string, string> = {
    from: "2026-07-13",
    to: "2026-07-21",
    mode,
  };
  if (type) value.type = type;
  return new URLSearchParams(value);
}

Deno.test("trade calendar Everyone returns same-tenant managed fencing with overlap and null-end semantics", async () => {
  const { client, captures } = calendarClient(HENRY);
  const result = await tradeCalendarEvents(client, params("all"), HENRY, false);

  assertEquals(result.schema, "trade-calendar.v1");
  assertEquals(result.mode, "all");
  assertEquals(result.events.map((row: any) => row.assignment_id), [
    "henry-fence",
    "other-fence-overlap",
    "other-fence-null-end",
  ]);
  assertEquals(result.events.some((row: any) => "org_id" in row), false);
  assertEquals(captures[0].eq.org_id, TENANT_A);
  assert(captures[0].or.includes("job_type.eq.fencing"));
  assertEquals(captures[0].select.includes("pricing_json"), false);
  assertEquals(captures[0].select.includes("scope_json"), false);
  assertEquals(captures[0].select.includes("client_phone"), false);
});

Deno.test("trade calendar Mine returns only the viewer's assignments", async () => {
  const { client } = calendarClient(HENRY);
  const result = await tradeCalendarEvents(
    client,
    params("mine"),
    HENRY,
    false,
  );
  assertEquals(result.events.map((row: any) => row.assignment_id), [
    "henry-fence",
  ]);
});

Deno.test("ordinary installer remains own-only even when requesting Everyone", async () => {
  const installer = { ...HENRY, managedVerticals: [] };
  const { client } = calendarClient(installer);
  const result = await tradeCalendarEvents(
    client,
    params("all"),
    installer,
    false,
  );
  assertEquals(result.mode, "mine");
  assertEquals(result.events.map((row: any) => row.assignment_id), [
    "henry-fence",
    "henry-patio",
  ]);
});

Deno.test("dispatcher Everyone behavior remains tenant-wide", async () => {
  const dispatcher = { ...HENRY, role: "ops_manager", managedVerticals: [] };
  const { client } = calendarClient(dispatcher);
  const result = await tradeCalendarEvents(
    client,
    params("all"),
    dispatcher,
    true,
  );
  assertEquals(
    result.events.map((row: any) => row.assignment_id),
    [
      "henry-fence",
      "other-fence-overlap",
      "other-fence-null-end",
      "patio-a",
      "henry-patio",
      "decking-a",
      "makesafe-a",
    ],
  );
});

Deno.test("manager denies an unmanaged requested vertical in Everyone or Mine", async () => {
  const { client } = calendarClient(HENRY);
  for (const mode of ["all", "mine"] as const) {
    await assertRejects(
      () => tradeCalendarEvents(client, params(mode, "patio"), HENRY, false),
      Error,
      "not managed",
    );
  }
});

Deno.test("authenticated trade_calendar action carries JWT tenant and manager scope end to end", async () => {
  const service = calendarClient(HENRY);
  const request = new Request(
    "https://example.test/functions/v1/ops-api?action=trade_calendar&from=2026-07-13&to=2026-07-21&mode=all&type=fencing",
    { headers: { Authorization: "Bearer fixture-jwt" } },
  );
  const response = await handleTradeCalendarAction(request, service.client);
  assertEquals(response.status, 200);
  const payload = await response.json();
  assertEquals(payload.schema, "trade-calendar.v1");
  assertEquals(payload.mode, "all");
  assertEquals(payload.type, "fencing");
  assertEquals(payload.events.map((row: any) => row.assignment_id), [
    "henry-fence",
    "other-fence-overlap",
    "other-fence-null-end",
  ]);
  assertEquals(service.captures[0].eq.org_id, TENANT_A);
  assertEquals(service.captures[0].eq.user_id, undefined);
});
