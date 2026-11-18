// P1-04.3 backend: drive the real submit handler; every fetch is stubbed.
// Only invented roles, job numbers and figures. No live service is called.
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { _resetSwitchCacheForTest } from "../_shared/switch_cache.ts";

const TRADE = "00000000-0000-4000-8000-000000000101";
const OTHER = "00000000-0000-4000-8000-000000000102";
const ORG = "00000000-0000-4000-8000-000000000103";
const JOB = "00000000-0000-4000-8000-000000000104";
const INVOICE = "00000000-0000-4000-8000-000000000105";
const LINE = "00000000-0000-4000-8000-000000000106";
const RECORD = {
  job_id: JOB,
  commission_id: "commission-fixture",
  budget_id: "budget-fixture",
  version: 1,
  state: "named",
  salesperson_user_id: TRADE,
  rule_id: null,
  percent: null,
  expected_amount_ex_gst: 81.25,
  claimed_ex_gst: 20,
  remaining_ex_gst: 61.25,
};
const item = (over: any = {}) => ({
  id: LINE,
  type: "Commission",
  job_id: JOB,
  job_number: "ZZTEST-1043",
  quantity: 1,
  description: "Commission",
  ...over,
});

type World = {
  enabled?: boolean;
  flagMissing?: boolean;
  flagFailed?: boolean;
  record?: any;
  readFailed?: boolean;
};

async function submit(items: any[], world: World = { enabled: true }) {
  const lineRows: any[] = [];
  const invoiceRows: any[] = [];
  const writes: string[] = [];
  const ignored: any[][] = [];
  const external: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  _resetSwitchCacheForTest();
  console.warn = (...args: any[]) => {
    if (String(args[0]).includes("commission_client_amount_ignored")) {
      ignored.push(args);
    }
  };
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    const accept = new Headers(init?.headers).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) {
        return Promise.resolve(Response.json(rows));
      }
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (!rows.length && accept.includes("nulls=stripped")) {
        return Promise.resolve(Response.json(null));
      }
      return Promise.resolve(
        Response.json({ code: "PGRST116", message: "no rows" }, {
          status: 406,
        }),
      );
    };
    const filter = (rows: any[]) =>
      rows.filter((row) => {
        for (const [key, raw] of url.searchParams) {
          if (
            raw.startsWith("eq.") && String(row[key]) !== raw.slice(3)
          ) return false;
          if (
            raw.startsWith("in.(") &&
            !raw.slice(4, -1).split(",").map((v) => v.replaceAll('"', ""))
              .includes(String(row[key]))
          ) return false;
        }
        return true;
      });
    const fail = () =>
      Promise.resolve(
        Response.json({ code: "XX000", message: "fixture read failure" }, {
          status: 500,
        }),
      );
    if (url.pathname === "/auth/v1/user") {
      return Promise.resolve(
        Response.json({ id: TRADE, email: "", aud: "authenticated" }),
      );
    }
    if (!url.pathname.startsWith("/rest/v1/")) {
      external.push(url.origin + url.pathname);
      return Promise.reject(new Error("Unexpected external request"));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      writes.push("RPC " + url.pathname.split("/").at(-1));
      return Promise.resolve(Response.json(INVOICE));
    }
    const table = url.pathname.slice("/rest/v1/".length);
    if (method !== "GET" && method !== "HEAD") {
      writes.push(method + " " + table);
    }
    const posted = () => {
      const raw = JSON.parse(String(init?.body ?? "[]"));
      return Array.isArray(raw) ? raw : [raw];
    };
    if (table === "users") {
      return reply([{
        id: TRADE,
        org_id: ORG,
        role: "lead_installer",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        invoice_type: "hourly",
        trade_details: {},
        invoice_any_job: null,
      }]);
    }
    if (table === "jobs") {
      return reply(filter([{
        id: JOB,
        org_id: ORG,
        job_number: "ZZTEST-1043",
        type: "fencing",
        status: "scheduled",
        metadata: {},
        created_by: TRADE,
      }]));
    }
    if (table === "feature_flags") {
      if (
        world.flagFailed &&
        url.searchParams.get("flag_name") === "eq.commission_from_job_only_v1"
      ) return fail();
      return reply(filter(
        world.flagMissing ? [] : [{
          flag_name: "commission_from_job_only_v1",
          enabled: world.enabled === true,
        }],
      ));
    }
    if (
      table === "job_assignments" && url.searchParams.get("select") === "job_id"
    ) return reply([{ job_id: JOB }]);
    if (table === "v_job_commission") {
      if (world.readFailed) return fail();
      return reply(
        filter(world.record === null ? [] : [world.record ?? RECORD]),
      );
    }
    if (table === "trade_invoice_extra_rate_rules") {
      return reply([{ line_type: "*", max_unit_rate_ex: 1 }]);
    }
    if (table === "trade_rates") {
      return reply([{ hourly_rate: 13, effective_from: "2026-01-01" }]);
    }
    if (table === "trade_invoices" && method === "POST") {
      invoiceRows.push(...posted());
      return reply([{ id: INVOICE }]);
    }
    if (
      table === "trade_invoices" && (method === "PATCH" || method === "DELETE")
    ) return reply([{ id: INVOICE }]);
    if (table === "trade_invoice_lines" && method === "POST") {
      lineRows.push(...posted());
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const response = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=generate_trade_invoice",
        {
          method: "POST",
          headers: {
            authorization: "Bearer fixture-jwt",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            week_start: "2026-11-02",
            gst_on: false,
            extra_items: items,
          }),
        },
      ),
    );
    return {
      status: response.status,
      body: await response.json(),
      lineRows,
      invoiceRows,
      writes,
      ignored,
      external,
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    _resetSwitchCacheForTest();
  }
}

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name: "offered commission: " + name,
    fn,
    sanitizeOps: false,
    sanitizeResources: false,
  });

