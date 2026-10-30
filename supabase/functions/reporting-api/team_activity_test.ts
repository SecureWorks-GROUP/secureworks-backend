// deno-lint-ignore-file no-import-prefix require-await
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadTeamActivity } from "./team_activity.ts";

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

Deno.test("team activity does not filter job_events by org_id", async () => {
  const calls: Call[] = [];
  const result = await loadTeamActivity(
    client([
      {
        data: [{
          job_id: "job-1",
          event_type: "note",
          detail_json: { text: "called" },
          created_at: "2026-10-30T00:00:00Z",
          users: { name: "Jan" },
        }],
        error: null,
      },
      {
        data: [{ id: "job-1", client_name: "Ada", job_number: "SWF-1" }],
        error: null,
      },
    ], calls),
    "2026-10-29T00:00:00Z",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.events, [{
    type: "note",
    job: "SWF-1 (Ada)",
    who: "Jan",
    when: "2026-10-30T00:00:00Z",
    detail: JSON.stringify({ text: "called" }).slice(0, 200),
  }]);
  assertEquals(result.total, 1);
  assertEquals(result.period, "Since 2026-10-29T00:00:00Z");
  const eventFilters = calls.filter((c) => c.table === "job_events");
  assertEquals(eventFilters.some((c) => c.method === "eq"), false);
  assertEquals(
    eventFilters.some((c) =>
      c.args.some((arg) =>
        arg === "org_id" || arg === "00000000-0000-0000-0000-000000000001"
      )
    ),
    false,
  );
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
    "2026-10-29T00:00:00Z",
  );
  assertEquals(result, {
    ok: false,
    error: "column job_events.org_id does not exist",
    code: "42703",
    status: 500,
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
    "2026-10-29T00:00:00Z",
  );
  assertEquals(result, {
    ok: false,
    error: "jobs read failed",
    code: "57014",
    status: 500,
  });
});

Deno.test("no events is an empty list, not an error", async () => {
  const result = await loadTeamActivity(
    client([{ data: [], error: null }], []),
    "2026-10-29T00:00:00Z",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.events, []);
  assertEquals(result.total, 0);
});
