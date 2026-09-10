// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createOrgConfigXeroCooldownStore,
  createXeroCooldownFetch,
  createXeroCooldownGuard,
  XeroCooldownError,
  xeroCooldownReport,
  type XeroCooldownScope,
  type XeroCooldownState,
  type XeroCooldownStore,
} from "./xero_cooldown.ts";

const SCOPE = {
  orgId: "10000000-0000-4000-8000-000000000001",
  appKey: "fixture-app",
  tenantId: "20000000-0000-4000-8000-000000000002",
};
const BASE = Date.parse("2026-09-09T08:00:00Z");

class MemoryStore implements XeroCooldownStore {
  rows = new Map<string, XeroCooldownState>();
  failRead = false;
  failWrite = false;
  writes = 0;
  scopeKey(scope: XeroCooldownScope) {
    return `${scope.orgId}:${scope.appKey}:${scope.tenantId}`;
  }
  read(scope: XeroCooldownScope) {
    if (this.failRead) {
      return Promise.reject(new Error("Fixture DB unavailable"));
    }
    return Promise.resolve(
      structuredClone(this.rows.get(this.scopeKey(scope)) ?? null),
    );
  }
  compareAndSwap(
    scope: XeroCooldownScope,
    expected: string | null,
    next: XeroCooldownState,
  ) {
    if (this.failWrite) {
      return Promise.reject(new Error("Fixture DB unavailable"));
    }
    const key = this.scopeKey(scope);
    if ((this.rows.get(key)?.revision ?? null) !== expected) {
      return Promise.resolve(false);
    }
    this.rows.set(key, structuredClone(next));
    this.writes++;
    return Promise.resolve(true);
  }
}

function clock() {
  let ms = BASE;
  return {
    now: () => new Date(ms),
    advance: (seconds: number) => {
      ms += seconds * 1000;
    },
  };
}
function limited(seconds = "19079") {
  return new Response(null, {
    status: 429,
    headers: {
      "Retry-After": seconds,
      "X-MinLimit-Remaining": "60",
      "Xero-Correlation-Id": "request-fixture",
    },
  });
}

Deno.test("normal requests read shared state without creating a coordination row", async () => {
  const store = new MemoryStore();
  const guard = createXeroCooldownGuard(store, clock());
  assertEquals(await guard.beforeRequest(SCOPE), null);
  await guard.afterResponse(SCOPE, null, new Response(null, { status: 200 }));
  assertEquals(store.writes, 0);
});

Deno.test("429 persists a cross-instance hold with truthful metadata and no token material", async () => {
  const store = new MemoryStore();
  const time = clock();
  await createXeroCooldownGuard(store, time).afterResponse(
    SCOPE,
    null,
    limited(),
  );
  const otherInstance = createXeroCooldownGuard(store, time);
  const error = await assertRejects(
    () => otherInstance.beforeRequest(SCOPE),
    XeroCooldownError,
  );
  assertEquals(error.code, "XERO_COOLDOWN_ACTIVE");
  assertEquals(error.details.retry_after_seconds, 19079);
  assertEquals(error.details.provider_called, false);
  const state = await store.read(SCOPE);
  assertEquals(state?.observation?.request_id, "request-fixture");
  assertEquals(state?.observation?.quota, {
    minute_remaining: "60",
    day_remaining: null,
    app_minute_remaining: null,
    limit_problem: null,
  });
  assertEquals(state?.observation?.deadline_source, "provider_retry_after");
  assertEquals(JSON.stringify(state).includes("Authorization"), false);
  assertEquals(JSON.stringify(state).includes("daily"), false);
});

Deno.test("concurrent observations cannot shorten the longest persisted hold", async () => {
  const store = new MemoryStore();
  const time = clock();
  const a = createXeroCooldownGuard(store, time);
  const b = createXeroCooldownGuard(store, time);
  await Promise.all([
    a.afterResponse(SCOPE, null, limited("100")),
    b.afterResponse(SCOPE, null, limited("200")),
  ]);
  await a.afterResponse(SCOPE, null, limited("10"));
  assertEquals(
    (await store.read(SCOPE))?.blocked_until,
    new Date(BASE + 200_000).toISOString(),
  );
});

