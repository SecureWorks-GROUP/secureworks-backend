/**
 * SQ-23 reader in daily-digest: a quote option another option of the same
 * quote superseded is not chased by stale_followup (which texts and emails
 * the client) and not listed as a stale quote. Switch
 * quote_option_ops_reader_v1 off: both are chased, exactly as before.
 * Drives the real request handler with every call answered by a fetch spy.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "OPS_AGENT_SERVER_KEY",
  "ANTHROPIC_API_KEY",
];
const BASE_ENV = {
  // A closed local port: anything the fetch spy does not answer fails loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

// index.ts reads its env into module constants, so they are set before the
// dynamic import and restored after.
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = env[name];
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

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(
    BASE_ENV,
    async () => (await import("./index.ts"))._dailyDigestRequestHandlerForTest,
  );
  return handlerPromise;
}

function serviceRequest(action: string | null): Request {
  const query = action ? `?action=${action}` : "";
  return new Request(`https://example.invalid/daily-digest${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: "{}",
  });
}

type FetchCall = { url: URL; method: string; body: any };
type Rows = (url: URL) => unknown[] | null;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// PostgREST reads are answered by `rows` (null means "no rows"); every write
// succeeds; every function call succeeds, so a live send path would run to
// completion and show up in the call log.
async function withFetchSpy<T>(
  rows: Rows,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers).get("accept") ?? "";
    let body: any = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch { /* keep raw */ }
    }
    calls.push({ url, method, body });
    const one = accept.includes("vnd.pgrst.object");
    if (url.pathname.includes("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        return Promise.resolve(json(one ? null : [], 201));
      }
      const found = rows(url) ?? [];
      return Promise.resolve(json(one ? (found[0] ?? null) : found));
    }
    return Promise.resolve(json({ success: true, content: [] }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const table = (url: URL) => url.pathname.split("/rest/v1/")[1];
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

function opsApiCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.pathname.endsWith("/functions/v1/ops-api"));
}
function annotationInserts(calls: FetchCall[], type: string): any[] {
  return calls
    .filter((c) => c.method === "POST" && table(c.url) === "ai_annotations")
    .flatMap((c) => Array.isArray(c.body) ? c.body : [c.body])
    .filter((row) => row?.annotation_type === type);
}

const LIVE_QUOTE = "11111111-0000-4000-8000-000000000011";
const SUPERSEDED_QUOTE = "11111111-0000-4000-8000-000000000012";
const ACCEPTED_OPTION = "11111111-0000-4000-8000-000000000013";

function rowsFor(flagOn: boolean): Rows {
  return (url) => {
    const t = table(url);
    if (t === "feature_flags") return flagOn ? [{ enabled: true }] : [];
    if (t === "jobs" && url.searchParams.get("status") === "eq.quoted") {
      return [LIVE_QUOTE, SUPERSEDED_QUOTE].map((id, i) => ({
        id,
        job_number: `SWF-9100${i}`,
        client_name: "Test Client",
        type: "fencing",
        pricing_json: { total: 5000 },
        quoted_at: daysAgo(4),
      }));
    }
    if (
      t === "job_events" &&
      (url.searchParams.get("event_type") || "").includes(
        "quote_option_superseded",
      )
    ) {
      const ids = url.searchParams.get("job_id") || "";
      return ids.includes(SUPERSEDED_QUOTE)
        ? [{
          job_id: SUPERSEDED_QUOTE,
          event_type: "quote_option_superseded",
          created_at: daysAgo(1),
          detail_json: {
            superseded_by_job_id: ACCEPTED_OPTION,
            quote_option_group_id: ACCEPTED_OPTION,
          },
        }]
        : [];
    }
    if (t === "jobs" && url.searchParams.has("quote_option_group_id")) {
      return [
        {
          id: ACCEPTED_OPTION,
          status: "accepted",
          quote_option_group_id: ACCEPTED_OPTION,
          superseded_at: null,
        },
        {
          id: SUPERSEDED_QUOTE,
          status: "quoted",
          quote_option_group_id: ACCEPTED_OPTION,
          superseded_at: daysAgo(1),
        },
      ];
    }
    return null;
  };
}

for (const flagOn of [true, false]) {
  Deno.test(`stale_followup: switch ${flagOn ? "on chases only the live quote" : "off chases both"}`, async () => {
    const handle = await handler();
    await withEnv(
      BASE_ENV,
      () =>
        withFetchSpy(rowsFor(flagOn), async (calls) => {
          const res = await handle(serviceRequest("stale_followup"));
          const body = await res.json();
          assertEquals(res.status, 200, JSON.stringify(body));
          const chased = calls
            .filter((c) => c.url.pathname.endsWith("/functions/v1/ops-api"))
            .filter((c) => c.body?.comms_trigger === "quote_sent")
            .map((c) => c.body.job_id)
            .sort();
          assertEquals(
            chased,
            flagOn ? [LIVE_QUOTE] : [LIVE_QUOTE, SUPERSEDED_QUOTE].sort(),
          );
          const optionReads = calls.filter((c) =>
            table(c.url) === "job_events" ||
            c.url.searchParams.has("quote_option_group_id")
          );
          if (!flagOn) assertEquals(optionReads, []);
        }),
    );
  });
}