function saved(out: Awaited<ReturnType<typeof submit>>, figure: number) {
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.lineRows.length, 1);
  const line = out.lineRows[0];
  assertEquals([line.quantity, line.unit_rate, line.line_total_ex], [
    1,
    figure,
    figure,
  ]);
  assertEquals(out.invoiceRows[0].subtotal_ex, figure);
  assertEquals(out.external, []);
}

test("no screen rate passes the weekly 422 check with the server figure", async () => {
  const out = await submit([item()]);
  saved(out, 61.25);
  assertEquals(
    out.lineRows[0].office_review_status,
    null,
    "an offered figure is not a typed rate",
  );
  assertEquals(out.lineRows[0].query_note, null);
  assertEquals(out.ignored, []);
});

test("screen rate and amounts are ignored, with only the line id logged", async () => {
  const out = await submit([
    item({
      rate: 999,
      amount: 888,
      commission_amount: 777,
      line_total_ex: 666,
      unit_rate: 555,
      quantity: 9,
    }),
  ]);
  saved(out, 61.25);
  assertEquals(out.ignored, [["[ops-api] commission_client_amount_ignored", {
    line_id: LINE,
  }]]);
});

test("a line id that is not an app id (an email) is logged as null", async () => {
  for (
    const over of [
      { id: undefined, line_id: "someone@example.com" },
      { id: "someone@example.com" },
      { id: "il-1763420000000-ab12", line_id: "someone@example.com" },
    ]
  ) {
    const out = await submit([item({ ...over, rate: 999 })]);
    saved(out, 61.25);
    assertEquals(out.ignored, [["[ops-api] commission_client_amount_ignored", {
      line_id: null,
    }]]);
    assert(!JSON.stringify(out.ignored).includes("@"));
  }
});

test("the Trade App's own local line id is logged as it is", async () => {
  const out = await submit([item({ id: "il-1763420000000-ab12", rate: 999 })]);
  saved(out, 61.25);
  assertEquals(out.ignored, [["[ops-api] commission_client_amount_ignored", {
    line_id: "il-1763420000000-ab12",
  }]]);
});

test("office record changes are read on resubmit, never the screen snapshot", async () => {
  const out = await submit([item({ rate: 61.25 })], {
    enabled: true,
    record: { ...RECORD, remaining_ex_gst: 42.75, claimed_ex_gst: 38.5 },
  });
  saved(out, 42.75);
});

test("a failed record read saves nothing; a retry reads the record anew", async () => {
  const failed = await submit([item()], { enabled: true, readFailed: true });
  assertEquals(failed.status, 503);
  assertEquals(failed.writes, []);
  saved(await submit([item()]), 61.25);
});

