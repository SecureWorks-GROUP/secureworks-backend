/**
 * F-ACT (INTEGRATION X31): ops-api records who asked, counts server-key calls
 * with no usable actor, and never refuses one.
 *
 * Unit half: the two log lines and the best-effort missing count (scheduled
 * off the request path, never thrown, never for JWT calls or calls with an
 * actor, and carrying nothing a caller chose).
 */
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveRequestActor } from "../_shared/request_actor.ts";
import {
  loggedActionName,
  opsApiDeniedLogLine,
  opsApiRequestLogLine,
  recordOpsApiActorMissing,
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

type Call = { fn: string; args: unknown[] };

function fakeClient(
  result: () => PromiseLike<{ data: unknown; error: unknown }>,
) {
  const calls: Call[] = [];
  let built = 0;
  const factory = () => {
    built++;
    return {
      rpc: (fn: string, ...args: unknown[]) => {
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

const ok = () => Promise.resolve({ data: null, error: null });

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

Deno.test("served-call line carries the actor and its source, ids only", () => {
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
  assertEquals(
    opsApiRequestLogLine('x"; drop', "GET", INVALID),
    "[ops-api] action=other method=GET actor=actor_missing actor_source=header_invalid",
  );
});

Deno.test("refused-call line carries the same actor plus the refusal", () => {
  assertEquals(
    opsApiDeniedLogLine(
      "makesafe_board",
      "GET",
      USER,
      403,
      "operator_access_required",
    ),
    "[ops-api] denied action=makesafe_board method=GET actor=user:u-1 actor_source=jwt status=403 code=operator_access_required",
  );
  assertEquals(
    opsApiDeniedLogLine(null, "POST", MISSING, 401, "Bad Code!"),
    "[ops-api] denied action=none method=POST actor=actor_missing actor_source=none status=401 code=other",
  );
});

Deno.test("logged action names: kept when they fit the grammar, else other or none", () => {
  assertEquals(loggedActionName("where_is_it_at"), "where_is_it_at");
  assertEquals(loggedActionName(null), "none");
  assertEquals(loggedActionName("  "), "none");
  assertEquals(loggedActionName("Makesafe-Board"), "other");
  assertEquals(loggedActionName("a".repeat(65)), "other");
  assertEquals(loggedActionName("a".repeat(64)), "a".repeat(64));
});

Deno.test("a server-key call with no usable actor is counted once, with no argument, off the request path", async () => {
  for (
    const [mode, actor] of [
      ["api_key", MISSING],
      ["routine", MISSING],
      ["agent_read", INVALID],
    ] as const
  ) {
    const c = fakeClient(ok);
    const rt = fakeRuntime();
    assertEquals(recordOpsApiActorMissing(c.factory, mode, actor, rt), true);
    assertEquals(c.calls, [{ fn: "record_ops_api_actor_missing", args: [] }]);
    assertEquals(rt.waited.length, 1);
    await Promise.all(rt.waited);
  }
});

Deno.test("calls with an actor, and JWT calls, write nothing and build no client", () => {
  for (
    const [mode, actor] of [
      ["api_key", CLAIMED],
      ["jwt", USER],
      ["jwt", MISSING],
      ["none", MISSING],
    ] as const
  ) {
    const c = fakeClient(ok);
    const rt = fakeRuntime();
    assertEquals(recordOpsApiActorMissing(c.factory, mode, actor, rt), false);
    assertEquals(c.built(), 0);
    assertEquals(rt.waited.length, 0);
  }
});

Deno.test("no EdgeRuntime: nothing is counted and no client is built", () => {
  const c = fakeClient(ok);
  assertEquals(
    recordOpsApiActorMissing(c.factory, "api_key", MISSING, null),
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
        recordOpsApiActorMissing(c.factory, "api_key", MISSING, rt),
        true,
      );
      await Promise.all(rt.waited);
    }
    const throwing = () => {
      throw new Error("boom");
    };
    assertEquals(
      recordOpsApiActorMissing(throwing, "api_key", MISSING, fakeRuntime()),
      false,
    );
  });
  assertEquals(lines, [
    '{"event":"ops_api_actor_count_failed","code":"42P01"}',
    '{"event":"ops_api_actor_count_failed","code":"no_code"}',
    '{"event":"ops_api_actor_count_failed","code":"no_code"}',
  ]);
});
