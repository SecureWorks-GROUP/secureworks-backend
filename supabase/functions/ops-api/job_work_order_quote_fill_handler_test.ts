// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// job_detail through the real request handler (docs/quote-work-order-lines-v1.md):
// the routine key's read never fills the job work order draft (its allow-list
// is writes-free), while the ops server key's read does. Every request is
// answered by a PostgREST-shaped fetch stub, never a network.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { _setDefaultLegacyKeyProbeForTest } from "../_shared/service_credential.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11111111-1111-4111-8111-111111111111";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const REV = "55555555-5555-4555-8555-555555555551";
const ROUTINE_KEY = "test-routine-key-quote-fill";

function tables(): Record<string, any[]> {
  return {
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-261527",
      type: "fencing",
      status: "order_materials",
      expected_costs: { scope_revision_id: REV },
      pricing_json: {},
    }],
    work_orders: [{
      id: DRAFT,
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-SWF-261527",
      kind: "job",
      status: "draft",
      scope_items: [],
      agreed_labour_ex: null,
      created_at: "2026-10-09T04:05:04Z",
      updated_at: "2026-10-09T04:05:04Z",
    }],
    scope_revisions: [{
      id: REV,
      job_id: JOB,
      revision_number: 1,
      status: "frozen",
      frozen_at: "2026-10-05T08:55:20Z",
      pricing_canonical_text: JSON.stringify({
        line_items: [{
          unit: "m",
          category: "fencing",
          quantity: 10,
          description: "4× Ridgeside (10.0m total)",
        }],
        labourCostEstimate: 350,
      }),
    }],
    scope_tool_defaults: [{
      org_id: ORG,
      scope_tool: "fence-designer",
      item_key: "base-labour",
      default_cost_rate: "35.00",
      last_updated_at: "2026-09-01T00:00:00+00:00",
    }],
    job_events: [],
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

async function jobDetailAs(headers: Record<string, string>) {
  return await requestAs(
    `https://example.invalid/ops-api?action=job_detail&jobId=${JOB}`,
    { method: "GET", headers },
  );
}

// The automatic issue door as the database answers it: only while the flag
// row is on, only the draft as read, sealed with no approver.
function autoIssueRpc(db: Record<string, any[]>, args: any) {
  const on = (db.feature_flags || []).some((f) =>
    f.flag_name === "job_work_order_auto_issue_v1" && f.enabled === true
  );
  if (!on) {
    return Response.json({ code: "42501", message: "switched off" }, {
      status: 403,
    });
  }
  const wo = db.work_orders.find((w) => w.id === args.p_work_order_id);
  if (
    !wo || wo.status !== "draft" ||
    wo.updated_at !== args.p_expected_updated_at
  ) {
    return Response.json({ code: "WO409", message: "changed" }, {
      status: 409,
    });
  }
  if (!wo.quote_filled_at || wo.hand_edited_at) {
    return Response.json({ code: "WO423", message: "not issuable" }, {
      status: 409,
    });
  }
  Object.assign(wo, {
    status: "approved",
    approved_by: null,
    approved_via: "auto",
    approved_at: "2026-10-14T00:00:00Z",
  });
  return Response.json({ ...wo });
}