test("missing, unknown and claimed records never create an offer", async () => {
  for (
    const record of [null, {
      ...RECORD,
      state: "no_amount",
      expected_amount_ex_gst: null,
      remaining_ex_gst: null,
    }, { ...RECORD, remaining_ex_gst: 0 }]
  ) {
    const out = await submit([item()], { enabled: true, record });
    assert(out.status >= 400);
    assertEquals(out.writes, []);
  }
});

test("another salesperson and duplicate commission lines save nothing", async () => {
  const wrong = await submit([item()], {
    enabled: true,
    record: { ...RECORD, salesperson_user_id: OTHER },
  });
  assertEquals(wrong.status, 403);
  assertEquals(wrong.writes, []);
  const duplicate = await submit([item(), item({ id: "extra-second" })]);
  assertEquals(duplicate.status, 409);
  assertEquals(duplicate.body.code, "commission_over_amount");
  assertEquals(duplicate.writes, []);
});

test("switch off, missing or unreadable keeps main's typed figure and rate hold", async () => {
  for (
    const world of [{ enabled: false }, { flagMissing: true }, {
      flagFailed: true,
    }]
  ) {
    const out = await submit([item({ rate: 7.25 })], world);
    saved(out, 7.25);
    assertEquals(out.lineRows[0].office_review_status, "awaiting");
    assertEquals(out.ignored, []);
    const noRate = await submit([item()], world);
    assertEquals(noRate.status, 422);
    assertEquals(noRate.writes, []);
  }
});

test("switch off parity fixture retains the full saved line", async () => {
  const out = await submit([item({ rate: 7.25 })], { enabled: false });
  saved(out, 7.25);
  assertEquals({ lines: out.lineRows, external: out.external }, {
    "lines": [
      {
        "trade_invoice_id": "00000000-0000-4000-8000-000000000105",
        "job_id": "00000000-0000-4000-8000-000000000104",
        "job_number": "ZZTEST-1043",
        "client_name": null,
        "total_hours": 1,
        "hourly_rate": null,
        "line_total_ex": 7.25,
        "work_order_hours": null,
        "days_worked": null,
        "assignment_ids": null,
        "acknowledgment_status": "pending",
        "query_note":
          "Client-entered rate: $7.25/hr. Ops must verify before approval. | Typed rate is above the office limit for this line type. Held for office review.",
        "line_type": "commission",
        "expense_receipt_id": null,
        "office_review_note": null,
        "description": "Commission",
        "quantity": 1,
        "unit": "ea",
        "unit_rate": 7.25,
        "line_date": null,
        "division": "fencing",
        "site_address": null,
        "source_work_order_id": null,
        "group_share_id": null,
        "office_review_status": "awaiting",
        "source_trade_invoice_line_id": null,
        "deduction_user_id": null,
        "deduction_assignment_id": null,
        "deduction_trade_rate_id": null,
        "line_position": null,
        "flag_type": null,
        "baseline_hours": null,
        "baseline_source": null,
        "hours_justification": null,
        "flagged_at": null,
        "wo_allocated": null,
        "wo_labour_deduction": null,
        "wo_labour_lines": null,
        "work_date": null,
        "start_time": null,
        "finish_time": null,
        "break_minutes": null,
      },
    ],
    "external": [],
  });
});

test("each screen price alias is ignored even without a rate", async () => {
  for (
    const key of ["amount", "commission_amount", "line_total_ex", "unit_rate"]
  ) {
    const out = await submit([item({ [key]: 99 })]);
    saved(out, 61.25);
    assertEquals(out.ignored, [["[ops-api] commission_client_amount_ignored", {
      line_id: LINE,
    }]]);
  }
});

test("a screen offer marker cannot invent a missing server offer", async () => {
  const out = await submit([
    item({
      commission: { state: "offer", offer_ex: 99 },
      rate_source: "server_resolved",
    }),
  ], { enabled: true, record: null });
  assertEquals(out.status, 422);
  assertEquals(out.writes, []);
});

test("job-number-only and trimmed commission types use the same server record", async () => {
  const out = await submit([
    item({
      job_id: null,
      job_number: "  ZZTEST-1043  ",
      type: "  COMMISSION  ",
    }),
  ]);
  saved(out, 61.25);
  assertEquals(out.lineRows[0].job_id, JOB);
});

test("a non-commission line keeps its typed figure with the switch on", async () => {
  const out = await submit([item({ type: "Other", rate: 7.25 })]);
  saved(out, 7.25);
  assertEquals(out.lineRows[0].office_review_status, "awaiting");
  assertEquals(out.ignored, []);
});
