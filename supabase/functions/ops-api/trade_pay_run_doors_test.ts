// deno-lint-ignore-file no-explicit-any no-import-prefix
// cl-1622-fix, director 15:22 (c): with trade_pay_run_v1 ON, every office
// door checks the run before it acts on an invoice a run approved. One test
// per door, through the real ops-api handler against a PostgREST-shaped stub:
// the door answers 409 invoice_in_pay_run, writes nothing and calls nothing
// outside. The rule is read off the row each door already reads (no extra
// read). Every id, number and word is made up.
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { releasedGroupSiblingInvoiceIds } from "./group_work_order.ts";
import { PAY_RUN_HELD_CODE } from "./trade_pay_run_hold.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OFFICE = "0a210000-0000-4000-8000-000000000001";
const TRADE = "0a210000-0000-4000-8000-000000000002";
const RUN = "0b310000-0000-4000-8000-000000000001";
const INV = "0c410000-0000-4000-8000-00000000000a";
const LINE = "0c510000-0000-4000-8000-00000000000a";

type Seen = {
  status: number;
  body: any;
  writes: string[];
  writeQueries: string[];
  reads: string[];
  outside: string[];
  invoiceSelects: string[];
};

/** A run-stamped invoice, at the status a run leaves it in. */
function stamped(status: string) {
  return {
    id: INV,
    org_id: ORG,
    user_id: TRADE,
    status,
    pay_run_id: RUN,
    invoice_kind: "standard",
    xero_bill_id: null,
    xero_pushed_at: null,
    query_note: null,
    invoice_number: "ZZT-0001",
    net_pay: 940,
    user: { id: TRADE, name: "Fixture Trade", email: "", xero_contact_id: null },
  };
}

/** The same invoice, never stamped by a run. */
function free(status: string) {
  return { ...stamped(status), pay_run_id: null };
}

async function press(action: string, body: Record<string, unknown>, invoice: Record<string, unknown>): Promise<Seen> {
  const writes: string[] = [];
  const writeQueries: string[] = [];
  const reads: string[] = [];
  const outside: string[] = [];
  const invoiceSelects: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") {
      outside.push(url.hostname);
      return Promise.resolve(Response.json({}, { status: 500 }));
    }
    const method = String(init?.method ?? "GET").toUpperCase();
    const accept = new Headers(init?.headers).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (accept.includes("nulls=stripped")) return Promise.resolve(Response.json(null));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: OFFICE, email: "", aud: "authenticated" }));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      writes.push(url.pathname);
      return Promise.resolve(Response.json(null));
    }
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    if (method !== "GET" && method !== "HEAD") {
      writes.push(`${method} ${table}`);
      writeQueries.push(`${table}?${decodeURIComponent(url.search)}`);
      // A write the filters let through answers with the row it moved.
      return reply(table === "trade_invoices" ? [{ id: INV, status: "approved" }] : []);
    }
    reads.push(table);
    if (table === "users") {
      return reply([{ id: OFFICE, org_id: ORG, role: "admin", name: "Fixture Office", managed_verticals: [], trade_sees_all_jobs: true }]);
    }
    if (table === "feature_flags") {
      const names = url.searchParams.get("flag_name") ?? "";
      return reply(names.includes("trade_pay_run_v1") ? [{ flag_name: "trade_pay_run_v1", enabled: true }] : []);
    }
    if (table === "work_order_settings") {
      return reply([{ id: 1, owner_user_ids: [OFFICE], approver_user_ids: [OFFICE], backup_approver_user_ids: [] }]);
    }
    if (table === "trade_invoices") {
      invoiceSelects.push(url.searchParams.get("select") ?? "");
      return reply([invoice]);
    }
    if (table === "trade_invoice_lines") {
      return reply([{
        id: LINE,
        trade_invoice_id: INV,
        office_review_status: "awaiting",
        line_type: "materials",
        trade_invoices: invoice,
      }]);
    }
    return reply([]);
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer office-jwt", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, writes, writeQueries, reads, outside, invoiceSelects };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
}

const door = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function assertRefused(out: Seen) {
  assertEquals(out.status, 409, JSON.stringify(out.body));
  assertEquals(out.body.code, PAY_RUN_HELD_CODE, JSON.stringify(out.body));
  assertEquals(out.writes, [], "nothing written");
  assertEquals(out.outside, [], "nothing outside (no Xero)");
}

door("door 1, office Approve: a run's invoice is refused 409, nothing written", async () => {
  const out = await press("approve_trade_invoice", { invoice_id: INV }, stamped("pending_ops_review"));
  assertRefused(out);
  // One read of the invoice, which names pay_run_id: no extra read.
  assertEquals(out.invoiceSelects.length, 1);
  assert(out.invoiceSelects[0].includes("pay_run_id"), out.invoiceSelects[0]);
});

door("door 1 control, office Approve: a free invoice is approved (200), by a write that only moves an unstamped row", async () => {
  const out = await press("approve_trade_invoice", { invoice_id: INV }, free("pending_ops_review"));
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.body.status, "approved");
  assertEquals(out.writes, ["PATCH trade_invoices"]);
  assert(out.writeQueries[0].includes("pay_run_id=is.null"), out.writeQueries[0]);
});

door("door 2, office push: a run's invoice (even at approved after the run's move) is refused 409 before any line read or Xero", async () => {
  for (const status of ["pending_ops_review", "approved"]) {
    const out = await press("push_trade_invoice_to_xero", { invoice_id: INV }, stamped(status));
    assertRefused(out);
    assertEquals(out.invoiceSelects.length, 1, status);
  }
});

