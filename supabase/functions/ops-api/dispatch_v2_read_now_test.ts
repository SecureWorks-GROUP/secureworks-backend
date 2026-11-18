// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2 item 19: Read now (contract section 3j). Fake steps, no network.
//
// Run: deno test --allow-all supabase/functions/ops-api/dispatch_v2_read_now_test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_V2_READ_NOW_ACTION,
  mailFromCapture,
  makeReadNowRunner,
  outlookPollMail,
  READ_NOW_MAIL_CAP_MS,
  READ_NOW_REUSE_MS,
  type ReadNowDeps,
  repliesFromScan,
} from "./dispatch_v2_read_now.ts";

const T0 = Date.parse("2026-11-18T06:32:00Z");

function deps(over: Partial<ReadNowDeps> = {}) {
  const calls: string[] = [];
  let clock = T0;
  const d: ReadNowDeps & { calls: string[]; tick(ms: number): void } = {
    calls,
    tick(ms: number) {
      clock += ms;
    },
    now: () => clock,
    captureLaneOn: () => {
      calls.push("lane");
      return Promise.resolve(true);
    },
    pollMail: (cap) => {
      calls.push(`mail:${cap}`);
      return Promise.resolve({
        status: "read",
        emails_read: 3,
        mailboxes: 11,
        mailboxes_not_read: 0,
      });
    },
    scanReplies: () => {
      calls.push("scan");
      return Promise.resolve({
        ok: true,
        stored: 2,
        matched: 1,
        needs_confirmation: 1,
        unmatched: 0,
        suggestions: 1,
        cursor_sequence: 9,
      });
    },
    leftToSort: () => {
      calls.push("left");
      return Promise.resolve(4);
    },
    ...over,
  };
  return d;
}

Deno.test("read now: reads mail first, then the replies scan, then the tray count", async () => {
  const d = deps();
  const r = await makeReadNowRunner()(d);
  assertEquals(d.calls, ["lane", `mail:${READ_NOW_MAIL_CAP_MS}`, "scan", "left"]);
  assertEquals(r.lane, "on");
  assertEquals(r.mail, { status: "read", emails_read: 3, mailboxes: 11, mailboxes_not_read: 0 });
  assertEquals(r.replies, {
    status: "scanned",
    stored: 2,
    matched: 1,
    needs_confirmation: 1,
    unmatched: 0,
    suggestions: 1,
  });
  assertEquals(r.left_to_sort, 4);
  assertEquals(r.reused, false);
  assertEquals(r.read_at, "2026-11-18T06:32:00.000Z");
});

Deno.test("read now: a paused capture lane reads nothing and says so", async () => {
  const d = deps({ captureLaneOn: () => Promise.resolve(false) });
  const r = await makeReadNowRunner()(d);
  assertEquals(r.lane, "paused");
  assertEquals(r.mail, null);
  assertEquals(r.replies, null);
  assertEquals(d.calls, ["left"]);
});

Deno.test("read now: slow Outlook still runs the replies scan", async () => {
  const d = deps({ pollMail: () => Promise.resolve({ status: "slow" }) });
  const r = await makeReadNowRunner()(d);
  assertEquals(r.mail, { status: "slow" });
  assertEquals(r.replies?.status, "scanned");
});

Deno.test("read now: a mail step that throws is a failed line, and the scan still runs", async () => {
  const d = deps({ pollMail: () => Promise.reject(new Error("graph down")) });
  const r = await makeReadNowRunner()(d);
  assertEquals(r.mail, { status: "failed", code: "graph down" });
  assertEquals(r.replies?.status, "scanned");
});

Deno.test("read now: a failed scan or tray count never fails the press", async () => {
  const d = deps({
    scanReplies: () => Promise.reject(Object.assign(new Error("x"), { code: "scan_state_write" })),
    leftToSort: () => Promise.reject(new Error("down")),
  });
  const r = await makeReadNowRunner()(d);
  assertEquals(r.ok, true);
  assertEquals(r.replies, { status: "failed", code: "scan_state_write" });
  assertEquals(r.left_to_sort, null);
});

Deno.test("read now: the scan's flag off reads as off", () => {
  assertEquals(repliesFromScan({ ok: true, skipped: "flag_off" }), { status: "off" });
});

Deno.test("read now: a second press while one runs gets the same run back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  let scans = 0;
  const d = deps({
    scanReplies: async () => {
      scans++;
      await gate;
      return { ok: true, stored: 0 };
    },
  });
  const run = makeReadNowRunner();
  const a = run(d);
  const b = run(d);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assertEquals(scans, 1);
  assertEquals(ra.reused, false);
  assertEquals(rb.reused, true);
  assertEquals(rb.read_at, ra.read_at);
});

Deno.test("read now: a press within 30 seconds reuses the last answer; after that it runs again", async () => {
  const d = deps();
  const run = makeReadNowRunner();
  await run(d);
  d.tick(READ_NOW_REUSE_MS - 1000);
  const again = await run(d);
  assertEquals(again.reused, true);
  assertEquals(d.calls.filter((c) => c === "scan").length, 1);
  d.tick(2000);
  const fresh = await run(d);
  assertEquals(fresh.reused, false);
  assertEquals(d.calls.filter((c) => c === "scan").length, 2);
});