Deno.test("after expiry one concurrent probe wins and a successful owned probe clears the expired hold", async () => {
  const store = new MemoryStore();
  const time = clock();
  const a = createXeroCooldownGuard(store, time);
  const b = createXeroCooldownGuard(store, time);
  await a.afterResponse(SCOPE, null, limited("1"));
  time.advance(2);
  const results = await Promise.allSettled([
    a.beforeRequest(SCOPE),
    b.beforeRequest(SCOPE),
  ]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results.find((r) =>
    r.status === "fulfilled"
  ) as PromiseFulfilledResult<string>;
  const loser = results.find((r) =>
    r.status === "rejected"
  ) as PromiseRejectedResult;
  assertEquals(loser.reason.code, "XERO_PROBE_IN_PROGRESS");
  await a.afterResponse(
    SCOPE,
    winner.value,
    new Response(null, { status: 200 }),
  );
  assertEquals((await store.read(SCOPE))?.blocked_until, null);
  assertEquals(await b.beforeRequest(SCOPE), null);
});

Deno.test("a late successful probe cannot erase a newer 429 or release another owner's lease", async () => {
  const store = new MemoryStore();
  const time = clock();
  const guard = createXeroCooldownGuard(store, time);
  await guard.afterResponse(SCOPE, null, limited("0"));
  const first = await guard.beforeRequest(SCOPE);
  time.advance(46);
  const second = await guard.beforeRequest(SCOPE);
  await guard.afterResponse(SCOPE, first, new Response(null, { status: 200 }));
  assertEquals((await store.read(SCOPE))?.probe?.owner, second);
  await guard.afterResponse(SCOPE, null, limited("200"));
  const deadline = (await store.read(SCOPE))?.blocked_until;
  await guard.afterResponse(SCOPE, second, new Response(null, { status: 200 }));
  assertEquals((await store.read(SCOPE))?.blocked_until, deadline);
  await assertRejects(
    () => guard.beforeRequest(SCOPE),
    XeroCooldownError,
    "active",
  );
});

Deno.test("app and tenant scopes remain independent and fallback deadlines are labelled", async () => {
  const store = new MemoryStore();
  const time = clock();
  const guard = createXeroCooldownGuard(store, time);
  await guard.afterResponse(SCOPE, null, new Response(null, { status: 429 }));
  assertEquals(
    (await store.read(SCOPE))?.observation?.deadline_source,
    "local_60s_fallback",
  );
  assertEquals((await store.read(SCOPE))?.observation?.retry_at, null);
  assertEquals(
    await guard.beforeRequest({ ...SCOPE, tenantId: "other-tenant" }),
    null,
  );
  assertEquals(
    await guard.beforeRequest({ ...SCOPE, appKey: "other-app" }),
    null,
  );
});

Deno.test("database failures fail closed before HTTP and 429 persistence failure is explicit", async () => {
  const store = new MemoryStore();
  const time = clock();
  let calls = 0;
  const request = createXeroCooldownFetch({
    store,
    orgId: SCOPE.orgId,
    appKey: SCOPE.appKey,
    now: time.now,
    fetchFn: () => {
      calls++;
      return Promise.resolve(limited());
    },
  });
  const init = {
    headers: {
      "Xero-tenant-id": SCOPE.tenantId,
      Authorization: "Bearer never-stored",
    },
  };
  store.failRead = true;
  const unavailable = await assertRejects(
    () => request("https://api.xero.com/api.xro/2.0/Invoices", init),
    XeroCooldownError,
  );
  assertEquals(unavailable.status, 503);
  assertEquals(calls, 0);
  store.failRead = false;
  store.failWrite = true;
  const failedSave = await assertRejects(
    () => request("https://api.xero.com/api.xro/2.0/Invoices", init),
    XeroCooldownError,
  );
  assertEquals(failedSave.status, 429);
  assertEquals(failedSave.code, "XERO_COOLDOWN_PERSISTENCE_FAILED");
  assertEquals(failedSave.details.shared_guard, false);
  assertEquals(calls, 1);
  assertEquals(
    JSON.stringify([...store.rows.values()]).includes("never-stored"),
    false,
  );
});

Deno.test("successful financial response is preserved if owned-probe release storage fails", async () => {
  const store = new MemoryStore();
  const time = clock();
  await createXeroCooldownGuard(store, time).afterResponse(
    SCOPE,
    null,
    limited("0"),
  );
  let diagnostics = 0;
  const request = createXeroCooldownFetch({
    store,
    orgId: SCOPE.orgId,
    appKey: SCOPE.appKey,
    now: time.now,
    onPersistenceFailure: () => {
      diagnostics++;
    },
    fetchFn: (_input, init) => {
      assertEquals(
        new Headers(init?.headers).get("Idempotency-Key"),
        "stable-create-key",
      );
      store.failWrite = true;
      return Promise.resolve(
        Response.json({ Invoices: [{ InvoiceID: "existing-created-id" }] }),
      );
    },
  });
  const response = await request("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "PUT",
    headers: {
      "Xero-tenant-id": SCOPE.tenantId,
      "Idempotency-Key": "stable-create-key",
    },
    body: "{}",
  });
  assertEquals(response.status, 200);
  assertEquals(
    (await response.json()).Invoices[0].InvoiceID,
    "existing-created-id",
  );
  assertEquals(xeroCooldownReport(response)?.probe_released, false);
  assertEquals(diagnostics, 1);
});

