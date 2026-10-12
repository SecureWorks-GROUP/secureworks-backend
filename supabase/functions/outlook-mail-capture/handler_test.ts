// Slice EM2: the reader's HTTP door and its wiring to the database. The
// database side is a fake supabase client that records every call; no Graph
// call is made because the flags read off.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleCapture, liveCaptureDeps, sameSecret } from "./handler.ts";
import type { CaptureResult } from "./capture.ts";

const SERVICE = "service-key-fixture";
const SERVER = "server-key-fixture";
const env = (name: string) =>
  ({ SUPABASE_SERVICE_ROLE_KEY: SERVICE, SW_API_KEY: SERVER } as Record<
    string,
    string
  >)[name];

function b64url(o: unknown): string {
  return btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  );
}
const serviceJwt = `${b64url({ alg: "HS256" })}.${
  b64url({ role: "service_role" })
}.sig`;
const anonJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "anon" })}.sig`;

function fakeSupabase(flags: { reader: boolean; program: boolean }) {
  const calls: Array<{ kind: string; name: string; args?: unknown }> = [];
  return {
    calls,
    rpc(name: string, args?: unknown) {
      calls.push({ kind: "rpc", name, args });
      if (name === "context_email_reader_flags") {
        return Promise.resolve({
          data: { ...flags, schedule: false },
          error: null,
        });
      }
      if (name === "automation_lane_enabled") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "capture_business_event") {
        return Promise.resolve({
          data: { outcome: "inserted", id: "e1" },
          error: null,
        });
      }
      if (name === "record_capture_run") {
        return Promise.resolve({ data: { run_id: "r1" }, error: null });
      }
      if (name.startsWith("context_email_")) {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: { code: "42883" } });
    },
    from(table: string) {
      calls.push({ kind: "from", name: table });
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => Promise.resolve({ data: [], error: null }),
        upsert: () => Promise.resolve({ error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
      };
      return q;
    },
    storage: {
      from: () => ({ upload: () => Promise.resolve({ error: null }) }),
    },
  };
}

function req(
  headers: Record<string, string>,
  body: unknown = {},
  method = "POST",
) {
  return new Request("https://x.example/functions/v1/outlook-mail-capture", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const idle: CaptureResult = { outcome: "idle", reason: "email_reader_v1_off" };

Deno.test("only the service role or the exact server key may call", async () => {
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ reader: false, program: false }),
  };
  const run = () => Promise.resolve(idle);
  assertEquals((await handleCapture(req({}), deps, run)).status, 401);
  assertEquals(
    (await handleCapture(
      req({ authorization: `Bearer ${anonJwt}` }),
      deps,
      run,
    )).status,
    401,
  );
  assertEquals(
    (await handleCapture(req({ "x-api-key": "wrong" }), deps, run)).status,
    401,
  );
  assertEquals(
    (await handleCapture(
      req({ authorization: `Bearer ${SERVICE}` }, { wait: true }),
      deps,
      run,
    )).status,
    200,
  );
  assertEquals(
    (await handleCapture(
      req({ authorization: `Bearer ${serviceJwt}` }, { wait: true }),
      deps,
      run,
    )).status,
    200,
  );
  assertEquals(
    (await handleCapture(
      req({ authorization: `Bearer ${anonJwt}`, "x-api-key": SERVER }, {
        wait: true,
      }),
      deps,
      run,
    )).status,
    200,
  );
  assertEquals(
    (await handleCapture(
      req({ authorization: `Bearer ${SERVICE}` }, {}, "GET"),
      deps,
      run,
    )).status,
    405,
  );
  assert(
    sameSecret("a", "a") && !sameSecret("a", "b") && !sameSecret("a", "ab"),
  );
});

Deno.test("mode and source pass through; a bad mode is refused before any run", async () => {
  const seen: unknown[] = [];
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ reader: false, program: false }),
  };
  const run = (_d: unknown, r: unknown) => {
    seen.push(r);
    return Promise.resolve(idle);
  };
  await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, {
      wait: true,
      mode: "history",
      source: "nithin",
      from: "a",
      to: "b",
    }),
    deps,
    run,
  );
  assertEquals(seen, [{
    mode: "history",
    source: "nithin",
    from: "a",
    to: "b",
  }]);
  const bad = await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, { mode: "send" }),
    deps,
    run,
  );
  assertEquals(bad.status, 400);
  assertEquals(seen.length, 1);
});

Deno.test("without wait the run continues in the background and the reply is 202", async () => {
  const pending: Promise<unknown>[] = [];
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ reader: false, program: false }),
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };
  const res = await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, { mode: "poll" }),
    deps,
    () => Promise.resolve(idle),
  );
  assertEquals(res.status, 202);
  assertEquals(pending.length, 1);
});

Deno.test("live wiring: flags off reads as idle and touches no mailbox", async () => {
  const sb = fakeSupabase({ reader: false, program: true });
  const graphCalls: string[] = [];
  const res = await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, { wait: true }),
    {
      env,
      createSupabase: () => sb,
      fetch: ((u: string) => {
        graphCalls.push(String(u));
        return Promise.resolve(new Response("{}"));
      }) as unknown as typeof fetch,
    },
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    outcome: "idle",
    reason: "email_reader_v1_off",
  });
  assertEquals(graphCalls, []);
  assertEquals(sb.calls.map((c) => c.name), ["context_email_reader_flags"]);
});

Deno.test("live wiring: a flags read error reads as off", async () => {
  const sb = fakeSupabase({ reader: true, program: true });
  sb.rpc = () =>
    Promise.resolve({ data: null, error: { code: "42883" } }) as any;
  const d = liveCaptureDeps({ env, createSupabase: () => sb });
  assertEquals(await d.flags(), { reader: false, program: false });
});

Deno.test("live wiring: the old-path lookup calls context_email_legacy_copy and reads an id, null or a fault", async () => {
  const sb = fakeSupabase({ reader: true, program: true });
  const seen: unknown[] = [];
  let reply: { data: unknown; error: unknown } = { data: "old-1", error: null };
  sb.rpc = (name: string, args?: unknown) => {
    seen.push({ name, args });
    return Promise.resolve(reply) as any;
  };
  const d = liveCaptureDeps({ env, createSupabase: () => sb });
  const q = {
    from: "pat.example@example.com",
    receivedAt: "2026-10-02T05:50:00Z",
    subject: "Message 1",
  };
  assertEquals(await d.legacyCopy(q), "old-1");
  assertEquals(seen, [{
    name: "context_email_legacy_copy",
    args: {
      p_from: "pat.example@example.com",
      p_received_at: "2026-10-02T05:50:00Z",
      p_subject: "Message 1",
    },
  }]);
  reply = { data: null, error: null };
  assertEquals(await d.legacyCopy(q), null);
  reply = { data: null, error: { code: "42883" } };
  let code = "";
  try {
    await d.legacyCopy(q);
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  assertEquals(code, "legacy_copy_unreadable");
});

Deno.test("deep: the mode passes through, and a probe always waits for its answer (it writes nothing anywhere else)", async () => {
  const seen: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const probe: CaptureResult = {
    outcome: "probe",
    source_key: "nithin",
    kind: "user",
    from: "2025-07-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    complete: true,
    months: { "2025-07": { seen: 3, more: false } },
    folders: { inbox: 3, sent: 0, deleted: 0, skipped: 0 },
    oldest_seen: "2025-07-02T00:00:00.000Z",
    newest_seen: "2025-07-03T00:00:00.000Z",
    reads: 2,
    error_code: null,
  };
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ reader: true, program: true }),
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };
  const res = await handleCapture(
    req({ "x-api-key": SERVER }, {
      mode: "deep",
      probe: true,
      source: "nithin",
      from: "2025-07-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    }),
    deps,
    (_d: unknown, r: unknown) => {
      seen.push(r);
      return Promise.resolve(probe);
    },
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), probe);
  assertEquals(pending.length, 0);
  assertEquals(seen, [{
    mode: "deep",
    source: "nithin",
    from: "2025-07-01T00:00:00.000Z",
    to: "2026-10-01T00:00:00.000Z",
    probe: true,
  }]);
  // A deep load call from the tick runs in the background like any other,
  // and the plan's slice id passes through as it was sent.
  const bg = await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, {
      mode: "deep",
      source: "nithin",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
      slice: "2026-10-07T06:04:00.123Z",
      actor: "cron:outlook-mail-deep-history",
    }),
    deps,
    (_d: unknown, r: unknown) => {
      seen.push(r);
      return Promise.resolve(idle);
    },
  );
  assertEquals(bg.status, 202);
  assertEquals(pending.length, 1);
  await Promise.all(pending);
  assertEquals(seen.at(-1), {
    mode: "deep",
    source: "nithin",
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-06-01T00:00:00.000Z",
    slice: "2026-10-07T06:04:00.123Z",
  });
  // Anything but text is not a slice id.
  await handleCapture(
    req({ authorization: `Bearer ${SERVICE}` }, {
      wait: true,
      mode: "deep",
      source: "nithin",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-06-01T00:00:00.000Z",
      slice: 12,
    }),
    deps,
    (_d: unknown, r: unknown) => {
      seen.push(r);
      return Promise.resolve(idle);
    },
  );
  assert(!("slice" in (seen.at(-1) as Record<string, unknown>)));
});

Deno.test("live wiring: the deep gate and scope read their RPCs; the prefix set is read once and reads as unreadable on a fault", async () => {
  const sb = fakeSupabase({ reader: true, program: true });
  const seen: string[] = [];
  let gate: { data: unknown; error: unknown } = {
    data: {
      enabled: true,
      state: "present",
      hard_floor: "2024-12-31T16:00:00.000Z",
      user_window_max_days: 32,
    },
    error: null,
  };
  sb.rpc = (name: string) => {
    seen.push(name);
    if (name === "context_email_deep_enabled") {
      return Promise.resolve(gate) as any;
    }
    if (name === "context_email_deep_scope") {
      return Promise.resolve({
        data: {
          version: "email-deep-v1",
          jobs: 1,
          job_numbers: {},
          client_emails: {},
          builder_refs: { "KBA88123": "2026-01-01T00:00:00.000Z" },
        },
        error: null,
      }) as any;
    }
    return Promise.resolve({ data: null, error: { code: "42883" } }) as any;
  };
  let reads = 0;
  sb.from = (table: string) => {
    seen.push(`from:${table}`);
    const q: any = {
      select: () => q,
      eq: () => {
        reads++;
        return Promise.resolve({
          data: [{ parsing_rules: { ref_prefixes: ["KBA"] } }],
          error: null,
        });
      },
    };
    return q;
  };
  const d = liveCaptureDeps({ env, createSupabase: () => sb });
  assertEquals(await d.deepGate(), {
    enabled: true,
    hardFloorMs: Date.parse("2024-12-31T16:00:00.000Z"),
    userWindowMaxDays: 32,
  });
  const scope = await d.deepScope();
  assertEquals([...scope.builderRefs.keys()], ["KBA-88123"]);
  assertEquals(await d.builderRefPrefixes(), ["MLB", "AJBR", "MS", "KBA"]);
  assertEquals(reads, 1);
  gate = { data: null, error: { code: "42883" } };
  let code = "";
  try {
    await d.deepGate();
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  assertEquals(code, "deep_gate_unreadable");
  // A prefix read fault: null, so the reader uses the floor and counts it.
  const sb2 = fakeSupabase({ reader: true, program: true });
  sb2.from = () => {
    const q: any = {
      select: () => q,
      eq: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    };
    return q;
  };
  assertEquals(
    await liveCaptureDeps({ env, createSupabase: () => sb2 })
      .builderRefPrefixes(),
    null,
  );
});

Deno.test("live wiring: a copy of our own email goes to context_email_audience_resolve whole; anything but a known answer reads as error", async () => {
  const sb = fakeSupabase({ reader: true, program: true });
  const seen: unknown[] = [];
  let reply: unknown = {
    data: { outcome: "relabelled", id: "e1", basis: "mailbox_copy" },
    error: null,
  };
  sb.rpc = (name: string, args?: unknown) => {
    seen.push({ name, args });
    if (reply === "throw") throw new Error("network");
    return Promise.resolve(reply) as any;
  };
  const d = liveCaptureDeps({ env, createSupabase: () => sb });
  const row = {
    provider_message_id: "email:gma-x-0001@secureworkswa.com.au",
    payload: { folder_kind: "sent" },
  };
  assertEquals(await d.resolveAudience(row), "relabelled");
  assertEquals(seen, [{
    name: "context_email_audience_resolve",
    args: { p_row: row },
  }]);
  for (
    const outcome of [
      "confirmed",
      "unchanged",
      "not_found",
      "capture_disabled",
      "refused",
    ]
  ) {
    reply = { data: { outcome }, error: null };
    assertEquals<string>(await d.resolveAudience(row), outcome);
  }
  for (
    const bad of [
      { data: null, error: { code: "42883" } },
      { data: [], error: null },
      { data: { outcome: "something_else" }, error: null },
      { data: "relabelled", error: null },
      "throw",
    ]
  ) {
    reply = bad;
    assertEquals(await d.resolveAudience(row), "error");
  }
});