Deno.test("read now: the reader's answer is cut down to counts", () => {
  assertEquals(
    mailFromCapture(200, {
      outcome: "ran",
      mode: "poll",
      sources: [
        { source_key: "admin", outcome: "ran", counts: { inserted: 2, seen: 9 } },
        { source_key: "fencing", outcome: "busy" },
        { source_key: "ses", outcome: "ran", error_code: "graph_429", counts: { inserted: 1 } },
      ],
      not_reached: ["shaun"],
    }),
    { status: "read", emails_read: 3, mailboxes: 3, mailboxes_not_read: 3 },
  );
  assertEquals(mailFromCapture(200, { outcome: "idle", reason: "capture_lane_off" }), {
    status: "off",
    reason: "capture_lane_off",
  });
  assertEquals(mailFromCapture(401, { error: "service_key_required" }), {
    status: "failed",
    code: "reader_refused_key",
  });
  assertEquals(mailFromCapture(500, { outcome: "error", code: "rpc_threw" }), {
    status: "failed",
    code: "rpc_threw",
  });
  assertEquals(mailFromCapture(502, null), { status: "failed", code: "reader_http_502" });
});

Deno.test("read now: the live mail step posts the cron's poll and waits for it", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const poll = outlookPollMail({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "svc",
    fetchImpl: ((url: string, init: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(
        new Response(JSON.stringify({ outcome: "ran", sources: [], not_reached: [] }), { status: 200 }),
      );
    }) as any,
  });
  const r = await poll(1000);
  assertEquals(r, { status: "read", emails_read: 0, mailboxes: 0, mailboxes_not_read: 0 });
  assertEquals(seen!.url, "https://example.supabase.co/functions/v1/outlook-mail-capture");
  assertEquals((seen!.init.headers as any).Authorization, "Bearer svc");
  assertEquals(JSON.parse(String(seen!.init.body)), {
    mode: "poll",
    wait: true,
    actor: "dispatch-v2-read-now",
  });
});

Deno.test("read now: the live mail step says slow when Outlook does not answer in time", async () => {
  const poll = outlookPollMail({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "svc",
    fetchImpl: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as any,
  });
  assertEquals(await poll(20), { status: "slow" });
});

Deno.test("read now: not set up, or unreachable, is a failed line", async () => {
  assertEquals(await outlookPollMail({ supabaseUrl: "", serviceKey: "" })(10), {
    status: "failed",
    code: "reader_not_set_up",
  });
  const poll = outlookPollMail({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "svc",
    fetchImpl: (() => Promise.reject(new TypeError("dns"))) as any,
  });
  assertEquals(await poll(10), { status: "failed", code: "reader_unreachable" });
});

// ── The gate (index.ts) ─────────────────────────────────────────────────────

// index.ts reads SUPABASE_URL and the service key into module constants, so
// they are set before it is imported (a closed local port) and restored.
const SERVICE_KEY = "test-service-role-key";
const ROUTINE_KEY = "test-routine-key";
const IMPORT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>) {
  const saved = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
const index = await withEnv(IMPORT_ENV, () => import("./index.ts"));

Deno.test("gate: Read now is staff only and on no allow-list", () => {
  const url = new URL(
    `https://example.test/functions/v1/ops-api?action=${DISPATCH_V2_READ_NOW_ACTION}`,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      index._authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
      { ok: true },
    );
  }
  for (
    const authUser of [{ role: "installer" }, {
      role: "lead_installer",
      managedVerticals: ["fencing", "patio"],
    }]
  ) {
    const call = index._authorizeOpsApiAction({ url, authMode: "jwt", authUser }) as any;
    assertEquals([call.ok, call.status, call.code], [false, 403, "operator_access_required"]);
  }
  assert(!index.AGENT_READ_ALLOWED_ACTIONS.has(DISPATCH_V2_READ_NOW_ACTION));
  assert(!index.LEAD_INSTALLER_READ_ACTIONS.has(DISPATCH_V2_READ_NOW_ACTION));
});

Deno.test("gate: the routine key is refused and a GET is 405, before any read", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  const at = `https://example.invalid/ops-api?action=${DISPATCH_V2_READ_NOW_ACTION}`;
  try {
    await withEnv({ ...IMPORT_ENV, MAKESAFE_ROUTINE_KEY: ROUTINE_KEY }, async () => {
      const routine = await index._opsApiRequestHandlerForTest(
        new Request(at, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": ROUTINE_KEY },
          body: "{}",
        }),
      );
      assertEquals(routine.status, 403);
      await routine.body?.cancel();
      const get = await index._opsApiRequestHandlerForTest(
        new Request(at, {
          headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` },
        }),
      );
      assertEquals(get.status, 405);
      await get.body?.cancel();
    });
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = original;
  }
});
