// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// job_detail's documents carry sent_at and superseded_at so Dispatch slice 2's
// quote chips can show a sent date or "Superseded" (SWF-26824, SWF-261271 read
// "Sent" without them). Driven through the real request handler; every request
// is answered by a PostgREST-shaped fetch stub, never a network.
import "./trade_app_visibility_rules_test_env.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { projectJobDetailDocument } from "./dispatch_job_list.ts";
import { _setDefaultLegacyKeyProbeForTest } from "../_shared/service_credential.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11111111-1111-4111-8111-111111111112";
const OLD_QUOTE = "22222222-2222-4222-8222-222222222221";
const NEW_QUOTE = "22222222-2222-4222-8222-222222222222";
const ROUTINE_KEY = "test-routine-key-document-dates";

function tables(): Record<string, any[]> {
  return {
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-261999",
      type: "fencing",
      status: "quoted",
      pricing_json: {},
    }],
    job_documents: [
      {
        id: OLD_QUOTE,
        job_id: JOB,
        type: "quote",
        version: 1,
        quote_number: "Q-1001",
        pdf_url: "https://example.invalid/q1.pdf",
        sent_to_client: true,
        sent_at: "2026-09-01T02:00:00Z",
        superseded_at: "2026-09-10T03:00:00Z",
        created_at: "2026-09-01T01:00:00Z",
      },
      {
        id: NEW_QUOTE,
        job_id: JOB,
        type: "quote",
        version: 2,
        quote_number: "Q-1001",
        pdf_url: "https://example.invalid/q2.pdf",
        sent_to_client: true,
        sent_at: "2026-09-10T03:00:00Z",
        superseded_at: null,
        created_at: "2026-09-10T02:00:00Z",
      },
    ],
  };
}

function matches(row: any, url: URL): boolean {
  for (const [col, filter] of url.searchParams) {
    if (["select", "order", "limit", "offset", "columns"].includes(col)) {
      continue;
    }
    const value = row[col];
    let m: RegExpExecArray | null;
    if ((m = /^eq\.(.*)$/.exec(filter))) {
      if (String(value) !== m[1]) return false;
    } else if ((m = /^neq\.(.*)$/.exec(filter))) {
      if (String(value) === m[1]) return false;
    } else if ((m = /^in\.\((.*)\)$/.exec(filter))) {
      const list = m[1].split(",").map((v) => v.replace(/"/g, "").trim());
      if (!list.includes(String(value))) return false;
    } else if (filter === "is.null") {
      if (value !== null && value !== undefined) return false;
    }
  }
  return true;
}

async function jobDetail() {
  const db = tables();
  const writes: string[] = [];
  const saved = Deno.env.get("MAKESAFE_ROUTINE_KEY");
  Deno.env.set("MAKESAFE_ROUTINE_KEY", ROUTINE_KEY);
  _setDefaultLegacyKeyProbeForTest(() => Promise.resolve("accepted"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const accept = new Headers(init?.headers ?? req?.headers).get("accept") ||
      "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Response.json(rows);
      if (rows.length === 1) return Response.json(rows[0]);
      if (rows.length === 0 && method !== "GET") return Response.json(null);
      return Response.json({ code: "PGRST116", message: "not one row" }, {
        status: 406,
      });
    };
    const table = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") {
      writes.push(`${method} ${table}`);
    }
    const rows = db[table];
    if (!rows) return reply([]);
    return reply(rows.filter((r) => matches(r, url)).map((r) => ({ ...r })));
  }) as typeof fetch;
  try {
    const res = await _opsApiRequestHandlerForTest(
      new Request(
        `https://example.invalid/ops-api?action=job_detail&jobId=${JOB}`,
        { method: "GET", headers: { "x-api-key": ROUTINE_KEY } },
      ),
    );
    return { status: res.status, body: await res.json(), writes };
  } finally {
    globalThis.fetch = originalFetch;
    _setDefaultLegacyKeyProbeForTest(null);
    if (saved === undefined) Deno.env.delete("MAKESAFE_ROUTINE_KEY");
    else Deno.env.set("MAKESAFE_ROUTINE_KEY", saved);
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

handlerTest(
  "job_detail: a superseded quote document carries its sent_at and superseded_at",
  async () => {
    const r = await jobDetail();
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const byId = new Map(r.body.documents.map((d: any) => [d.id, d]));
    const old: any = byId.get(OLD_QUOTE);
    assertEquals(old.sent_at, "2026-09-01T02:00:00Z");
    assertEquals(old.superseded_at, "2026-09-10T03:00:00Z");
    const current: any = byId.get(NEW_QUOTE);
    assertEquals(current.sent_at, "2026-09-10T03:00:00Z");
    assertEquals(current.superseded_at, null);
  },
);

Deno.test("projectJobDetailDocument keeps every earlier key in order and adds the two dates last", () => {
  const row = tables().job_documents[0];
  assertEquals(Object.keys(projectJobDetailDocument(row)), [
    "id",
    "name",
    "file_name",
    "type",
    "version",
    "url",
    "pdf_url",
    "storage_url",
    "thumbnail_url",
    "label",
    "visible_to_trades",
    "sent_to_client",
    "accepted_at",
    "share_token",
    "created_at",
    "quote_number",
    "sent_at",
    "superseded_at",
  ]);
  assertEquals(projectJobDetailDocument(row).name, "quote v1");
  assertEquals(
    projectJobDetailDocument(row).url,
    "https://example.invalid/q1.pdf",
  );
});
