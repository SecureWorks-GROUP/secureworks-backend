// The context scorecard door (W11, migration 20261006032000):
// - GET context_scorecard returns the rows 1 to 14 card from context_scorecard;
// - with jobs=1 it returns one page of context_scorecard_jobs (after, limit);
// - every parameter is checked before any read, a failed read is an error
//   with a code, and the door is staff-only through the existing front door.
// Fake client only; synthetic ids.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contextScorecardAction,
  parseScorecardLimit,
  SCORECARD_JOBS_MAX_LIMIT,
} from "./context_scorecard_read.ts";
import { StoryReadError } from "./job_story_read.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const JOB = "5c000000-0000-4000-8000-000000000001";

function fakeClient(rpc: Record<string, any>) {
  const calls: { fn: string; args: any }[] = [];
  return {
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      const answer = rpc[fn];
      if (answer === undefined) {
        return Promise.resolve({ data: null, error: { message: `no ${fn}`, code: "42883" } });
      }
      return Promise.resolve(typeof answer === "function" ? answer(args) : answer);
    },
    from() {
      throw new Error("the scorecard door reads no table directly");
    },
  };
}

const CARD = {
  version: "context-scorecard-v1",
  live_jobs: 3,
  rows: Array.from({ length: 14 }, (_, i) => ({ row: i + 1, status: "red", lanes: [] })),
  alarms: [{ key: "lane_quiet", lane: "texts" }],
};

Deno.test("GET context_scorecard returns the rows 1 to 14 card", async () => {
  const client = fakeClient({ context_scorecard: { data: CARD, error: null } });
  const card: any = await contextScorecardAction(client, new URLSearchParams(""));
  assertEquals(card.version, "context-scorecard-v1");
  assertEquals(card.rows.length, 14);
  assertEquals(client.calls, [{ fn: "context_scorecard", args: {} }]);
});

Deno.test("as_of is passed through as an ISO instant", async () => {
  const client = fakeClient({ context_scorecard: { data: CARD, error: null } });
  await contextScorecardAction(client, new URLSearchParams("as_of=2026-10-05T04:00:00Z"));
  assertEquals(client.calls[0].args, { p_as_of: "2026-10-05T04:00:00.000Z" });
});

Deno.test("jobs=1 returns one page of context_scorecard_jobs with its cursor", async () => {
  const page = { version: "context-scorecard-jobs-v1", jobs: [{ job_id: JOB, status: "red", rows: [] }], next: JOB };
  const client = fakeClient({ context_scorecard_jobs: { data: page, error: null } });
  const got: any = await contextScorecardAction(
    client,
    new URLSearchParams(`jobs=1&after=${JOB.toUpperCase()}&limit=2&as_of=2026-10-05T04:00:00Z`),
  );
  assertEquals(got.next, JOB);
  assertEquals(client.calls, [{
    fn: "context_scorecard_jobs",
    args: { p_after: JOB, p_limit: 2, p_as_of: "2026-10-05T04:00:00.000Z" },
  }]);
  const first = fakeClient({ context_scorecard_jobs: { data: page, error: null } });
  await contextScorecardAction(first, new URLSearchParams("jobs=1"));
  assertEquals(first.calls[0].args, { p_after: null, p_limit: 150 });
});

Deno.test("bad parameters are refused before any read", async () => {
  for (
    const [params, code] of [
      ["as_of=__deploy_probe__", "invalid_as_of"],
      ["as_of=2999-01-01T00:00:00Z", "invalid_as_of"],
      ["jobs=all", "invalid_jobs"],
      ["jobs=1&after=not-a-uuid", "invalid_after"],
      ["jobs=1&limit=0", "invalid_limit"],
      [`jobs=1&limit=${SCORECARD_JOBS_MAX_LIMIT + 1}`, "invalid_limit"],
      ["jobs=1&limit=1.5", "invalid_limit"],
    ] as const
  ) {
    const client = fakeClient({});
    const err = await assertRejects(
      () => contextScorecardAction(client, new URLSearchParams(params)),
      StoryReadError,
    );
    assertEquals((err as StoryReadError).code, code, params);
    assertEquals((err as StoryReadError).status, 400, params);
    assertEquals(client.calls, [], params);
  }
  assertEquals(parseScorecardLimit(null), 150);
  assertEquals(parseScorecardLimit("300"), 300);
});

Deno.test("a failed or unrecognised read is a 502 with a code, never an empty card", async () => {
  const failed = fakeClient({ context_scorecard: { data: null, error: { message: "boom", code: "57014" } } });
  let err = await assertRejects(() => contextScorecardAction(failed, new URLSearchParams("")), StoryReadError);
  assertEquals((err as StoryReadError).code, "scorecard_failed");
  assertEquals((err as StoryReadError).status, 502);
  assert((err as StoryReadError).message.includes("57014"));
  assert(!(err as StoryReadError).message.includes("boom"));
  const short = fakeClient({ context_scorecard: { data: { ...CARD, rows: CARD.rows.slice(0, 10) }, error: null } });
  err = await assertRejects(() => contextScorecardAction(short, new URLSearchParams("")), StoryReadError);
  assertEquals((err as StoryReadError).code, "scorecard_invalid_shape");
  const pageFailed = fakeClient({});
  err = await assertRejects(() => contextScorecardAction(pageFailed, new URLSearchParams("jobs=1")), StoryReadError);
  assertEquals((err as StoryReadError).code, "scorecard_jobs_failed");
});

Deno.test("context_scorecard is staff-only: not profile-scoped, not agent-read, trades refused", () => {
  const url = new URL("https://example.invalid/ops-api?action=context_scorecard");
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("context_scorecard"), false);
  const decide = (authMode: "api_key" | "jwt", role?: string, managedVerticals?: string[]) => {
    const d = _authorizeOpsApiAction({
      url,
      authMode,
      authUser: role ? { role, managedVerticals } : null,
      serverSecretPresented: authMode === "api_key",
    });
    return d.ok ? 200 : d.status;
  };
  assertEquals(decide("jwt", "admin"), 200);
  assertEquals(decide("jwt", "owner"), 200);
  assertEquals(decide("jwt", "ops_manager"), 200);
  assertEquals(decide("api_key"), 200);
  assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403);
  assertEquals(decide("jwt", "trade"), 403);
});

Deno.test("the dispatch routes context_scorecard as a GET-only read", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(index.includes("case 'context_scorecard':\n      case 'context_story_scorecard': {"));
  assert(index.includes("? await contextScorecardAction(client, url.searchParams)"));
  const required = await Deno.readTextFile(new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url));
  assert(/^context_scorecard\s+# probe=bounded-refusal probe-args=as_of=__deploy_probe__$/m.test(required));
});
