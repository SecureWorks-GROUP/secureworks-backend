/**
 * F-ACT (INTEGRATION X31): ops-api records who asked, counts server-key calls
 * with no actor, and never refuses one.
 *
 * Unit half: the log line, the counted state and action, and the best-effort
 * count (scheduled off the request path, never thrown, never for JWT calls).
 * The SQL writer's action grammar is read from the migration, so the two
 * sides cannot drift.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveRequestActor } from "../_shared/request_actor.ts";
import {
  actorCallState,
  countedActionName,
  opsApiRequestLogLine,
  recordOpsApiActorCall,
} from "./actor_calls.ts";

const MISSING = resolveRequestActor({ headers: new Headers() });
const CLAIMED = resolveRequestActor({
  headers: new Headers({ "x-sw-actor": "workflow:census" }),
});
const INVALID = resolveRequestActor({
  headers: new Headers({ "x-sw-actor": "drop table; --" }),
});
const USER = resolveRequestActor({
  verifiedUserId: "u-1",
  headers: new Headers(),
});

type Call = { fn: string; args?: Record<string, unknown> };

function fakeClient(
  result: () => PromiseLike<{ data: unknown; error: unknown }>,
) {
  const calls: Call[] = [];
  let built = 0;
  const factory = () => {
    built++;
    return {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        calls.push({ fn, args });
        return result();
      },
    };
  };
  return { factory, calls, built: () => built };
}

function fakeRuntime() {
  const waited: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => waited.push(p), waited };
}

async function captureWarn(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("log line carries the actor and its source, ids only", () => {
  assertEquals(
    opsApiRequestLogLine("context_unlinked_census", "GET", MISSING),
    "[ops-api] action=context_unlinked_census method=GET actor=actor_missing actor_source=none",
  );
  assertEquals(
    opsApiRequestLogLine("context_unlinked_census", "GET", CLAIMED),
    "[ops-api] action=context_unlinked_census method=GET actor=workflow:census actor_source=header",
  );
  assertEquals(
    opsApiRequestLogLine("job_detail", "POST", USER),
    "[ops-api] action=job_detail method=POST actor=user:u-1 actor_source=jwt",
  );
  // A malformed header and a hostile action name never reach the line raw.
  const line = opsApiRequestLogLine('x"; drop', "GET", INVALID);
  assertEquals(
    line,
    "[ops-api] action=other method=GET actor=actor_missing actor_source=header_invalid",
  );
});

Deno.test("state: present, missing, invalid_header", () => {
  assertEquals(actorCallState(CLAIMED), "present");
  assertEquals(actorCallState(USER), "present");
  assertEquals(actorCallState(MISSING), "missing");
  assertEquals(actorCallState(INVALID), "invalid_header");
});

Deno.test("action names: kept when they fit the grammar, else other or none", () => {
  assertEquals(countedActionName("where_is_it_at"), "where_is_it_at");
  assertEquals(countedActionName(null), "none");
  assertEquals(countedActionName("  "), "none");
  assertEquals(countedActionName("Makesafe-Board"), "other");
  assertEquals(countedActionName("a".repeat(65)), "other");
  assertEquals(countedActionName("a".repeat(64)), "a".repeat(64));
});

Deno.test("the TypeScript and SQL action grammars are the same", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260924201000_ops_api_actor_recording.sql",
      import.meta.url,
    ),
  );
  const src = await Deno.readTextFile(
    new URL("./actor_calls.ts", import.meta.url),
  );
  const grammar = "^[a-z][a-z0-9_]{0,63}$";
  assert(sql.includes(`action ~ '${grammar}'`), "table check");
  assert(sql.includes(`IF a !~ '${grammar}' THEN a:='other'`), "writer");
  assert(src.includes(`/${grammar}/`), "ts");
});

Deno.test("each server-key class is counted once, off the request path", async () => {
  for (
    const [mode, actor, state] of [
      ["api_key", MISSING, "missing"],
      ["api_key", CLAIMED, "present"],
      ["routine", MISSING, "missing"],
      ["agent_read", INVALID, "invalid_header"],
    ] as const
  ) {
    const c = fakeClient(() => Promise.resolve({ data: null, error: null }));
    const rt = fakeRuntime();
    assertEquals(
      recordOpsApiActorCall(
        c.factory,
        mode,
        actor,
        "context_unlinked_census",
        rt,
      ),
      true,
    );
    assertEquals(c.calls, [{
      fn: "record_ops_api_actor_call",
      args: {
        p_caller_class: mode,
        p_actor_state: state,
        p_action: "context_unlinked_census",
      },
    }]);
    assertEquals(rt.waited.length, 1);
    await Promise.all(rt.waited);
  }
});

Deno.test("a JWT call is never counted and builds no client", () => {
  const c = fakeClient(() => Promise.resolve({ data: null, error: null }));
  assertEquals(
    recordOpsApiActorCall(c.factory, "jwt", USER, "job_detail", fakeRuntime()),
    false,
  );
  assertEquals(c.built(), 0);
  assertEquals(c.calls, []);
});

Deno.test("no EdgeRuntime: nothing is counted and no client is built", () => {
  const c = fakeClient(() => Promise.resolve({ data: null, error: null }));
  assertEquals(
    recordOpsApiActorCall(c.factory, "api_key", MISSING, "job_detail", null),
    false,
  );
  assertEquals(c.built(), 0);
});

Deno.test("a failed count logs one coded line and never throws", async () => {
  const errored = fakeClient(() =>
    Promise.resolve({
      data: null,
      error: { code: "42P01", message: "relation does not exist" },
    })
  );
  const rejected = fakeClient(() =>
    Promise.reject(new TypeError("fetch failed"))
  );
  const lines = await captureWarn(async () => {
    for (const c of [errored, rejected]) {
      const rt = fakeRuntime();
      assertEquals(
        recordOpsApiActorCall(c.factory, "api_key", MISSING, "job_detail", rt),
        true,
      );
      await Promise.all(rt.waited);
    }
    const throwing = () => {
      throw new Error("boom");
    };
    assertEquals(
      recordOpsApiActorCall(
        throwing,
        "api_key",
        MISSING,
        "job_detail",
        fakeRuntime(),
      ),
      false,
    );
  });
  assertEquals(lines, [
    '{"event":"ops_api_actor_count_failed","code":"42P01"}',
    '{"event":"ops_api_actor_count_failed","code":"no_code"}',
    '{"event":"ops_api_actor_count_failed","code":"no_code"}',
  ]);
});
