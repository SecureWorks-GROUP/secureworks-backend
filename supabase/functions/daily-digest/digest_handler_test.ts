/**
 * P0-14 (17 Nov 2026), through the real request handler: a screen or an agent
 * reads the stored digest; only a server caller builds; completion packs keep
 * their present triggers; weekly pieces run on a Perth Monday; the test chats
 * run only from their own weekly call.
 *
 * Every outside call is answered by a fetch spy. Background work the handler
 * hands to EdgeRuntime.waitUntil is collected and awaited inside the spy.
 * All names, numbers and ids are synthetic.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";

const SERVICE_KEY = "test-service-role-key";
const SW_API_KEY = "test-sw-api-key";
const STAFF_TOKEN = "staff-session-token";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "OPS_AGENT_SERVER_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SECRET_KEYS",
];
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SW_API_KEY,
  ANTHROPIC_API_KEY: "test-model-key",
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = BASE_ENV[name];
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

type Mod = typeof import("./index.ts");
let modPromise: Promise<Mod> | null = null;
function mod(): Promise<Mod> {
  modPromise ??= withEnv(() => import("./index.ts"));
  return modPromise;
}

type FetchCall = { url: URL; method: string; body: any };
type Rows = (url: URL) => unknown[] | null;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const table = (url: URL) => url.pathname.split("/rest/v1/")[1];

/** Runs fn with a fetch spy and a waitUntil collector; awaits the background work before returning. */
async function withSpy<T>(
  rows: Rows,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<{ result: T; calls: FetchCall[] }> {
  const calls: FetchCall[] = [];
  const pending: Promise<unknown>[] = [];
  const g = globalThis as any;
  const originalFetch = globalThis.fetch;
  const originalRuntime = g.EdgeRuntime;
  g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      (init?.method ?? (input instanceof Request ? input.method : "GET"))
        .toUpperCase();
    const headers = new Headers(init?.headers);
    let body: any = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch { /* keep raw */ }
    }
    calls.push({ url, method, body });
    const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (url.pathname === "/auth/v1/user") {
      return Promise.resolve(
        headers.get("authorization") === `Bearer ${STAFF_TOKEN}`
          ? json({
            id: "staff-user-1",
            aud: "authenticated",
            role: "authenticated",
          })
          : json({ msg: "invalid token" }, 401),
      );
    }
    if (url.pathname.includes("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        return Promise.resolve(json(one ? null : [], 201));
      }
      const found = rows(url) ?? [];
      return Promise.resolve(json(one ? (found[0] ?? null) : found));
    }
    if (url.hostname === "api.anthropic.com") {
      return Promise.resolve(
        json({ content: [{ type: "text", text: "Synthetic model text." }] }),
      );
    }
    return Promise.resolve(json({ success: true, content: [] }));
  }) as typeof fetch;
  try {
    const result = await fn(calls);
    while (pending.length) await Promise.allSettled(pending.splice(0));
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    g.EdgeRuntime = originalRuntime;
  }
}

