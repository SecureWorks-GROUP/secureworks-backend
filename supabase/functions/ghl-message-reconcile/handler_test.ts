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
} from "../_shared/evidence/ghl_message_fixtures.ts";
import { handleReconcile, liveReconcileDeps, sameSecret } from "./handler.ts";
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
    "no configured key refuses everyone",
  );
  assertEquals(ran, 0);
  assert(sameSecret("abc", "abc"));
  assert(!sameSecret("abc", "abd"));
  assert(!sameSecret("abc", "abcd"));
});

Deno.test("the cron call is answered 202 and the run continues in the background", async () => {
  const pending: Promise<unknown>[] = [];
  const response = await handleReconcile(
    post({ Authorization: `Bearer ${SERVICE}` }),
    {
      env,
      createSupabase: () => fakeSupabase({ flag: false, runs: [], keys: [] }),
      waitUntil: (p) => pending.push(p),
    },
  );
  assertEquals(response.status, 202);
  assertEquals(pending.length, 1);
  assertEquals(await pending[0], { outcome: "idle", reason: "item_flag_off" });
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

Deno.test("adapter: runs are read newest first for this source only", async () => {
  const supabase = fakeSupabase({ flag: true, runs: [{ id: "r" }], keys: [] });
  const deps = liveReconcileDeps({ env, createSupabase: () => supabase });
  const runs = await deps.latestRuns(5);
  assertEquals(runs, [{ id: "r" } as any]);
  const read = supabase.calls.find((c) => c.name === "context_capture_runs")!;
  assertEquals((read.args as any[]).find((f) => f[0] === "eq"), [
    "eq",
    "source",
    RUN_SOURCE,
  ]);
});
