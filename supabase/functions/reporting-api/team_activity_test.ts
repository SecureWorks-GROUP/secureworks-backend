// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadTeamActivity, teamActivityResponse } from "./team_activity.ts";

const ORG = "11111111-1111-1111-1111-111111111111";
const SINCE = "2026-10-29T00:00:00Z";

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

function client(
  results: Array<
    { data: unknown; error: { message: string; code?: string } | null }
  >,
  calls: Call[],
) {
  return {
    from(table: string) {
      const result = results.shift() ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      const note = (method: string) => (...args: unknown[]) => {
        calls.push({ table, method, args });
        return chain;
      };
      chain.select = note("select");
      chain.eq = note("eq");
      chain.gte = note("gte");
      chain.in = note("in");
      chain.order = note("order");
      chain.limit = note("limit");
      chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (err: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  };
}

function callsOn(calls: Call[], table: string, method: string): Call[] {
  return calls.filter((c) => c.table === table && c.method === method);
}

Deno.test("team activity returns recent events scoped through jobs.org_id", async () => {
  const calls: Call[] = [];
  const longDetail = "x".repeat(250);
  const result = await loadTeamActivity(
    client([
      {
        data: [
          {
            job_id: "job-1",
            event_type: "note",
            detail_json: { text: "called" },
            created_at: "2026-10-30T00:00:00Z",
            users: { name: "Jan" },
          },
          {
            job_id: "job-2",
            event_type: "status",
            detail_json: longDetail,
            created_at: "2026-10-30T01:00:00Z",
            users: null,
          },
        ],
        error: null,
      },
      {
        data: [{ id: "job-1", client_name: "Ada", job_number: "SWF-1" }],
        error: null,
      },
    ], calls),
    SINCE,
    ORG,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.events, [
    {
      type: "note",
      job: "SWF-1 (Ada)",
      who: "Jan",
      when: "2026-10-30T00:00:00Z",
      detail: JSON.stringify({ text: "called" }).slice(0, 200),
    },
    {
      type: "status",
      job: "job-2",
      who: "System",
      when: "2026-10-30T01:00:00Z",
      detail: longDetail.slice(0, 200),
    },
  ]);
  assertEquals(result.total, 2);
  assertEquals(result.period, `Since ${SINCE}`);
  assertEquals(teamActivityResponse(result), {
    status: 200,
    body: { events: result.events, total: 2, period: result.period },
  });

  const select = callsOn(calls, "job_events", "select");
  assertEquals(select.length, 1);
  assertEquals(
    select[0].args[0],
    "id, job_id, event_type, detail_json, created_at, users:user_id(name), jobs!inner(org_id)",
  );
  assertEquals(callsOn(calls, "job_events", "eq"), [{
    table: "job_events",
    method: "eq",
    args: ["jobs.org_id", ORG],
  }]);
  assertEquals(
    callsOn(calls, "job_events", "eq").some((c) => c.args[0] === "org_id"),
    false,
  );
  assertEquals(callsOn(calls, "job_events", "gte"), [{
    table: "job_events",
    method: "gte",
    args: ["created_at", SINCE],
  }]);
  assertEquals(callsOn(calls, "job_events", "order"), [{
    table: "job_events",
    method: "order",
    args: ["created_at", { ascending: false }],
  }]);
  assertEquals(callsOn(calls, "job_events", "limit"), [{
    table: "job_events",
    method: "limit",
    args: [50],
  }]);
  assertEquals(callsOn(calls, "jobs", "eq"), [{
    table: "jobs",
    method: "eq",
    args: ["org_id", ORG],
  }]);
  assertEquals(callsOn(calls, "jobs", "in"), [{
    table: "jobs",
    method: "in",
    args: ["id", ["job-1", "job-2"]],
  }]);
});

Deno.test("a job_events read error is returned, not an empty activity list", async () => {
  const calls: Call[] = [];
  const result = await loadTeamActivity(
    client([{
      data: null,
      error: {
        message: "column job_events.org_id does not exist",
        code: "42703",
      },
    }], calls),
    SINCE,
    ORG,
  );
  assertEquals(result, {
    ok: false,
    error: "column job_events.org_id does not exist",
    code: "42703",
    status: 500,
  });
  assertEquals(teamActivityResponse(result), {
    status: 500,
    body: { error: "column job_events.org_id does not exist", code: "42703" },
  });
  assertEquals(calls.some((c) => c.table === "jobs"), false);
});

Deno.test("a jobs lookup error is returned instead of events with no names", async () => {
  const result = await loadTeamActivity(
    client([
      {
        data: [{
          job_id: "job-1",
          event_type: "note",
          detail_json: "hello",
          created_at: "2026-10-30T00:00:00Z",
          users: null,
        }],
        error: null,
      },
      {
        data: null,
        error: { message: "jobs read failed", code: "57014" },
      },
    ], []),
    SINCE,
    ORG,
  );
  assertEquals(result, {
    ok: false,
    error: "jobs read failed",
    code: "57014",
    status: 500,
  });
  assertEquals(teamActivityResponse(result).status, 500);
});

Deno.test("no events is an empty list, not an error", async () => {
  for (const data of [[], null]) {
    const calls: Call[] = [];
    const result = await loadTeamActivity(
      client([{ data, error: null }], calls),
      SINCE,
      ORG,
    );
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.events, []);
    assertEquals(result.total, 0);
    assertEquals(result.period, `Since ${SINCE}`);
    assertEquals(teamActivityResponse(result).status, 200);
    assertEquals(calls.some((c) => c.table === "jobs"), false);
  }
});

Deno.test("a missing org id does not read job_events unscoped", async () => {
  const calls: Call[] = [];
  const result = await loadTeamActivity(client([], calls), SINCE, "");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.status, 500);
  assertEquals(calls, []);
});

Deno.test("the team_activity handler scopes through loadTeamActivity and returns its status", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const start = src.indexOf("case 'team_activity':");
  const end = src.indexOf("case 'sales_alerts':");
  assert(start >= 0 && end > start);
  const block = src.slice(start, end);
  assertEquals(block.includes(".from('job_events')"), false);
  assertEquals(block.includes(".eq('org_id'"), false);
  assert(block.includes("loadTeamActivity(sb, since, DEFAULT_ORG_ID)"));
  assert(block.includes("return json(response.body, response.status)"));
});