function request(
  opts: { method?: string; action?: string; auth?: Record<string, string> },
): Request {
  const query = opts.action ? `?action=${opts.action}` : "";
  const method = opts.method ?? "GET";
  return new Request(`https://example.invalid/daily-digest${query}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.auth ?? {}) },
    body: method === "GET" ? undefined : "{}",
  });
}
const serviceAuth = { authorization: `Bearer ${SERVICE_KEY}` };
const staffAuth = { authorization: `Bearer ${STAFF_TOKEN}` };
const apiKeyAuth = { "x-api-key": SW_API_KEY };

const packCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.pathname.endsWith("/functions/v1/completion-pack"));
const modelCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.hostname === "api.anthropic.com");
const opsAiCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.pathname.endsWith("/functions/v1/ops-ai"));
const webhookCalls = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.hostname === "hooks.invalid");
const writes = (calls: FetchCall[], name?: string) =>
  calls.filter((c) =>
    c.url.pathname.includes("/rest/v1/") && c.method !== "GET" &&
    c.method !== "HEAD" && (!name || table(c.url) === name)
  );
const firstBody = (
  c: FetchCall | undefined,
) => (Array.isArray(c?.body) ? c!.body[0] : c?.body);

// ── Fixtures ──────────────────────────────────────────────────

const STORED_DIGEST = {
  date: "2026-11-16",
  status: "amber",
  summary_text: "Synthetic summary",
  alerts: [{
    severity: "amber",
    category: "Cash",
    title: "Synthetic alert",
    action: "Look",
  }],
  ai_narrative: "Synthetic narrative",
};
const PAID_UNSENT_JOB = "aaaaaaaa-0000-4000-8000-000000000001";
const PAID_SENT_JOB = "bbbbbbbb-0000-4000-8000-000000000002";
const UNPAID_JOB = "cccccccc-0000-4000-8000-000000000003";

function digestRows(
  opts: {
    stored?: boolean;
    webhook?: boolean;
    packJobs?: boolean;
    canaryRanAt?: string;
  } = {},
): Rows {
  return (url) => {
    const t = table(url);
    const p = url.searchParams;
    if (t === "daily_digests") {
      return opts.stored === false
        ? []
        : [{ digest_date: "2026-11-16", digest_json: STORED_DIGEST }];
    }
    // The completion pack trigger's jobs read (no `legacy` filter).
    if (
      t === "jobs" && p.get("status") === "eq.complete" &&
      p.has("completed_at") && !p.has("legacy")
    ) {
      return opts.packJobs === false ? [] : [
        { id: PAID_UNSENT_JOB, job_number: "SWF-90001" },
        { id: PAID_SENT_JOB, job_number: "SWF-90002" },
        { id: UNPAID_JOB, job_number: "SWF-90003" },
      ];
    }
    // The trigger's paged read of paid invoices.
    if (
      t === "xero_invoices" && p.get("status") === "eq.PAID" &&
      p.get("fully_paid_on") === "not.is.null" && !p.has("reference")
    ) {
      const paidOn = new Date(Date.now() - 5 * 86_400_000).toISOString();
      return [{ reference: "SWF-90001 final", fully_paid_on: paidOn }, {
        reference: "SWF-90002 final",
        fully_paid_on: paidOn,
      }];
    }
    if (
      t === "business_events" &&
      p.get("event_type") === "eq.job.completion_pack_sent"
    ) {
      return (p.get("entity_id") ?? "").includes(PAID_SENT_JOB)
        ? [{ entity_id: PAID_SENT_JOB }]
        : [];
    }
    if (t === "org_config" && p.get("config_key") === "eq.digest_webhook_url") {
      return opts.webhook
        ? [{
          config_value: { enabled: true, url: "https://hooks.invalid/digest" },
        }]
        : [];
    }
    if (t === "org_config" && p.get("config_key") === "eq.digest_canary_last") {
      return opts.canaryRanAt
        ? [{
          config_value: {
            ran_at: opts.canaryRanAt,
            passed: 9,
            failed: 1,
            results: [{ id: "x", passed: false }],
          },
        }]
        : [];
    }
    return null;
  };
}

// 17 Nov 2026 03:00 UTC is a Tuesday in Perth. 15 Nov 23:00 UTC (a Sunday in
// UTC) is the Monday 07:00 build in Perth.
const PERTH_TUESDAY = new Date("2026-11-17T03:00:00.000Z");
const PERTH_MONDAY_BUILD = new Date("2026-11-15T23:00:00.000Z");
const PERTH_MONDAY_CANARY = new Date("2026-11-15T21:30:00.000Z");

async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
  const time = new FakeTime(when);
  try {
    return await fn();
  } finally {
    time.restore();
  }
}

// ── A screen or agent reads; nothing is built ─────────────────

for (
  const [label, opts] of [
    ["a staff page GET", { method: "GET", auth: staffAuth }],
    ["a staff POST", { method: "POST", auth: staffAuth }],
    ["a server GET with no action", { method: "GET", auth: serviceAuth }],
    ["an api-key GET (the agent tool)", { method: "GET", auth: apiKeyAuth }],
    ["action=latest", { method: "GET", action: "latest", auth: staffAuth }],
    ["an unknown action", {
      method: "GET",
      action: "whatever",
      auth: staffAuth,
    }],
  ] as const
) {
  Deno.test(`${label} returns the stored digest and builds nothing`, async () => {
    const m = await mod();
    m._resetPackCheckForTest();
    await withEnv(async () => {
      const { calls } = await withSpy(
        digestRows({ webhook: true, packJobs: false }),
        async () => {
          const res = await m._dailyDigestRequestHandlerForTest(request(opts));
          assertEquals(res.status, 200);
          assertEquals(res.headers.get("x-sw-digest-mode"), "stored");
          const body = await res.json();
          assertEquals(body.alerts, STORED_DIGEST.alerts);
          assertEquals(body.ai_narrative, STORED_DIGEST.ai_narrative);
          assertEquals(body.stored, true);
          assertEquals(body.digest_date, "2026-11-16");
        },
      );
      assertEquals(modelCalls(calls), []);
      assertEquals(opsAiCalls(calls), []);
      assertEquals(webhookCalls(calls), []);
      assertEquals(writes(calls), []);
      // One digest read; the rest is the completion pack check's reads.
      const reads = calls.filter((c) => c.url.pathname.includes("/rest/v1/"))
        .map((c) => table(c.url));
      assertEquals(reads.filter((t) => t === "daily_digests").length, 1);
      for (const t of reads) {
        assert(
          ["daily_digests", "jobs"].includes(t),
          `unexpected read of ${t}`,
        );
      }
    });
  });
}

Deno.test("with no stored digest the read says not built yet", async () => {
  const m = await mod();
  await withEnv(async () => {
    const { calls } = await withSpy(
      digestRows({ stored: false, packJobs: false }),
      async () => {
        const res = await m._dailyDigestRequestHandlerForTest(
          request({ auth: staffAuth }),
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.not_built_yet, true);
        assertEquals(body.alerts, []);
        assertEquals(body.digest_date, null);
      },
    );
    assertEquals(modelCalls(calls), []);
  });
});

// ── Only a server caller builds ───────────────────────────────

for (const action of ["build", "canary"]) {
  Deno.test(`a staff login may not run action=${action}`, async () => {
    const m = await mod();
    await withEnv(async () => {
      const { calls } = await withSpy(digestRows(), async () => {
        const res = await m._dailyDigestRequestHandlerForTest(
          request({ method: "POST", action, auth: staffAuth }),
        );
        assertEquals(res.status, 403);
        assertEquals((await res.json()).code, "server_key_required");
      });
      assertEquals(packCalls(calls), []);
      assertEquals(modelCalls(calls), []);
      assertEquals(opsAiCalls(calls), []);
      assertEquals(writes(calls), []);
    });
  });
}

Deno.test("an unsigned call is refused", async () => {
  const m = await mod();
  await withEnv(async () => {
    const { calls } = await withSpy(digestRows(), async () => {
      const res = await m._dailyDigestRequestHandlerForTest(
        request({ method: "POST", action: "build" }),
      );
      assertEquals(res.status, 401);
      await res.body?.cancel();
    });
    assertEquals(packCalls(calls), []);
  });
});

// ── Completion packs: same jobs, same triggers ────────────────

Deno.test("the build sends the completion pack for the paid, unsent job only, and posts the webhook", async () => {
  const m = await mod();
  await at(PERTH_TUESDAY, () =>
    withEnv(async () => {
      const { calls } = await withSpy(
        digestRows({ webhook: true }),
        async () => {
          const res = await m._dailyDigestRequestHandlerForTest(
            request({ method: "POST", action: "build", auth: serviceAuth }),
          );
          assertEquals(res.status, 200);
          assertEquals(res.headers.get("x-sw-digest-mode"), "build");
          await res.body?.cancel();
        },
      );
      const packs = packCalls(calls);
      assertEquals(packs.length, 1);
      assertEquals(packs[0].method, "POST");
      assertEquals(packs[0].body, { job_id: PAID_UNSENT_JOB });
      const events = writes(calls, "business_events").map(firstBody).filter((
        b,
      ) => b?.event_type === "job.completion_pack_sent");
      assertEquals(events, [{
        event_type: "job.completion_pack_sent",
        source: "daily-digest/completion_pack",
        entity_type: "job",
        entity_id: PAID_UNSENT_JOB,
        payload: { job_number: "SWF-90001" },
      }]);
      assertEquals(webhookCalls(calls).length, 1);
      // Stamped with when it was built, for the screens' Perth day.
      assertEquals(
        firstBody(
          writes(calls, "daily_digests").find((c) => c.method === "POST"),
        ).digest_json.built_at,
        PERTH_TUESDAY.toISOString(),
      );
      assertEquals(
        writes(calls, "daily_digests").filter((c) => c.method === "POST")
          .length,
        1,
      );
    }));
});

Deno.test("the old timer's shape (server POST, no action) still builds", async () => {
  const m = await mod();
  await at(PERTH_TUESDAY, () =>
    withEnv(async () => {
      const { calls } = await withSpy(
        digestRows({ packJobs: false }),
        async () => {
          const res = await m._dailyDigestRequestHandlerForTest(
            request({ method: "POST", auth: serviceAuth }),
          );
          assertEquals(res.status, 200);
          assertEquals(res.headers.get("x-sw-digest-mode"), "build");
          await res.body?.cancel();
        },
      );
      assertEquals(
        writes(calls, "daily_digests").filter((c) => c.method === "POST")
          .length,
        1,
      );
    }));
});

Deno.test("the stored read runs the completion pack check at most every 30 minutes per instance", async () => {
  const m = await mod();
  m._resetPackCheckForTest();
  const time = new FakeTime(PERTH_TUESDAY);
  try {
    await withEnv(async () => {
      const read = async () =>
        (await withSpy(digestRows(), async () => {
          const res = await m._dailyDigestRequestHandlerForTest(
            request({ auth: staffAuth }),
          );
          await res.body?.cancel();
        })).calls;

      const first = await read();
      assertEquals(packCalls(first).map((c) => c.body), [{
        job_id: PAID_UNSENT_JOB,
      }]);

      time.tick(29 * 60 * 1000);
      const second = await read();
      assertEquals(packCalls(second), []);
      assertEquals(second.filter((c) => table(c.url) === "jobs"), []);

      time.tick(60 * 1000);
      const third = await read();
      // Checked again; the fixture's sent-event list does not know about the
      // first send, so it would trigger again here, as the old loop would.
      assertEquals(third.filter((c) => table(c.url) === "jobs").length, 1);
      // None of the reads built anything.
      for (const calls of [first, second, third]) {
        assertEquals(modelCalls(calls), []);
      }
    });
  } finally {
    time.restore();
  }
});

// ── Weekly pieces and the test chats ─────────────────────────

async function buildAt(when: Date, rows: Rows) {
  const m = await mod();
  return await at(
    when,
    () =>
      withEnv(async () =>
        (await withSpy(rows, async () => {
          const res = await m._dailyDigestRequestHandlerForTest(
            request({ method: "POST", action: "build", auth: serviceAuth }),
          );
          assertEquals(res.status, 200);
          await res.body?.cancel();
        })).calls
      ),
  );
}

Deno.test("an ordinary-day build runs no weekly piece and no test chat", async () => {
  const calls = await buildAt(PERTH_TUESDAY, digestRows({ packJobs: false }));
  assertEquals(opsAiCalls(calls), []);
  const stored = firstBody(
    writes(calls, "daily_digests").find((c) => c.method === "POST"),
  );
  assertEquals(stored.digest_json.weekly_letter, undefined);
  assertEquals(
    calls.filter((c) =>
      (c.url.searchParams.get("config_key") ?? "") === "eq.digest_canary_last"
    ),
    [],
  );
  // Narrative, coaching and the financial snapshot. Recorded, not a target.
  assertEquals(modelCalls(calls).length, 3);
});

Deno.test("Monday's build (Sunday 23:00 UTC) writes the letter from the stored test chat result, and runs no test chat", async () => {
  const ranAt = new Date(PERTH_MONDAY_BUILD.getTime() - 90 * 60 * 1000)
    .toISOString();
  const calls = await buildAt(
    PERTH_MONDAY_BUILD,
    digestRows({ packJobs: false, canaryRanAt: ranAt }),
  );
  assertEquals(opsAiCalls(calls), []);
  const stored = firstBody(
    writes(calls, "daily_digests").find((c) => c.method === "POST"),
  );
  assertEquals(stored.digest_json.weekly_letter, "Synthetic model text.");
  assertEquals(stored.digest_json.canary_results?.passed, 9);
  // Ordinary day's three, plus the pulse and the letter. The observation report
  // is a sixth on a Monday with chat logs to read; this fixture has none.
  assertEquals(modelCalls(calls).length, 5);
});

Deno.test("Monday's build leaves out a test chat result older than 6 hours", async () => {
  const ranAt = new Date(PERTH_MONDAY_BUILD.getTime() - 7 * 60 * 60 * 1000)
    .toISOString();
  const calls = await buildAt(
    PERTH_MONDAY_BUILD,
    digestRows({ packJobs: false, canaryRanAt: ranAt }),
  );
  const stored = firstBody(
    writes(calls, "daily_digests").find((c) => c.method === "POST"),
  );
  assertEquals(stored.digest_json.canary_results, undefined);
});

Deno.test("action=canary runs the ten test chats on a Perth Monday, stores the result, and builds nothing", async () => {
  const m = await mod();
  await at(PERTH_MONDAY_CANARY, () =>
    withEnv(async () => {
      const { calls } = await withSpy(
        digestRows({ webhook: true }),
        async () => {
          const res = await m._dailyDigestRequestHandlerForTest(
            request({ method: "POST", action: "canary", auth: serviceAuth }),
          );
          assertEquals(res.status, 200);
          assertEquals((await res.json()).ok, true);
        },
      );
      assertEquals(opsAiCalls(calls).length, 10);
      const saved = writes(calls, "org_config").map(firstBody);
      assertEquals(saved.length, 1);
      assertEquals(saved[0].config_key, "digest_canary_last");
      assertEquals(
        saved[0].config_value.ran_at,
        PERTH_MONDAY_CANARY.toISOString(),
      );
      assertEquals(packCalls(calls), []);
      assertEquals(modelCalls(calls), []);
      assertEquals(webhookCalls(calls), []);
      assertEquals(calls.filter((c) => table(c.url) === "daily_digests"), []);
    }));
});

// ── Annotation checks in bulk ─────────────────────────────────

Deno.test("annotation existence is one read, and an active one is not written again", async () => {
  const completed = Array.from({ length: 12 }, (_, i) => ({
    id: `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
    status: "complete",
    client_name: `Client ${i}`,
    job_number: `SWF-8${String(i).padStart(4, "0")}`,
    site_suburb: "Suburb",
    type: "fencing",
    pricing_json: { total: 1000 },
    completed_at: new Date(Date.UTC(2026, 9, 1)).toISOString(),
  }));
  const already = `digest:completed_not_invoiced:${completed[0].id}`;
  const base = digestRows({ packJobs: false });
  const rows: Rows = (url) => {
    const p = url.searchParams;
    if (table(url) === "jobs" && (p.get("status") ?? "").startsWith("not.in")) {
      return completed;
    }
    if (
      table(url) === "ai_annotations" && p.get("source_ref") === "like.digest:%"
    ) return [{ source_ref: already }];
    return base(url);
  };
  const calls = await buildAt(PERTH_TUESDAY, rows);
  const refReads = calls.filter((c) =>
    c.method === "GET" && table(c.url) === "ai_annotations" &&
    (c.url.searchParams.get("source_ref") ?? "").length > 0
  );
  assertEquals(refReads.map((c) => c.url.searchParams.get("source_ref")), [
    "like.digest:%",
  ]);
  const inserted = writes(calls, "ai_annotations")
    .filter((c) => c.method === "POST")
    .flatMap((c) => (Array.isArray(c.body) ? c.body : [c.body]))
    .filter((r) => r?.annotation_type === "completed_not_invoiced")
    .map((r) => r.source_ref);
  assert(
    inserted.length > 0,
    "the fixture made no completed_not_invoiced findings",
  );
  assert(!inserted.includes(already), "an active annotation was written again");
});
