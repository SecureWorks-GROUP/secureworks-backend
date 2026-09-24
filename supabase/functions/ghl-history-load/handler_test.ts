// The history load's HTTP door and its wiring to the real provider reads and
// database calls (context slice M4). The GHL side is a recorded fixture
// location answered through ghl-proxy's own provider reads; the database side
// is a fake supabase client that records every call, so these tests prove the
// door calls exactly the SQL functions the migration defines, with a service
// key only, a dry run unless told otherwise, and the caller's actor recorded.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleHistoryLoad } from "./handler.ts";
import { R21_CONTACT } from "./m4_fixtures.ts";
import { R12_CONTACT, R12_CONVERSATION, R12_ITEM } from "./m4_fixtures.ts";

const SERVICE = "service-key-fixture";
const env = (name: string) =>
  ({
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    GHL_LOCATION_ID: "loc_secureworks",
    GHL_API_TOKEN: "fixture-only",
  } as Record<string, string>)[name];

function fakeSupabase(state: { flag?: boolean }) {
  const calls: { name: string; args?: any }[] = [];
  let runs = 0;
  const client = {
    calls,
    rpc(name: string, args?: any) {
      calls.push({ name, args });
      const ok = (data: unknown) => Promise.resolve({ data, error: null });
      switch (name) {
        case "context_ghl_item_flag":
          return ok({ enabled: state.flag ?? true });
        case "automation_lane_enabled":
          return ok(true);
        case "record_capture_run":
          return ok({ run_id: args.p_run.run_id ?? `run-${++runs}` });
        case "reserve_ghl_history_run":
          return ok({
            outcome: "reserved",
            run_id: `run-${++runs}`,
            due: {
              daily_job_limit: 100,
              jobs_counted_today: 0,
              daily_remaining: 100,
              contacts: [{
                contact_id: R12_CONTACT,
                job_ids: ["j1"],
                jobs: 1,
                prior_status: null,
                resume: null,
                attempts: 0,
              }],
              jobs_offered: 1,
              contacts_waiting: 0,
              jobs_waiting: 0,
              daily_limit_reached: false,
            },
          });
        case "capture_ghl_history_event":
          return ok({
            outcome: "inserted",
            id: "e1",
            attribution_status: "single_open",
          });
        case "record_ghl_history_contact":
          return ok({ outcome: "created" });
        case "context_ghl_history_link_candidates":
          return ok([{
            job_id: "44444444-4444-4444-8444-444444426168",
            job_number: "SWF-26168",
            tier: 3,
            phone_key: "412345678",
            email_key: null,
            own_contact_id: null,
            own_contacts: 0,
          }]);
        case "link_job_ghl_contact":
          return ok({ outcome: "linked", link_id: "l1" });
      }
      return Promise.resolve({ data: null, error: { code: "42883" } });
    },
    from(table: string) {
      const q: any = {
        select(cols: string) {
          calls.push({ name: `from:${table}:select`, args: cols });
          return q;
        },
        eq() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return Promise.resolve({ data: [], error: null });
        },
        in() {
          return Promise.resolve({ data: [], error: null });
        },
      };
      return q;
    },
  };
  return client;
}

