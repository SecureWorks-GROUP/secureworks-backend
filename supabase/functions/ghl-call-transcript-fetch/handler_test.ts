// Slice T2: the fetcher's HTTP door. Service role only; the history load is a
// dry run unless the caller says dry_run: false; ids and codes only out.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ghlGet,
  handleFetch,
  type HandlerDeps,
  liveDeps,
  type Runners,
} from "./handler.ts";
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
    post({
      mode: "backfill",
      dry_run: false,
      after: "lYPee0K2DuQHXH2xHL1P",
      max_contacts: 3,
    }, "service-key"),
    deps,
    runners,
  );
  assertEquals(seen.backfill.map((r) => r.dryRun), [true, true, true, false]);
  assertEquals(seen.backfill[3], {
    dryRun: false,
    after: "lYPee0K2DuQHXH2xHL1P",
    maxContacts: 3,
  });
});

Deno.test("a refused real history load answers 409; bad cursor or mode answers 400", async () => {
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
      post({ mode: "backfill", after: "bad id!" }, "service-key"),
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

Deno.test("the live run goes to the background (202) unless wait is asked", async () => {
  const { seen, runners, deps } = setup();
  const pending: Promise<unknown>[] = [];
  const res = await handleFetch(post({}, "service-key"), {
    ...deps,
    waitUntil: (p) => pending.push(p),
  }, runners);
  assertEquals(res.status, 202);
  await Promise.all(pending);
  assertEquals(seen.live, 1);
});

Deno.test("ghlGet never follows a redirect, never reads an error body, and reports codes", async () => {
  const calls: RequestInit[] = [];
  const fake = (status: number, body: string) =>
    ((_u: string | URL | Request, init?: RequestInit) => {
      calls.push(init!);
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;
  assertEquals(
    await ghlGet("/p", "v3", { token: "t", fetchFn: fake(200, "[]") }),
    { ok: true, body: [] },
  );
  assertEquals(
    await ghlGet("/p", "v3", { token: "t", fetchFn: fake(200, "") }),
    { ok: true, body: null },
  );
  assertEquals(
    await ghlGet("/p", "v3", {
      token: "t",
      fetchFn: fake(404, "secret words"),
    }),
    { ok: false, status: 404, code: "http_404" },
  );
  assertEquals(
    await ghlGet("/p", "v3", { token: "t", fetchFn: fake(200, "<html>") }),
    { ok: false, status: null, code: "provider_not_json" },
  );
  const throws = (() => Promise.reject(new Error("net"))) as typeof fetch;
  assertEquals(await ghlGet("/p", "v3", { token: "t", fetchFn: throws }), {
    ok: false,
    status: null,
    code: "transport",
  });
  assertEquals(calls[0].redirect, "error");
  assertEquals(new Headers(calls[0].headers).get("version"), "v3");
});

Deno.test("history adapters refuse unresolved pagination and accept explicit exhaustion", async () => {
  const locationId = "location123";
  const contactId = "contact123";
  const conversationId = "conversation123";
  let answer: unknown = {};
  const d = liveDeps({
    env: (key) => key === "GHL_LOCATION_ID" ? locationId : "token",
    createSupabase: () => ({}),
    fetch: (input) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith("/contacts/" + contactId)
        ? { contact: { id: contactId, locationId } }
        : path.endsWith("/conversations/" + conversationId)
        ? { conversation: { id: conversationId, contactId, locationId } }
        : path.endsWith("/conversations/messages/message123")
        ? {
          message: { id: "message123", conversationId, contactId, locationId },
        }
        : answer;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    },
  });
  for (const nextPage of [true, undefined]) {
    answer = { messages: { messages: [], nextPage } };
    await assertRejects(
      () => d.listMessages(contactId, conversationId),
      Error,
      "pagination_unresolved",
    );
  }
  answer = {
    messages: { messages: [], nextPage: true, lastMessageId: "message123" },
  };
  await assertRejects(
    () => d.listMessages(contactId, conversationId, "message123"),
    Error,
    "pagination_unresolved",
  );
  answer = { messages: { messages: [], nextPage: false } };
  assertEquals((await d.listMessages(contactId, conversationId)).next, null);
  answer = {
    conversations: Array.from(
      { length: 50 },
      () => ({ id: conversationId, contactId, locationId }),
    ),
  };
  await assertRejects(
    () => d.listConversations(contactId),
    Error,
    "pagination_unresolved",
  );
  answer = { conversations: [] };
  assertEquals((await d.listConversations(contactId)).next, null);
});