Deno.test("transport shares hold between JSON and PDF and never queues or retries", async () => {
  const store = new MemoryStore();
  const time = clock();
  let calls = 0;
  const options = {
    store,
    orgId: SCOPE.orgId,
    appKey: SCOPE.appKey,
    now: time.now,
    fetchFn: () => {
      calls++;
      return Promise.resolve(limited());
    },
  };
  const jsonRead = createXeroCooldownFetch(options);
  const pdfRead = createXeroCooldownFetch(options);
  const url = "https://api.xero.com/api.xro/2.0/Invoices";
  const response = await jsonRead(url, {
    headers: { "Xero-tenant-id": SCOPE.tenantId },
  });
  assertEquals(response.status, 429);
  assertEquals(xeroCooldownReport(response)?.persisted, true);
  await assertRejects(
    () =>
      pdfRead(url, {
        headers: {
          "Xero-tenant-id": SCOPE.tenantId,
          Accept: "application/pdf",
        },
      }),
    XeroCooldownError,
  );
  assertEquals(calls, 1);
});

Deno.test("org_config adapter uses insert-once and atomic revision-qualified update without a migration", async () => {
  const observed: Array<{ method: string; args: unknown[] }> = [];
  let result: { data: unknown; error: unknown } = { data: null, error: null };
  // deno-lint-ignore no-explicit-any
  const query: any = {};
  for (const method of ["select", "eq", "abortSignal", "insert", "update"]) {
    query[method] = (...args: unknown[]) => {
      observed.push({ method, args });
      return query;
    };
  }
  query.maybeSingle = () => Promise.resolve(result);
  const store = createOrgConfigXeroCooldownStore({
    from: (table: string) => {
      assertEquals(table, "org_config");
      return query;
    },
  });
  const state: XeroCooldownState = {
    version: 1,
    revision: "new-revision",
    blocked_until: null,
    observation: null,
    probe: null,
  };
  result = { data: { config_value: state }, error: null };
  assertEquals(await store.compareAndSwap(SCOPE, "old-revision", state), true);
  assertEquals(
    observed.some((op) =>
      op.method === "eq" && op.args[0] === "config_value->>revision" &&
      op.args[1] === "old-revision"
    ),
    true,
  );
  result = { data: null, error: { code: "23505" } };
  assertEquals(await store.compareAndSwap(SCOPE, null, state), false);
  result = { data: null, error: { code: "42501" } };
  await assertRejects(() => store.read(SCOPE), XeroCooldownError);
  assertEquals(observed.some((op) => op.method === "insert"), true);
  assertEquals(observed.some((op) => op.method === "update"), true);
});

Deno.test("legacy90s transport retains its owned probe beyond a30s sync request budget", async () => {
  const store = new MemoryStore();
  const time = clock();
  await createXeroCooldownGuard(store, time).afterResponse(
    SCOPE,
    null,
    limited("0"),
  );
  let finish!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = createXeroCooldownFetch({
    store,
    orgId: SCOPE.orgId,
    appKey: SCOPE.appKey,
    now: time.now,
    timeoutMs: 90_000,
    fetchFn: () => {
      started();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = request("https://api.xero.com/api.xro/2.0/Invoices", {
    headers: { "Xero-tenant-id": SCOPE.tenantId },
  });
  await entered;
  assertEquals(
    (await store.read(SCOPE))?.probe?.until,
    new Date(BASE + 105_000).toISOString(),
  );
  time.advance(91);
  const refused = await assertRejects(
    () => createXeroCooldownGuard(store, time).beforeRequest(SCOPE),
    XeroCooldownError,
  );
  assertEquals(refused.code, "XERO_PROBE_IN_PROGRESS");
  assertEquals(refused.details.provider_call_made, false);
  finish(new Response(null, { status: 200 }));
  await pending;
});

Deno.test("caller timeout and abort signals are enforced without retry", async () => {
  let calls = 0;
  const request = createXeroCooldownFetch({
    store: new MemoryStore(),
    orgId: SCOPE.orgId,
    appKey: SCOPE.appKey,
    timeoutMs: 1,
    fetchFn: (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else {init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason), { once: true });}
      });
    },
  });
  await assertRejects(() =>
    request("https://api.xero.com/api.xro/2.0/Invoices", {
      headers: { "Xero-tenant-id": SCOPE.tenantId },
    })
  );
  assertEquals(calls, 1);
  const abort = new AbortController();
  abort.abort(new Error("caller cancelled"));
  const error = await assertRejects(() =>
    request("https://api.xero.com/api.xro/2.0/Invoices", {
      headers: { "Xero-tenant-id": SCOPE.tenantId },
      signal: abort.signal,
    })
  );
  assertEquals((error as Error).message, "caller cancelled");
  assertEquals(calls, 2);
});