function ghlFetch(log: URL[], contactsTotal?: number) {
  const conversation = {
    id: R12_CONVERSATION,
    contactId: R12_CONTACT,
    locationId: "loc_secureworks",
    lastMessageDate: Date.parse(R12_ITEM.dateAdded),
  };
  return ((input: string | URL | Request) => {
    const url = new URL(String(input));
    log.push(url);
    let body: unknown;
    if (url.pathname === "/conversations/search") {
      body = { conversations: [conversation], total: 1 };
    } else if (url.pathname === `/contacts/${R12_CONTACT}`) {
      body = { contact: { id: R12_CONTACT, locationId: "loc_secureworks" } };
    } else if (url.pathname === `/conversations/${R12_CONVERSATION}`) {
      body = conversation;
    } else if (url.pathname === `/conversations/${R12_CONVERSATION}/messages`) {
      body = {
        messages: {
          messages: [{ ...R12_ITEM, locationId: "loc_secureworks" }],
          nextPage: false,
          lastMessageId: R12_ITEM.id,
        },
      };
    } else if (url.pathname === "/contacts/") {
      body = {
        contacts: [{
          id: R21_CONTACT,
          locationId: "loc_secureworks",
          phone: "+61412345678",
        }],
        meta: contactsTotal === undefined ? {} : { total: contactsTotal },
      };
    } else throw new Error(`unexpected ${url}`);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
}

const post = (headers: Record<string, string> = {}, body?: unknown) =>
  new Request("https://edge.test/ghl-history-load", {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

Deno.test("only the service key may start a run; GET and unknown actions are refused", async () => {
  let ran = 0;
  const run = () => {
    ran++;
    return Promise.resolve({
      outcome: "idle" as const,
      reason: "item_flag_off" as const,
    });
  };
  const deps = { env, createSupabase: () => fakeSupabase({}) };
  assertEquals(
    (await handleHistoryLoad(new Request("https://edge.test/x"), deps, run))
      .status,
    405,
  );
  assertEquals(
    (await handleHistoryLoad(post({ Authorization: "" }), deps, run)).status,
    401,
  );
  assertEquals(
    (await handleHistoryLoad(
      post({ Authorization: "Bearer anon-key" }),
      deps,
      run,
    )).status,
    401,
  );
  assertEquals(
    (await handleHistoryLoad(
      post({}, { action: "delete", wait: true }),
      deps,
      run,
    )).status,
    400,
  );
  assertEquals(ran, 0);
});

Deno.test("an empty body is a dry run of the load; the actor header is recorded", async () => {
  const seen: any[] = [];
  const run = (_d: unknown, r: any) => {
    seen.push(r);
    return Promise.resolve({
      outcome: "idle" as const,
      reason: "item_flag_off" as const,
    });
  };
  const deps = { env, createSupabase: () => fakeSupabase({}) };
  const res = await handleHistoryLoad(
    post({ "x-sw-actor": "workflow:m4-validator" }),
    deps,
    run,
  );
  assertEquals(res.status, 200);
  assertEquals(seen[0].dryRun, true);
  assertEquals(seen[0].actor, "workflow:m4-validator");
  assertEquals((await res.json()).action, "load");
  // With the platform's waitUntil the reply is 202 and the run continues.
  let pending: Promise<unknown> | null = null;
  const bg = await handleHistoryLoad(post({}, { dry_run: false }), {
    ...deps,
    waitUntil: (p) => {
      pending = p;
    },
  }, run);
  assertEquals(bg.status, 202);
  assertEquals((await bg.json()).dry_run, false);
  await pending;
  assertEquals(seen[1].dryRun, false);
});

Deno.test("wiring: a real load reads GHL through the provider reads and saves only through capture_ghl_history_event", async () => {
  const log: URL[] = [];
  const sb = fakeSupabase({});
  const res = await handleHistoryLoad(
    post({ "x-sw-actor": "m4-validator" }, { dry_run: false, wait: true }),
    { env, createSupabase: () => sb, fetch: ghlFetch(log) },
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals([body.outcome, body.status, body.counts.inserted], [
    "ran",
    "succeeded",
    1,
  ]);
  const names = sb.calls.map((c) => c.name);
  assert(names.includes("reserve_ghl_history_run"));
  assert(
    !names.includes("context_ghl_history_due"),
    "a real run only reserves",
  );
  assert(!names.includes("capture_business_event"), "never the bare writer");
  const saved = sb.calls.find((c) => c.name === "capture_ghl_history_event")!;
  assertEquals(saved.args.p_row.metadata.capture_mode, "backfill");
  assertEquals(saved.args.p_row.source, "ghl-history-load");
  const ledger = sb.calls.find((c) => c.name === "record_ghl_history_contact")!;
  assertEquals([ledger.args.p_row.status, ledger.args.p_row.actor], [
    "done",
    "m4-validator",
  ]);
  // The day's jobs are reserved with the run, before any contact is read.
  const reserve = sb.calls.find((c) => c.name === "reserve_ghl_history_run")!;
  assertEquals(reserve.args, { p_max_jobs: 20, p_actor: "m4-validator" });
  assert(
    !names.includes("record_capture_run") ||
      sb.calls.filter((c) => c.name === "record_capture_run").every((c) =>
        c.args.p_run.run_id
      ),
  );
  assert(
    sb.calls.some((c) =>
      c.name === "from:business_events:select" &&
      c.args === "provider_message_id,event_at"
    ),
  );
  // Contact-scoped reads only: never the location-wide list.
  assert(
    log.every((u) =>
      u.pathname !== "/conversations/search" ||
      u.searchParams.get("contactId") === R12_CONTACT
    ),
  );
});

Deno.test("wiring: the link action searches GHL by key and writes only through link_job_ghl_contact", async () => {
  const log: URL[] = [];
  const sb = fakeSupabase({});
  const res = await handleHistoryLoad(
    post({}, { action: "link", dry_run: false, wait: true }),
    { env, createSupabase: () => sb, fetch: ghlFetch(log, 1) },
  );
  const body = await res.json();
  assertEquals([
    body.action,
    body.outcome,
    body.counts.certain,
    body.counts.linked,
  ], ["link", "ran", 1, 1]);
  const page = sb.calls.find((c) =>
    c.name === "context_ghl_history_link_candidates"
  )!;
  assertEquals(page.args, { p_after: null, p_limit: 500 });
  const link = sb.calls.find((c) => c.name === "link_job_ghl_contact")!;
  assertEquals(link.args.p_row.contact_id, R21_CONTACT);
  assertEquals(link.args.p_row.key_kind, "phone");
  assertEquals(
    log.find((u) => u.pathname === "/contacts/")!.searchParams.get("query"),
    "+61412345678",
  );
  // A dry link run writes nothing.
  const sb2 = fakeSupabase({});
  const dry =
    await (await handleHistoryLoad(post({}, { action: "link", wait: true }), {
      env,
      createSupabase: () => sb2,
      fetch: ghlFetch([], 1),
    })).json();
  assertEquals([dry.dry_run, dry.counts.certain, dry.counts.linked], [
    true,
    1,
    0,
  ]);
  assert(!sb2.calls.some((c) => c.name === "link_job_ghl_contact"));
});

Deno.test("wiring: a GHL contact search is complete only on an explicit end (review M4-7)", async () => {
  // One exact match on a short page, but GHL says nothing about the end: an
  // unfinished search, so the job stays ambiguous and nothing is written.
  const sb = fakeSupabase({});
  const body = await (await handleHistoryLoad(
    post({}, { action: "link", dry_run: false, wait: true }),
    { env, createSupabase: () => sb, fetch: ghlFetch([]) },
  )).json();
  assertEquals([
    body.counts.ambiguous,
    body.counts.search_incomplete,
    body.counts.linked,
  ], [1, 1, 0]);
  assert(!sb.calls.some((c) => c.name === "link_job_ghl_contact"));
  // GHL's own total covering the page is an explicit end.
  const sb2 = fakeSupabase({});
  const done = await (await handleHistoryLoad(
    post({}, { action: "link", dry_run: false, wait: true }),
    { env, createSupabase: () => sb2, fetch: ghlFetch([], 1) },
  )).json();
  assertEquals(done.counts.linked, 1);
  // A total larger than the page is not.
  const sb3 = fakeSupabase({});
  const more = await (await handleHistoryLoad(
    post({}, { action: "link", dry_run: false, wait: true }),
    { env, createSupabase: () => sb3, fetch: ghlFetch([], 2) },
  )).json();
  assertEquals([more.counts.ambiguous, more.counts.linked], [1, 0]);
});
