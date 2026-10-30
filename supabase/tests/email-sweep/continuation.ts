// Synthetic provider -> actual capture writer/run ledger -> actual sweep queue.
// Fixed disposable localhost database only. No network permission is needed.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CaptureDeps,
  runOutlookCapture,
  type SourceRow,
} from "../../functions/outlook-mail-capture/capture.ts";
import * as graph from "../../functions/outlook-mail-capture/graph.ts";
import { handleCapture } from "../../functions/outlook-mail-capture/handler.ts";
const database = Deno.args[0] ?? "cio_email_sweep_journey_20261030";
assert(/^cio_email_sweep_journey_20261030(?:_r[0-9]+)?$/.test(database));
const shutdownProof = Deno.args[1] === "--worker-shutdown";
const DB = `postgresql://postgres@127.0.0.1:56576/${database}`;
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const lit = (v: unknown) =>
  "'" + JSON.stringify(v).replaceAll("'", "''") + "'::jsonb";
const text = (v: string) => "'" + v.replaceAll("'", "''") + "'";
async function sql(query: string) {
  const p = new Deno.Command(PSQL, {
    args: [DB, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(query));
  await w.close();
  const out = await p.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  const answer = new TextDecoder().decode(out.stdout).trim();
  return answer ? JSON.parse(answer) : null;
}
await sql(`
CREATE SCHEMA cio_sweep_fixture;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE cio_sweep_fixture.requests(seq bigserial, body jsonb);
CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cio_sweep_fixture.requests(body) VALUES(body) RETURNING seq $$;
CREATE OR REPLACE FUNCTION public.sw_service_key() RETURNS text LANGUAGE sql AS $$ SELECT 'synthetic-no-provider-key'::text $$;
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text) RETURNS boolean LANGUAGE sql AS $$ SELECT lane='capture' $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_sweep_continuation_v1');
UPDATE public.monitored_mailboxes SET enabled=(source_key='fencing');
SELECT public.trigger_context_email_sweep();
`);
const source: SourceRow = {
  email: "fencing@secureworkswa.com.au",
  source_key: "fencing",
  kind: "group",
  scope_label: "fencing",
  owner_privacy: false,
};
const window = await sql(
  "SELECT jsonb_build_object('from',window_from,'to',window_to) FROM public.context_email_sweep_windows WHERE source_key='fencing';",
);
const end = Date.parse(window.to);
let fault = true;
let graphReads = 0;
const provider: graph.GraphDeps = {
  token: async () => "fixture",
  fetch: async (input) => {
    graphReads++;
    const url = new URL(String(input));
    assertEquals(url.hostname, "graph.microsoft.com");
    const i = Number(url.pathname.match(/threads\/T(\d+)\/posts/)?.[1]);
    assert(Number.isInteger(i) && i >= 0 && i < 450);
    const roster = !url.searchParams.get("$select")!.split(",").includes(
      "body",
    );
    if (i === 220 && !roster && fault) {
      fault = false;
      return new Response("synthetic provider fault", { status: 503 });
    }
    return new Response(JSON.stringify({
      value: [{
        id: `P${i}`,
        from: { emailAddress: { address: "synthetic.enquiry@example.net" } },
        receivedDateTime: new Date(end - (i + 1) * 60_000).toISOString(),
        ...(!roster
          ? {
            body: { contentType: "text", content: `Synthetic message ${i}` },
            singleValueExtendedProperties: [{
              id: "String 0x1035",
              value: `<sweep-proof-${i}@fixture.example>`,
            }],
          }
          : {}),
      }],
    }));
  },
};
const deps: CaptureDeps = {
  now: () => Date.now(),
  flags: () => sql("SELECT public.context_email_reader_flags();"),
  captureLaneOn: () =>
    sql("SELECT to_jsonb(public.automation_lane_enabled('capture'));"),
  sources: async () => [source],
  supplierDomains: async () => new Set(),
  jobClientEmails: async () => new Set(),
  historyScope: async () => {
    throw new Error("sweep must not use history admission");
  },
  deepGate: async () => {
    throw new Error("not deep");
  },
  deepScope: async () => {
    throw new Error("not deep");
  },
  builderRefPrefixes: async () => [],
  latestRuns: (key, limit) =>
    sql(
      `SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT id,status,started_at,updated_at,window_to,window_end_id,cursor FROM public.context_capture_runs WHERE source=${
        text(key)
      } ORDER BY started_at DESC LIMIT ${limit}) x;`,
    ),
  recordRun: async (row) =>
    (await sql(`SELECT public.record_capture_run(${lit(row)});`)).run_id,
  capture: (row) => sql(`SELECT public.capture_business_event(${lit(row)});`),
  resolveAudience: async () => "unchanged",
  legacyCopy: async () => null,
  mail: {
    folderIds: async () => {
      throw new Error("group only");
    },
    listMessages: async () => {
      throw new Error("group only");
    },
    messageDetail: async () => {
      throw new Error("group only");
    },
    resolveGroupId: async () => "G",
    listGroupConversations: async (_g, next) => {
      const start = next ? Number(next) : 0;
      return {
        items: Array.from(
          { length: Math.min(25, 450 - start) },
          (_, n) => ({
            id: `C${start + n}`,
            lastDeliveredDateTime: new Date(end - (start + n + 1) * 60_000)
              .toISOString(),
          }),
        ),
        next: start + 25 < 450 ? String(start + 25) : null,
      };
    },
    listGroupThreads: async () => {
      throw new Error("bounded walk required");
    },
    listGroupPosts: async () => {
      throw new Error("no bulk body collection");
    },
    listGroupThreadPage: async (_g, c) => ({
      items: [{ id: `T${Number(c.slice(1))}`, topic: "Synthetic enquiry" }],
      next: null,
    }),
    listGroupPostPage: (g, t, topic, next, roster) =>
      graph.listGroupPostPage(provider, g, t, topic, next, roster),
  },
  storeAttachments: async () => {
    throw new Error("fixture has no attachments");
  },
  hash: async (s) => s,
};
let interrupted: Record<string, unknown> | null = null;
if (shutdownProof) {
  const dispatch = await sql("SELECT public.context_email_sweep_tick();");
  assertEquals(dispatch.outcome, "posted");
  const request = await sql(
    "SELECT body FROM cio_sweep_fixture.requests ORDER BY seq DESC LIMIT 1;",
  );
  const worker = new Worker(
    new URL("./queued-worker.ts", import.meta.url).href,
    {
      type: "module",
    },
  );
  try {
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.postMessage(request);
    interrupted = await received;
    assertEquals(interrupted.first_status, 202);
    assertEquals(interrupted.queued_status, 202);
    assertEquals(interrupted.started, ["blocking_fixture"]);
    assertEquals(interrupted.clients, 1);
  } finally {
    worker.terminate();
  }
  // The accepted queued request died before it could create a run receipt.
  // The durable caller must keep its original window incomplete and retry it.
  const state = await sql(
    "SELECT jsonb_build_object('state',state,'attempts',attempts,'completed_at',completed_at) FROM public.context_email_sweep_windows WHERE source_key='fencing';",
  );
  assertEquals(state.state, "loading");
  assertEquals(state.attempts, 1);
  assertEquals(state.completed_at, null);
  assertEquals(
    await sql("SELECT to_jsonb(count(*)) FROM public.context_capture_runs;"),
    0,
  );
  assertEquals(
    (await sql("SELECT public.context_email_sweep_status();")).finished,
    false,
  );
  interrupted = { ...interrupted, durable_state: state, terminated: true };
}
const receipts = [];
for (let n = 0; n < 6; n++) {
  // Test-only time advance of the dispatch ledger. Not a wall-clock/cron proof.
  await sql(
    "UPDATE public.context_email_sweep_windows SET last_posted_at=now()-interval '6 minutes' WHERE last_posted_at IS NOT NULL;",
  );
  const dispatch = await sql("SELECT public.context_email_sweep_tick();");
  if (dispatch.outcome !== "posted") break;
  const request = await sql(
    "SELECT body FROM cio_sweep_fixture.requests ORDER BY seq DESC LIMIT 1;",
  );
  assertEquals(Date.parse(request.from), Date.parse(window.from));
  assertEquals(Date.parse(request.to), Date.parse(window.to));
  const result = shutdownProof
    ? await (await handleCapture(
      new Request("https://fixture.invalid/outlook-mail-capture", {
        method: "POST",
        headers: { "x-api-key": "restart-fixture" },
        body: JSON.stringify({ ...request, wait: true }),
      }),
      {
        env: (name) => name === "SW_API_KEY" ? "restart-fixture" : undefined,
        createSupabase: () => ({}),
      },
      (_live, body) => runOutlookCapture(deps, body),
    )).json()
    : await runOutlookCapture(deps, request);
  await sql("SELECT public.context_email_sweep_tick();");
  const state = await sql(
    "SELECT jsonb_build_object('state',state,'error',last_error) FROM public.context_email_sweep_windows WHERE source_key='fencing';",
  );
  receipts.push({ dispatch, request, result, queue: state });
  if (state.state === "succeeded") break;
}
const counts = await sql(
  "SELECT jsonb_build_object('rows',count(*),'distinct_keys',count(DISTINCT provider_message_id),'live',count(*) FILTER(WHERE metadata->>'capture_mode'='live')) FROM public.business_events WHERE provider_message_id LIKE 'email:sweep-proof-%@fixture.example';",
);
const ledger = await sql(
  "SELECT jsonb_agg(jsonb_build_object('status',status,'inserted',counts->'inserted','error',error_code) ORDER BY started_at) FROM public.context_capture_runs WHERE source='outlook_sweep_fencing';",
);
assertEquals(counts, { rows: 450, distinct_keys: 450, live: 450 });
assertEquals(ledger.map((r: { status: string }) => r.status), [
  "partial",
  "failed",
  "partial",
  "succeeded",
]);
assertEquals(ledger.map((r: { inserted: number }) => r.inserted), [
  200,
  20,
  200,
  30,
]);
assertEquals(receipts[1].queue, { state: "failed", error: "graph_503" });
const status = await sql("SELECT public.context_email_sweep_status();");
assertEquals(status.finished, true);
assertEquals(status.pending, 0);
console.log(JSON.stringify(
  {
    checked_at: new Date().toISOString(),
    result: "PASS",
    counts,
    ledger,
    graphReads,
    interrupted,
    receipts,
    limits: [
      "synthetic Graph responses",
      "disposable real SQL writer and run ledger",
      "dispatch times advanced in fixture, not cron elapsed time",
      "no actual provider, production, staff or independent acceptance",
      "worker shutdown is a local terminated isolate, not a hosted Edge kill",
    ],
  },
  null,
  2,
));
