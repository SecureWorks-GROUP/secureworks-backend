// Slice B0: the unlinked-evidence census and rows doors. Behaviour on the
// module (parameters, RPC arguments, error mapping, actor log line, no row
// content logged) and on the real ops-api front door (staff only, never a
// profile-scoped trade read, never an agent-read or routine action).
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contextUnlinkedCensus,
  ContextUnlinkedError,
  contextUnlinkedRows,
  rowsArgs,
} from "./context_unlinked.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const ACTIONS = ["context_unlinked_census", "context_unlinked_rows"];

function capture<T>(fn: () => Promise<T>) {
  const lines: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return fn().finally(() => {
    console.log = log;
    console.error = err;
  }).then((result) => ({ result, lines }), (error) => {
    throw Object.assign(error, { lines });
  });
}

function fakeRpc(data: unknown, error: unknown = null) {
  const calls: { fn: string; args: unknown }[] = [];
  return {
    calls,
    client: {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data, error });
      },
    },
  };
}

const CENSUS = {
  complete: true,
  next: null,
  elapsed_ms: 12,
  totals: { admin_bucket: 3 },
  admin_bucket: {
    classified: 3,
    by_reason: [{
      reason: "identity_unread",
      rows: 1,
      age: { lt_1d: 1 },
      sample_ids: ["b0e00000-0000-4000-8000-000000000001"],
    }],
    restamped_legacy_by_prior_method: {},
  },
  holding_job: { classified: 0, by_reason: [] },
  custody_multi_ref: { checked: 0, rows: 0, sample_ids: [] },
};

Deno.test("census passes the budget, returns the payload and logs the actor with counts only", async () => {
  const f = fakeRpc(CENSUS);
  const { result, lines } = await capture(() =>
    contextUnlinkedCensus(
      f.client,
      new URLSearchParams("budget_ms=5000"),
      "user:u1",
    )
  );
  assertEquals(result, { ...CENSUS, calls: 1 });
  assertEquals(f.calls, [{
    fn: "context_unlinked_census",
    args: { p_budget_ms: 5000 },
  }]);
  assertEquals(lines.map((l) => JSON.parse(l)), [{
    event: "context_unlinked_census",
    actor: "user:u1",
    complete: true,
    calls: 1,
    classified: 3,
    elapsed_ms: 12,
  }]);
});

Deno.test("the census follows next across calls and adds the parts up", async () => {
  const first = {
    ...CENSUS,
    complete: false,
    next: {
      phase: "admin_bucket",
      cursor_at: "2026-09-18T00:00:00Z",
      cursor_id: "b0e00000-0000-4000-8000-000000000002",
    },
    admin_bucket: {
      classified: 2,
      by_reason: [{
        reason: "no_identity",
        rows: 2,
        age: { d1_7: 2 },
        sample_ids: ["a", "b"],
      }],
      restamped_legacy_by_prior_method: { contact_id: 1 },
    },
  };
  const second = {
    complete: true,
    next: null,
    elapsed_ms: 30,
    admin_bucket: {
      classified: 1,
      by_reason: [{
        reason: "no_identity",
        rows: 1,
        age: { gt_90: 1 },
        sample_ids: ["c"],
      }, { reason: "own_party", rows: 0, age: {}, sample_ids: [] }],
      restamped_legacy_by_prior_method: { contact_id: 2, none: 1 },
    },
    holding_job: {
      classified: 4,
      by_reason: [{
        reason: "platform_sender",
        rows: 4,
        age: { d7_30: 4 },
        sample_ids: ["h"],
      }],
    },
    custody_multi_ref: { checked: 9, rows: 1, sample_ids: ["n8"] },
  };
  const calls: unknown[] = [];
  const client = {
    rpc: (_fn: string, args?: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve({
        data: calls.length === 1 ? first : second,
        error: null,
      });
    },
  };
  const { result } = await capture(() =>
    contextUnlinkedCensus(client, new URLSearchParams(), "a")
  );
  assertEquals(calls, [{}, {
    p_phase: "admin_bucket",
    p_cursor_at: "2026-09-18T00:00:00Z",
    p_cursor_id: "b0e00000-0000-4000-8000-000000000002",
  }]);
  const r = result as Record<string, any>;
  assertEquals([r.complete, r.calls, r.elapsed_ms, r.totals], [true, 2, 42, {
    admin_bucket: 3,
  }]);
  assertEquals(r.admin_bucket.classified, 3);
  assertEquals(r.admin_bucket.by_reason[0], {
    reason: "no_identity",
    rows: 3,
    age: { d1_7: 2, gt_90: 1 },
    sample_ids: ["a", "b", "c"],
  });
  assertEquals(r.admin_bucket.restamped_legacy_by_prior_method, {
    contact_id: 3,
    none: 1,
  });
  assertEquals(r.holding_job.classified, 4);
  assertEquals(r.custody_multi_ref, {
    checked: 9,
    rows: 1,
    sample_ids: ["n8"],
  });
});

