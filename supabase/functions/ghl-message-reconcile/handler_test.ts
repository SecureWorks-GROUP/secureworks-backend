// The reconciler's HTTP door and its wiring to the real provider reads and
// database calls (context slice C1d). The GHL side is answered by a recorded
// fixture location through ghl-proxy's own provider reads; the database side
// is a fake supabase client that records every call.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  R2_LIST_ITEM,
  R3_LIST_ITEM,
  RX1_REACTION_ITEM,
  RX1_TARGET_ITEM,
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { handleReconcile, sameSecret } from "./handler.ts";
import { RUN_SOURCE } from "./reconcile.ts";

const SERVICE = "service-key-fixture";
const env = (name: string) =>
  ({
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    GHL_LOCATION_ID: "loc_secureworks",
    GHL_API_TOKEN: "fixture-only",
  } as Record<string, string>)[name];

function fakeSupabase(state: { flag: boolean; runs: any[]; keys: string[] }) {
  const calls: { kind: string; name: string; args?: unknown }[] = [];
  const client = {
    calls,
    rpc(name: string, args?: unknown) {
      calls.push({ kind: "rpc", name, args });
      if (name === "context_ghl_item_flag") {
        return Promise.resolve({ data: { enabled: state.flag }, error: null });
      }
      if (name === "automation_lane_enabled") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "record_capture_run") {
        const run = (args as any).p_run;
        const id = run.run_id ?? "run-1";
        return Promise.resolve({
          data: { run_id: id, outcome: "created" },
          error: null,
        });
      }
      if (name === "capture_business_event") {
        return Promise.resolve({
          data: { outcome: "inserted", id: "e1" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { code: "42883" } });
    },
    from(table: string) {
      const q: any = {
        filters: [] as unknown[],
        select(cols: string) {
          q.filters.push(["select", cols]);
          return q;
        },
        eq(c: string, v: unknown) {
          q.filters.push(["eq", c, v]);
          return q;
        },
        in(c: string, v: unknown) {
          q.filters.push(["in", c, v]);
          calls.push({ kind: "from", name: table, args: q.filters });
          const keys = v as string[];
          return Promise.resolve({
            data: keys.filter((k) => state.keys.includes(k)).map((k) => ({
              provider_message_id: k,
            })),
            error: null,
          });
        },
        order() {
          return q;
        },
        limit() {
          calls.push({ kind: "from", name: table, args: q.filters });
          return Promise.resolve({ data: state.runs, error: null });
        },
      };
      return q;
    },
  };
  return client;
}

// A recorded location: one conversation (R2/R3's) with two texts.
function ghlFetch(log: URL[]) {
  const conversation = {
    id: R2_LIST_ITEM.conversationId,
    contactId: R2_LIST_ITEM.contactId,
    locationId: "loc_secureworks",
    lastMessageDate: Date.parse(R3_LIST_ITEM.dateAdded),
  };
  return ((input: string | URL | Request) => {
    const url = new URL(String(input));
    log.push(url);
    let body: unknown;
    if (url.pathname === "/conversations/search") {
      body = { conversations: [conversation] };
    } else if (url.pathname === `/contacts/${R2_LIST_ITEM.contactId}`) {
      body = {
        contact: { id: R2_LIST_ITEM.contactId, locationId: "loc_secureworks" },
      };
    } else if (
      url.pathname === `/conversations/${R2_LIST_ITEM.conversationId}`
    ) {
      body = conversation;
    } else if (
      url.pathname === `/conversations/${R2_LIST_ITEM.conversationId}/messages`
    ) {
      body = {
        messages: {
          messages: [R3_LIST_ITEM, R2_LIST_ITEM].map((m) => ({
            ...m,
            locationId: "loc_secureworks",
          })),
          nextPage: false,
          lastMessageId: R2_LIST_ITEM.id,
        },
      };
    } else throw new Error(`unexpected ${url}`);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
}

const post = (headers: Record<string, string> = {}, body?: unknown) =>
  new Request("https://edge.test/ghl-message-reconcile", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

Deno.test("only the service key may start a run; GET is refused", async () => {
  let ran = 0;
  const run = () => {
    ran++;
    return Promise.resolve({
      outcome: "idle" as const,
      reason: "item_flag_off" as const,
    });
  };
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ flag: false, runs: [], keys: [] }),
  };
  assertEquals(
    (await handleReconcile(new Request("https://edge.test/x"), deps, run))
      .status,
    405,
  );
  assertEquals((await handleReconcile(post(), deps, run)).status, 401);
  assertEquals(
    (await handleReconcile(
      post({ Authorization: "Bearer anon-key" }),
      deps,
      run,
    )).status,
    401,
  );
  assertEquals(
    (await handleReconcile(post({ Authorization: `Bearer ${SERVICE}` }), {
      ...deps,
      env: () => undefined,
    }, run)).status,
    401,
    "no configured key refuses a non-JWT bearer",
  );
  assertEquals(ran, 0);
  assert(sameSecret("abc", "abc"));
  assert(!sameSecret("abc", "abd"));
  assert(!sameSecret("abc", "abcd"));
});

function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(
      /=+$/,
      "",
    );
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${
    b64url(payload)
  }.fixture-signature`;
}

Deno.test("the service role is accepted by exact key or by role claim; every other caller is 401", async () => {
  const started: string[] = [];
  let caller = "";
  const run = () => {
    started.push(caller);
    return Promise.resolve({
      outcome: "idle" as const,
      reason: "item_flag_off" as const,
    });
  };
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ flag: false, runs: [], keys: [] }),
  };
  const call = async (label: string, headers: Record<string, string>) => {
    caller = label;
    const res = await handleReconcile(post(headers, { wait: true }), deps, run);
    return { status: res.status, body: await res.json() };
  };

  // The exact injected key.
  assertEquals(
    (await call("env", { Authorization: `Bearer ${SERVICE}` })).status,
    200,
  );

  // The cron's sw_service_key(): a service_role JWT that is not the env string.
  const cronJwt = fakeJwt({
    iss: "supabase",
    ref: "proj",
    role: "service_role",
  });
  assert(cronJwt !== SERVICE);
  assertEquals(
    (await call("cron", { Authorization: `Bearer ${cronJwt}` })).status,
    200,
  );

  // Anyone else is refused before a run starts.
  for (
    const [label, headers] of [
      ["anon", { Authorization: `Bearer ${fakeJwt({ role: "anon" })}` }],
      ["authenticated", {
        Authorization: `Bearer ${
          fakeJwt({ role: "authenticated", sub: "user-1" })
        }`,
      }],
      ["no role", { Authorization: `Bearer ${fakeJwt({ sub: "user-1" })}` }],
      ["near miss", {
        Authorization: `Bearer ${fakeJwt({ role: "service_role_x" })}`,
      }],
      ["not a jwt", { Authorization: "Bearer totally-garbage" }],
      ["no bearer", {}],
      ["empty bearer", { Authorization: "Bearer " }],
      ["not bearer scheme", { Authorization: `Basic ${cronJwt}` }],
    ] as [string, Record<string, string>][]
  ) {
    const res = await call(label, headers);
    assertEquals(res.status, 401, label);
    assertEquals(res.body, { error: "service_key_required" }, label);
  }

  // A service_role JWT is still accepted when the env key is absent: the claim,
  // not the env string, is what the platform-verified token proves.
  caller = "cron-no-env";
  assertEquals(
    (await handleReconcile(
      post({ Authorization: `Bearer ${cronJwt}` }, { wait: true }),
      { ...deps, env: () => undefined },
      run,
    )).status,
    200,
  );
  assertEquals(started, ["env", "cron", "cron-no-env"]);
});

Deno.test("end to end over the real provider reads: missed texts saved, run recorded, known text skipped", async () => {
  const log: URL[] = [];
  const supabase = fakeSupabase({
    flag: true,
    runs: [],
    keys: [`ghl:${R2_LIST_ITEM.id}`],
  });
  const response = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }, { wait: true }),
    {
      env,
      createSupabase: () => supabase,
      fetch: ghlFetch(log),
      now: () => Date.parse("2026-09-23T06:30:00.000Z"),
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.outcome, "ran");
  assertEquals(body.status, "succeeded");
  assertEquals(body.counts.inserted, 1);
  assertEquals(body.counts.duplicates, 1);
  // The location-wide read, newest first, from the configured location.
  const search = log.find((u) => u.pathname === "/conversations/search")!;
  assertEquals(search.searchParams.get("sortBy"), "last_message_date");
  assertEquals(search.searchParams.get("locationId"), "loc_secureworks");
  // Only the unknown text went to the writer, as a live reconciler row.
  const writes = supabase.calls.filter((c) =>
    c.name === "capture_business_event"
  );
  assertEquals(writes.length, 1);
  const row = (writes[0].args as any).p_row;
  assertEquals(row.provider_message_id, `ghl:${R3_LIST_ITEM.id}`);
  assertEquals(row.source, "ghl-message-reconcile");
  assertEquals(row.metadata, { capture_mode: "live" });
  // The run row: created running, finished succeeded, source ghl_message_reconcile.
  const runs = supabase.calls.filter((c) => c.name === "record_capture_run")
    .map((c) => (c.args as any).p_run);
  assertEquals(runs[0].status, "running");
  assertEquals(runs.at(-1).status, "succeeded");
  assert(runs.every((r) => r.source === RUN_SOURCE));
  assert(
    !JSON.stringify(runs).includes("Thanks."),
    "no message text in run rows",
  );
});

// C7 (3 Nov 2026): the reaction repair through the real door and provider reads.
function reactionFetch(log: { method: string; url: URL }[]) {
  const conv = RX1_REACTION_ITEM.conversationId;
  const contact = RX1_REACTION_ITEM.contactId;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    log.push({ method: init?.method ?? "GET", url });
    let body: unknown;
    if (url.pathname === `/contacts/${contact}`) {
      body = { contact: { id: contact, locationId: "loc_secureworks" } };
    } else if (url.pathname === `/conversations/${conv}`) {
      body = {
        id: conv,
        contactId: contact,
        locationId: "loc_secureworks",
      };
    } else if (url.pathname === `/conversations/${conv}/messages`) {
      body = {
        messages: {
          messages: [RX1_REACTION_ITEM, RX1_TARGET_ITEM].map((m) => ({
            ...m,
            locationId: "loc_secureworks",
          })),
          nextPage: false,
          lastMessageId: RX1_TARGET_ITEM.id,
        },
      };
    } else throw new Error(`unexpected ${url}`);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("C7 reaction repair door: a dry run reads GHL and the saved keys only, and answers what it would save", async () => {
  const log: { method: string; url: URL }[] = [];
  const supabase = fakeSupabase({ flag: true, runs: [], keys: [] });
  const response = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }, {
      action: "reaction_repair",
      since: "2026-10-26T16:00:00Z",
      conversations: [{
        contact_id: RX1_REACTION_ITEM.contactId,
        conversation_id: RX1_REACTION_ITEM.conversationId,
      }],
    }),
    {
      env,
      createSupabase: () => supabase,
      fetch: reactionFetch(log),
      now: () => Date.parse("2026-11-03T14:00:00.000Z"),
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.action, "reaction_repair");
  assertEquals(body.outcome, "ran");
  assertEquals(body.dry_run, true);
  assertEquals(body.complete, true);
  assertEquals(body.counts.reactions_to_write, 1);
  assertEquals(body.reactions[0].key, `ghl:${RX1_REACTION_ITEM.id}`);
  assertEquals(body.reactions[0].result, "would_write");
  assertEquals(body.reactions[0].reacted_to_key, `ghl:${RX1_TARGET_ITEM.id}`);
  // Read only: GETs to GHL; on the database the flag, the lane and one key read.
  assert(log.length > 0 && log.every((r) => r.method === "GET"));
  const names = supabase.calls.map((c) => c.name);
  assert(!names.includes("capture_business_event"), "no write");
  assert(!names.includes("record_capture_run"), "no run row");
  assertEquals(
    supabase.calls.filter((c) => c.kind === "from").map((c) => c.name),
    ["business_events"],
  );
  assert(!JSON.stringify(body).includes("automation apologies"));
});

Deno.test("C7 reaction repair door: a real run saves the reaction through the one writer, as a backfill row", async () => {
  const supabase = fakeSupabase({ flag: true, runs: [], keys: [] });
  const response = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }, {
      action: "reaction_repair",
      since: "2026-10-26T16:00:00Z",
      dry_run: false,
      conversations: [{
        contact_id: RX1_REACTION_ITEM.contactId,
        conversation_id: RX1_REACTION_ITEM.conversationId,
      }],
    }),
    {
      env,
      createSupabase: () => supabase,
      fetch: reactionFetch([]),
      now: () => Date.parse("2026-11-03T14:00:00.000Z"),
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.counts.inserted, 1);
  const writes = supabase.calls.filter((c) =>
    c.name === "capture_business_event"
  );
  assertEquals(writes.length, 1);
  const row = (writes[0].args as any).p_row;
  assertEquals(row.provider_message_id, `ghl:${RX1_REACTION_ITEM.id}`);
  assertEquals(row.event_type, "client.sms_reaction");
  assertEquals(row.metadata, {
    capture_mode: "backfill",
    capture_path: "reaction_repair",
  });
  assert(
    !supabase.calls.some((c) => c.name === "record_capture_run"),
    "the repair never touches the reconciler's scan",
  );
});

Deno.test("C7 reaction repair door: a malformed request is refused with its code; the caller must be the service role", async () => {
  const deps = {
    env,
    createSupabase: () => fakeSupabase({ flag: true, runs: [], keys: [] }),
    fetch: reactionFetch([]),
    now: () => Date.parse("2026-11-03T14:00:00.000Z"),
  };
  const missing = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }, { action: "reaction_repair" }),
    deps,
  );
  assertEquals(missing.status, 400);
  assertEquals((await missing.json()).error, "since_required");
  const old = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }, {
      action: "reaction_repair",
      since: "2026-09-01T00:00:00Z",
    }),
    deps,
  );
  assertEquals(old.status, 400);
  assertEquals((await old.json()).error, "since_too_old");
  const anon = await handleReconcile(
    post({ Authorization: "Bearer not-the-key" }, {
      action: "reaction_repair",
      since: "2026-10-26T16:00:00Z",
    }),
    deps,
  );
  assertEquals(anon.status, 401);
});