door("door 2 control, office push: a free invoice goes on past the run rule to its lines", async () => {
  const out = await press("push_trade_invoice_to_xero", { invoice_id: INV }, free("approved"));
  assert(out.body.code !== PAY_RUN_HELD_CODE, JSON.stringify(out.body));
  assert(out.reads.includes("trade_invoice_lines"), out.reads.join(","));
  // '*' carries pay_run_id on the one invoice read.
  assert(out.invoiceSelects[0].startsWith("*"), out.invoiceSelects[0]);
});

door("door 2b, office reject: a run's invoice is refused 409, nothing written", async () => {
  const out = await press("reject_trade_invoice", { invoice_id: INV, note: "ZZTEST" }, stamped("pending_ops_review"));
  assertRefused(out);
  assertEquals(out.invoiceSelects.length, 1);
  assert(out.invoiceSelects[0].includes("pay_run_id"), out.invoiceSelects[0]);
});

door("door 2b control, office reject: a free invoice reaches the reject write", async () => {
  const out = await press("reject_trade_invoice", { invoice_id: INV, note: "ZZTEST" }, free("pending_ops_review"));
  assert(out.body.code !== PAY_RUN_HELD_CODE, JSON.stringify(out.body));
  assert(out.writes.includes("PATCH trade_invoices"), out.writes.join(","));
});

door("door 3, line review: a line on a run's invoice is refused 409, no line or invoice write, no push", async () => {
  const out = await press("review_crew_invoice_line", { line_id: LINE, decision: "approve" }, stamped("pending_ops_review"));
  assertRefused(out);
  // The run is read off the line's own invoice embed.
  assertEquals(out.invoiceSelects.length, 0);
});

door("door 3 control, line review: a line on a free invoice is reviewed (the line write happens)", async () => {
  const out = await press("review_crew_invoice_line", { line_id: LINE, decision: "approve" }, free("pending_ops_review"));
  assert(out.body.code !== PAY_RUN_HELD_CODE, JSON.stringify(out.body));
  assert(out.writes.includes("PATCH trade_invoice_lines"), out.writes.join(","));
});

door("door 5, stuck-invoice release: a run's invoice is refused 409 before any line read, Xero search or write", async () => {
  for (const decision of ["release", "send_to_xero"]) {
    const out = await press("resolve_stuck_trade_invoice", { invoice_id: INV, decision, reason: "ZZTEST reason" }, stamped("pending_ops_review"));
    assertRefused(out);
    assertEquals(out.invoiceSelects.length, 1, decision);
    assert(out.invoiceSelects[0].includes("pay_run_id"), out.invoiceSelects[0]);
  }
});

door("door 5 control, stuck-invoice release: a free invoice goes on past the run rule to its lines", async () => {
  const out = await press("resolve_stuck_trade_invoice", { invoice_id: INV, decision: "release", reason: "ZZTEST reason" }, free("pending_acknowledgment"));
  assert(out.body.code !== PAY_RUN_HELD_CODE, JSON.stringify(out.body));
  assert(out.reads.includes("trade_invoice_lines"), out.reads.join(","));
});

Deno.test("door 4, crewmate sibling push: a run's invoice is never listed as a released sibling", async () => {
  const SIB = "0c410000-0000-4000-8000-00000000000b";
  const FREE = "0c410000-0000-4000-8000-00000000000c";
  const OWN = "0c410000-0000-4000-8000-00000000000d";
  const selects: string[] = [];
  const rows: Record<string, any[]> = {
    "trade_invoice_lines:group_share_id": [{ group_share_id: "share-1" }],
    "group_work_order_shares:group_id": [{ group_id: "group-1" }],
    "group_work_order_releases": [{ group_id: "group-1" }],
    "group_work_order_shares:id": [{ id: "share-1" }, { id: "share-2" }, { id: "share-3" }],
    "trade_invoice_lines:embed": [
      { trade_invoice_id: SIB, invoice: { id: SIB, status: "approved", xero_bill_id: null, pay_run_id: RUN } },
      { trade_invoice_id: FREE, invoice: { id: FREE, status: "approved", xero_bill_id: null, pay_run_id: null } },
    ],
  };
  const client = {
    from(table: string) {
      let cols = "";
      const q: any = {
        select(c: string) {
          cols = c;
          selects.push(`${table}:${c}`);
          return q;
        },
        eq: () => q,
        in: () => q,
        not: () => q,
        then(res: any, rej: any) {
          const key = table === "trade_invoice_lines" && cols.includes("invoice:")
            ? "trade_invoice_lines:embed"
            : table === "group_work_order_releases" ? table : `${table}:${cols}`;
          return Promise.resolve({ data: rows[key] ?? [], error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
  assertEquals(await releasedGroupSiblingInvoiceIds(client, OWN), [FREE]);
  assert(selects.some((s) => s.includes("pay_run_id")), selects.join(" | "));
});

Deno.test("door 4, crewmate sibling push: a sibling the push refuses for its run is reported, never marked for retry", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = src.indexOf("async function pushReleasedGroupSiblings(");
  const fn = src.slice(at, src.indexOf("\n}\n", at));
  const skip = fn.indexOf("=== PAY_RUN_HELD_CODE");
  const mark = fn.indexOf("await markTradeInvoiceRetryable(");
  assert(skip > 0 && mark > skip, "the run refusal is handled before the retry mark");
  assert(fn.slice(skip, mark).includes("continue"));
});
