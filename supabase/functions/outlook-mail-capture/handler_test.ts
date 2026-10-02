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
