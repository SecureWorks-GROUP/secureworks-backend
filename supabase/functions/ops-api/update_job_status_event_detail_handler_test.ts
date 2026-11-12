// deno-lint-ignore-file no-import-prefix no-explicit-any
// update_job_status over HTTP: a request body cannot add its own fields to the
// status_changed job event. Only internal moves (the deposit advance) note the
// council mark there.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
  "STATE_ENGINE_SHADOW",
];
const BASE_ENV: Record<string, string | undefined> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SW_API_KEY: "test-shared-browser-key",
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = BASE_ENV[name];
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

async function postUpdateJobStatus(body: unknown) {
  const handle = await withEnv(async () =>
    (await import("./index.ts"))._opsApiRequestHandlerForTest
  );
  const jobEvents: any[] = [];
  const job = {
    id: JOB_ID,
    status: "order_materials",
    type: "miscellaneous",
    job_number: "SWM-T1",
    client_name: "Test Client",
    pricing_json: null,
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : null;
    if (url.startsWith("http://127.0.0.1:9/rest/v1/jobs?")) {
      if (method === "PATCH" && raw) Object.assign(job, JSON.parse(raw));
      return Promise.resolve(Response.json({ ...job }));
    }
    if (url.startsWith("http://127.0.0.1:9/rest/v1/job_events")) {
      if (method === "POST" && raw) {
        const parsed = JSON.parse(raw);
        jobEvents.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      }
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", "update_job_status");
    const res = await withEnv(() =>
      handle(
        new Request(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${SERVICE_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      )
    );
    const json = await res.json();
    return { status: res.status, json, jobEvents, job };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

Deno.test("update_job_status over HTTP: a request body cannot put a council mark on the status_changed event", async () => {
  const out = await postUpdateJobStatus({
    job_id: JOB_ID,
    status: "scheduled",
    source: "ops_dashboard",
    event_detail: {
      council_required: true,
      council_required_label: "needs council",
    },
  });
  assertEquals(out.status, 200);
  assertEquals(out.json.success, true);
  assertEquals(out.job.status, "scheduled");
  const statusEvents = out.jobEvents.filter((e) =>
    e.event_type === "status_changed"
  );
  assertEquals(statusEvents.length, 1);
  assertEquals(statusEvents[0].detail_json, {
    new_status: "scheduled",
    source: "ops_dashboard",
    operator: null,
  });
});
