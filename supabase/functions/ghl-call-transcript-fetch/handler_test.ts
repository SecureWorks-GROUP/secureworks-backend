// Slice T2: the fetcher's HTTP door. Service role only; the history load is a
// dry run unless the caller says dry_run: false; ids and codes only out.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleFetch, type HandlerDeps, type Runners } from "./handler.ts";
import type { BackfillRequest } from "./fetch.ts";

function jwt(role: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(
      /\//g,
      "_",
    );
  return `${b64({ alg: "HS256" })}.${b64({ role })}.sig`;
}

function setup() {
  const seen: { live: number; backfill: BackfillRequest[] } = {
    live: 0,
    backfill: [],
  };
  const runners: Runners = {
    live: () => {
      seen.live++;
      return Promise.resolve(
        { outcome: "idle", reason: "fetch_flag_off" } as const,
      );
    },
    backfill: (req) => {
      seen.backfill.push(req);
      return Promise.resolve(
        { outcome: "refused", reason: "fetch_flag_off" } as const,
      );
    },
  };
  const deps: HandlerDeps = {
    env: (n) => (n === "SUPABASE_SERVICE_ROLE_KEY" ? "service-key" : undefined),
    createSupabase: () => ({}),
  };
  return { seen, runners, deps };
}

function post(body: unknown, bearer?: string): Request {
  return new Request("https://x/functions/v1/ghl-call-transcript-fetch", {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    body: JSON.stringify(body),
  });
}

Deno.test("only the service role may call: the exact key or a service_role JWT (the cron's key)", async () => {
  const { seen, runners, deps } = setup();
  assertEquals((await handleFetch(post({}), deps, runners)).status, 401);
  assertEquals(
    (await handleFetch(post({}, jwt("anon")), deps, runners)).status,
    401,
  );
  assertEquals(
    (await handleFetch(post({}, jwt("authenticated")), deps, runners)).status,
    401,
  );
  assertEquals(seen.live, 0);
  assertEquals(
    (await handleFetch(post({ wait: true }, "service-key"), deps, runners))
      .status,
    200,
  );
  assertEquals(
    (await handleFetch(
      post({ wait: true }, jwt("service_role")),
      deps,
      runners,
    )).status,
    200,
  );
  assertEquals(seen.live, 2);
  const get = new Request("https://x/", { method: "GET" });
  assertEquals((await handleFetch(get, deps, runners)).status, 405);
});

Deno.test("the history load is a dry run unless dry_run is exactly false", async () => {
  const { seen, runners, deps } = setup();
  for (
    const body of [
      { mode: "backfill" },
      { mode: "backfill", dry_run: "false" },
      { mode: "backfill", dry_run: 0 },
    ]
  ) {
    await handleFetch(post(body, "service-key"), deps, runners);
  }
  await handleFetch(
    post({ mode: "backfill", dry_run: false, max_calls: 3 }, "service-key"),
    deps,
    runners,
  );
  assertEquals(seen.backfill.map((r) => r.dryRun), [true, true, true, false]);
  assertEquals(seen.backfill[3], { dryRun: false, maxCalls: 3 });
  assertEquals(seen.backfill[0], { dryRun: true, maxCalls: 40 });
});

Deno.test("a refused real history load answers 409; a bad page size or mode answers 400", async () => {
  const { runners, deps } = setup();
  const refused = await handleFetch(
    post({ mode: "backfill", dry_run: false }, "service-key"),
    deps,
    runners,
  );
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).reason, "fetch_flag_off");
  assertEquals(
    (await handleFetch(
      post({ mode: "backfill", max_calls: 0 }, "service-key"),
      deps,
      runners,
    )).status,
    400,
  );
  assertEquals(
    (await handleFetch(post({ mode: "other" }, "service-key"), deps, runners))
      .status,
    400,
  );
});