Deno.test("a census that cannot finish is 504 census_timeout carrying the partial totals and where it stopped", async () => {
  const partial = {
    ...CENSUS,
    complete: false,
    next: { phase: "holding_job", cursor_at: null, cursor_id: null },
  };
  const f = fakeRpc(partial);
  const error = await capture(() =>
    assertRejects(
      () =>
        contextUnlinkedCensus(
          f.client,
          new URLSearchParams(),
          "actor_missing",
          { maxCalls: 3 },
        ),
      ContextUnlinkedError,
    )
  ).then((r) => r.result);
  assertEquals([error.code, error.status], ["census_timeout", 504]);
  assertEquals(f.calls.length, 3);
  const p = error.detail.partial as Record<string, any>;
  assertEquals([p.complete, p.calls, p.next], [false, 3, {
    phase: "holding_job",
    cursor_at: null,
    cursor_id: null,
  }]);
});

Deno.test("a database statement timeout is 504; other RPC faults are 503 with the code only", async () => {
  const t = fakeRpc({ secret_row: "never logged" }, {
    code: "57014",
    message: "canceling statement",
  });
  const e1 = await capture(() =>
    assertRejects(
      () => contextUnlinkedCensus(t.client, new URLSearchParams(), "a"),
      ContextUnlinkedError,
    )
  );
  assertEquals([e1.result.code, e1.result.status, e1.result.detail.reason], [
    "census_timeout",
    504,
    "57014",
  ]);
  assertEquals(e1.lines.some((l) => l.includes("never logged")), false);
  const o = fakeRpc(null, {
    code: "42883",
    message: "function does not exist",
  });
  const e2 = await capture(() =>
    assertRejects(
      () => contextUnlinkedRows(o.client, new URLSearchParams(), "a"),
      ContextUnlinkedError,
    )
  );
  assertEquals([e2.result.code, e2.result.status, e2.result.detail.reason], [
    "context_unlinked_unavailable",
    503,
    "42883",
  ]);
});

Deno.test("rows maps every parameter onto the RPC and logs counts, never row content", async () => {
  const f = fakeRpc({
    rows: [{ id: "x", preview: "customer words" }],
    scanned: 9,
  });
  const params = new URLSearchParams({
    scope: "custody_multi_ref",
    reason: "custody_multi_ref",
    source: "monitor-inbox",
    since: "2026-09-01T00:00:00Z",
    cursor_at: "2026-09-20T01:02:03Z",
    cursor_id: "b0e00000-0000-4000-8000-000000000008",
    limit: "50",
  });
  const { lines } = await capture(() =>
    contextUnlinkedRows(f.client, params, "workflow:census")
  );
  assertEquals(f.calls[0], {
    fn: "context_unlinked_rows",
    args: {
      p_scope: "custody_multi_ref",
      p_reason: "custody_multi_ref",
      p_source: "monitor-inbox",
      p_since: "2026-09-01T00:00:00.000Z",
      p_cursor_at: "2026-09-20T01:02:03.000Z",
      p_cursor_id: "b0e00000-0000-4000-8000-000000000008",
      p_limit: 50,
    },
  });
  assertEquals(lines.some((l) => l.includes("customer words")), false);
  assertEquals(JSON.parse(lines[0]).returned, 1);
});

Deno.test("rows defaults to the bucket, 25 rows, no filters", () => {
  assertEquals(rowsArgs(new URLSearchParams()), {
    p_scope: "bucket",
    p_reason: null,
    p_source: null,
    p_since: null,
    p_cursor_at: null,
    p_cursor_id: null,
    p_limit: 25,
  });
});

Deno.test("rows refuses unknown scopes and reasons, half cursors, bad ids, dates and limits", () => {
  for (
    const q of [
      "scope=everything",
      "reason=guess",
      "cursor_at=2026-09-20T00:00:00Z",
      "cursor_id=b0e00000-0000-4000-8000-000000000008",
      "cursor_at=2026-09-20T00:00:00Z&cursor_id=not-a-uuid",
      "since=yesterday",
      "limit=0",
      "limit=101",
      "limit=5.5",
      "scope=holding_jobs",
      "source=a%20b",
    ]
  ) {
    const e = assertThrows(
      () => rowsArgs(new URLSearchParams(q)),
      ContextUnlinkedError,
    );
    assertEquals([e.code, e.status], ["invalid_request", 400], q);
  }
});

Deno.test("both doors are staff-only: not profile-scoped, not agent-read, trades refused", () => {
  for (const action of ACTIONS) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    const decide = (
      authMode: "api_key" | "jwt",
      role?: string,
      managedVerticals?: string[],
    ) => {
      const d = _authorizeOpsApiAction({
        url,
        authMode,
        authUser: role ? { role, managedVerticals } : null,
        serverSecretPresented: authMode === "api_key",
      });
      return d.ok ? 200 : d.status;
    };
    assertEquals(decide("jwt", "admin"), 200, action);
    assertEquals(decide("jwt", "ops_manager"), 200, action);
    assertEquals(decide("api_key"), 200, action);
    assertEquals(decide("jwt", "lead_installer"), 403, action);
    assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403, action);
    assertEquals(decide("jwt", "trade"), 403, action);
  }
});