async function requestAs(
  href: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
  setup: (db: Record<string, any[]>) => void = () => {},
) {
  const db = tables();
  setup(db);
  const writes: string[] = [];
  const saved = new Map(
    ["MAKESAFE_ROUTINE_KEY"].map((n) => [n, Deno.env.get(n)]),
  );
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
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (rpc) {
      writes.push(`RPC ${rpc}`);
      const raw = init?.body;
      const args = typeof raw === "string" && raw ? JSON.parse(raw) : {};
      if (rpc === "auto_issue_job_work_order") return autoIssueRpc(db, args);
      return Response.json(null);
    }
    const table = url.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") {
      writes.push(`${method} ${table}`);
    }
    const rows = db[table];
    if (!rows) return reply([]);
    const raw = init?.body;
    const payload = typeof raw === "string" && raw ? JSON.parse(raw) : {};
    if (method === "POST") {
      const list = Array.isArray(payload) ? payload : [payload];
      rows.push(...list);
      return reply(list);
    }
    const hit = rows.filter((r) => matches(r, url));
    if (method === "PATCH") {
      for (const r of hit) {
        Object.assign(r, payload, { updated_at: "2026-10-13T00:00:00Z" });
      }
    }
    return reply(hit.map((r) => ({ ...r })));
  }) as typeof fetch;
  try {
    const res = await _opsApiRequestHandlerForTest(
      new Request(href, {
        method: init.method,
        headers: { "content-type": "application/json", ...init.headers },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    const body = await res.json();
    return { status: res.status, body, writes, db };
  } finally {
    globalThis.fetch = originalFetch;
    _setDefaultLegacyKeyProbeForTest(null);
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

handlerTest(
  "job_detail with the routine key reads the work order and writes nothing to it",
  async () => {
    const r = await jobDetailAs({ "x-api-key": ROUTINE_KEY });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.job_work_order.quote_fill, null);
    assertEquals(r.body.job_work_order.work_order.scope_items, []);
    assertEquals(
      r.writes.filter((w) => /work_orders|job_events/.test(w)),
      [],
    );
    assertEquals(r.db.work_orders[0].agreed_labour_ex, null);
  },
);

handlerTest(
  "job_detail with the ops server key fills the untouched draft from the accepted quote",
  async () => {
    const r = await jobDetailAs({
      authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.job_work_order.quote_fill.filled, true);
    assert(r.writes.includes("PATCH work_orders"));
    assertEquals(r.db.work_orders[0].agreed_labour_ex, 350);
  },
);

const SERVER = () => ({
  authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
});
const autoIssueOn = (db: Record<string, any[]>) => {
  db.feature_flags = [{
    flag_name: "job_work_order_auto_issue_v1",
    enabled: true,
  }];
};

handlerTest(
  "job_detail tells the office why a filled draft has not gone to the trades: automatic issue is off",
  async () => {
    const r = await jobDetailAs(SERVER());
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const note = r.body.job_work_order.needs_checking;
    assertEquals(note.issued_automatically, false);
    assertEquals(note.held.reason, "auto_issue_switched_off");
    assertEquals(note.needs_checking, false);
    // The read filled the draft as the quote fill's own.
    assert(r.db.work_orders[0].quote_filled_at);
  },
);

handlerTest(
  "auto_issue_job_work_orders: the ops server key only; the routine key is refused",
  async () => {
    const r = await requestAs(
      "https://example.invalid/ops-api?action=auto_issue_job_work_orders",
      { method: "POST", headers: { "x-api-key": ROUTINE_KEY }, body: {} },
      autoIssueOn,
    );
    assertEquals(r.status, 403, JSON.stringify(r.body));
    assertEquals(r.writes, []);
  },
);

handlerTest(
  "auto_issue_job_work_orders: switched off, nothing is filled or issued",
  async () => {
    const r = await requestAs(
      "https://example.invalid/ops-api?action=auto_issue_job_work_orders",
      { method: "POST", headers: SERVER(), body: {} },
    );
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.switched_on, false);
    assertEquals(r.writes, []);
    assertEquals(r.db.work_orders[0].status, "draft");
  },
);

handlerTest(
  "a status change into an approved status fills the draft and issues it to the trades while automatic issue is on",
  async () => {
    const r = await requestAs(
      "https://example.invalid/ops-api?action=update_job_status",
      {
        method: "POST",
        headers: SERVER(),
        body: { job_id: JOB, status: "scheduled" },
      },
      autoIssueOn,
    );
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const wo = r.db.work_orders[0];
    assertEquals(wo.status, "approved");
    assertEquals(wo.approved_via, "auto");
    assertEquals(wo.approved_by, null);
    assertEquals(wo.agreed_labour_ex, 350);
    assert(r.writes.includes("RPC auto_issue_job_work_order"));
    const issued = r.db.job_events.find((e: any) =>
      e.event_type === "job_work_order_auto_issued"
    );
    assert(issued, "the issue is recorded on the job");
    assert(!JSON.stringify(issued).includes("350"));
  },
);

handlerTest(
  "a status change with automatic issue off leaves the draft for the approver",
  async () => {
    const r = await requestAs(
      "https://example.invalid/ops-api?action=update_job_status",
      {
        method: "POST",
        headers: SERVER(),
        body: { job_id: JOB, status: "scheduled" },
      },
    );
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.db.work_orders[0].status, "draft");
    assert(!r.writes.includes("RPC auto_issue_job_work_order"));
    assert(!r.writes.includes("PATCH work_orders"));
  },
);
