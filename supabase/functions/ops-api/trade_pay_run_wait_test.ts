/**
 * P1-10.4: with the weekly pay run on, a sent invoice waits for the run.
 *
 * Spec test 29 runs through the REAL generate_trade_invoice handler against a
 * PostgREST-shaped fetch stub: switch on, the invoice ends pending_ops_review
 * with no bill and the stub sees no Xero request and no Xero token read.
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  _claimWorkOrderInvoiceBeforeXero,
  _opsApiRequestHandlerForTest,
} from "./index.ts";
import {
  holdTradeInvoiceForPayRun,
  PAY_RUN_HOLD_FAILED_DRAFT_WORDS,
  PAY_RUN_HOLD_FAILED_WORDS,
  PAY_RUN_SWITCH_UNREADABLE_WORDS,
  PAY_RUN_WAIT_WORDS,
  payRunNoXeroBoundary,
  payRunWaitResponse,
  readPayRunSwitchForSubmit,
} from "./trade_pay_run_wait.ts";

const INVOICE_ID = "6c2f0a52-0000-4000-8000-00000000e001";

// ── A tiny client for the module's two reads/writes ─────────────────────────

function fakeClient(opts: {
  flag?: { data?: any; error?: any; throws?: boolean };
  update?: { data?: any; error?: any };
}) {
  const calls: Array<{ table: string; op: string; args: any[] }> = [];
  const client = {
    calls,
    from(table: string) {
      const filters: any[] = [];
      let op = "select";
      let payload: any = null;
      const q: any = {
        select(...a: any[]) {
          filters.push(["select", ...a]);
          return q;
        },
        update(p: any) {
          op = "update";
          payload = p;
          return q;
        },
        eq(...a: any[]) {
          filters.push(["eq", ...a]);
          return q;
        },
        is(...a: any[]) {
          filters.push(["is", ...a]);
          return q;
        },
        limit(...a: any[]) {
          filters.push(["limit", ...a]);
          if (opts.flag?.throws) throw new Error("boom");
          calls.push({ table, op, args: filters });
          return Promise.resolve({
            data: opts.flag?.data ?? null,
            error: opts.flag?.error ?? null,
          });
        },
        maybeSingle() {
          calls.push({ table, op, args: [payload, ...filters] });
          return Promise.resolve({
            data: opts.update?.data ?? null,
            error: opts.update?.error ?? null,
          });
        },
      };
      return q;
    },
  };
  return client;
}

Deno.test("switch read: on, off, missing row is off, anything else is unreadable", async () => {
  assertEquals(
    await readPayRunSwitchForSubmit(
      fakeClient({ flag: { data: [{ enabled: true }] } }),
    ),
    "on",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(
      fakeClient({ flag: { data: [{ enabled: false }] } }),
    ),
    "off",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(fakeClient({ flag: { data: [] } })),
    "off",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(
      fakeClient({ flag: { error: { code: "XX000" } } }),
    ),
    "unreadable",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(fakeClient({ flag: { data: null } })),
    "unreadable",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(
      fakeClient({ flag: { data: [{ enabled: null }] } }),
    ),
    "unreadable",
  );
  assertEquals(
    await readPayRunSwitchForSubmit(fakeClient({ flag: { throws: true } })),
    "unreadable",
  );
  // The read names the switch by its key.
  const c = fakeClient({ flag: { data: [{ enabled: true }] } });
  await readPayRunSwitchForSubmit(c);
  assertEquals(c.calls[0].table, "feature_flags");
  assertEquals(c.calls[0].args.find((a: any) => a[0] === "eq"), [
    "eq",
    "flag_name",
    "trade_pay_run_v1",
  ]);
});

Deno.test("hold: switch off writes nothing", async () => {
  const c = fakeClient({});
  assertEquals(
    await holdTradeInvoiceForPayRun(
      c,
      INVOICE_ID,
      "pending_acknowledgment",
      "off",
    ),
    { waits: false },
  );
  assertEquals(c.calls, []);
});

Deno.test("hold: switch on moves only the saved status, only with no bill, to pending_ops_review", async () => {
  for (const saved of ["pending_acknowledgment", "draft"] as const) {
    const c = fakeClient({
      update: { data: { id: INVOICE_ID, status: "pending_ops_review" } },
    });
    const wait = await holdTradeInvoiceForPayRun(c, INVOICE_ID, saved, "on");
    assertEquals(wait, {
      waits: true,
      reason: "pay_run_on",
      held: true,
      savedStatus: saved,
    });
    assertEquals(c.calls.length, 1);
    const [payload, ...filters] = c.calls[0].args;
    assertEquals(c.calls[0].table, "trade_invoices");
    assertEquals(payload, { status: "pending_ops_review" });
    assert(
      filters.some((f: any) =>
        f[0] === "eq" && f[1] === "id" && f[2] === INVOICE_ID
      ),
    );
    assert(
      filters.some((f: any) =>
        f[0] === "eq" && f[1] === "status" && f[2] === saved
      ),
    );
    assert(
      filters.some((f: any) =>
        f[0] === "is" && f[1] === "xero_bill_id" && f[2] === null
      ),
    );
  }
});

Deno.test("hold: an unreadable switch still waits, never pushes", async () => {
  const c = fakeClient({
    update: { data: { id: INVOICE_ID, status: "pending_ops_review" } },
  });
  assertEquals(
    await holdTradeInvoiceForPayRun(
      c,
      INVOICE_ID,
      "pending_acknowledgment",
      "unreadable",
    ),
    {
      waits: true,
      reason: "pay_run_switch_unreadable",
      held: true,
      savedStatus: "pending_acknowledgment",
    },
  );
});

Deno.test("hold: a refused or missed write still waits, and says it was not held", async () => {
  // The crew release guard refuses a move on a released group (group_released).
  const refused = fakeClient({ update: { error: { code: "23514" } } });
  assertEquals(
    await holdTradeInvoiceForPayRun(
      refused,
      INVOICE_ID,
      "pending_acknowledgment",
      "on",
    ),
    {
      waits: true,
      reason: "pay_run_on",
      held: false,
      savedStatus: "pending_acknowledgment",
    },
  );
  // Already billed or already moved: no row comes back.
  const missed = fakeClient({ update: { data: null } });
  assertEquals(
    await holdTradeInvoiceForPayRun(missed, INVOICE_ID, "draft", "on"),
    { waits: true, reason: "pay_run_on", held: false, savedStatus: "draft" },
  );
});

Deno.test("answer: codes, words, and no bill on every waiting answer", () => {
  const on = payRunWaitResponse({
    waits: true,
    reason: "pay_run_on",
    held: true,
    savedStatus: "pending_acknowledgment",
  });
  assertEquals(on.code, "pay_run_waits");
  assertEquals(on.ok, true);
  assertEquals(on.pay_run, {
    waits: true,
    held: true,
    words: PAY_RUN_WAIT_WORDS,
  });
  assertEquals([on.xero_bill_id, on.xero_bill_number, on.pdf_attached], [
    null,
    null,
    false,
  ]);
  const unread = payRunWaitResponse({
    waits: true,
    reason: "pay_run_switch_unreadable",
    held: true,
    savedStatus: "pending_acknowledgment",
  });
  assertEquals([unread.code, (unread.pay_run as any).words], [
    "pay_run_switch_unreadable",
    PAY_RUN_SWITCH_UNREADABLE_WORDS,
  ]);
  const failed = payRunWaitResponse({
    waits: true,
    reason: "pay_run_on",
    held: false,
    savedStatus: "pending_acknowledgment",
  });
  assertEquals([failed.ok, failed.code, (failed.pay_run as any).words], [
    false,
    "pay_run_hold_failed",
    PAY_RUN_HOLD_FAILED_WORDS,
  ]);
  assertEquals(failed.xero_bill_id, null);
  // A work order invoice that could not be held is still the trade's draft,
  // which the office never sees: the trade is told to send it again.
  const failedDraft = payRunWaitResponse({
    waits: true,
    reason: "pay_run_on",
    held: false,
    savedStatus: "draft",
  });
  assertEquals(
    (failedDraft.pay_run as any).words,
    PAY_RUN_HOLD_FAILED_DRAFT_WORDS,
  );
});

Deno.test("work order door: waiting saves the invoice and never opens Xero", async () => {
  const events: string[] = [];
  const result = await _claimWorkOrderInvoiceBeforeXero(
    { boundary: "fake" },
    { invoice_source: "work_order" },
    [{ line_total_ex: 100 }],
    null,
    {
      persistWorkOrderInvoice: () => {
        events.push("persist");
        return Promise.resolve("invoice-1");
      },
      openXeroBoundary: payRunNoXeroBoundary as any,
    },
  );
  assertEquals(events, ["persist"]);
  assertEquals(result, {
    invoiceId: "invoice-1",
    accessToken: "",
    tenantId: "",
  });
});

Deno.test("weekly door: an all-in crew bill is never held, so it keeps the crew release", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const door = src.indexOf("case 'generate_trade_invoice': {");
  const skip = src.indexOf(
    "const payRunWait: PayRunWait = money.super_basis === TRADE_INVOICE_EMPLOYER_SUPER_BASIS\n              ? { waits: false }",
    door,
  );
  const hold = src.indexOf("await holdTradeInvoiceForPayRun(", door);
  const release = src.indexOf(
    "const groupCrewRelease = officeReviewHold && money.super_basis === TRADE_INVOICE_EMPLOYER_SUPER_BASIS",
    door,
  );
  const waitReturn = src.indexOf("if (payRunWait.waits) {", release);
  assert(door > 0 && skip > door, "the all-in skip is on the weekly door");
  assert(hold > skip && hold < skip + 400, "the hold is the other branch of the skip");
  assert(release > hold && waitReturn > release, "the crew release runs before the wait answer");
});

Deno.test("work order door: the switch is read before the save and the wait returns before any Xero step", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const door = src.indexOf("case 'submit_work_order_invoice': {");
  const read = src.indexOf(
    "const woPayRunSwitch = await readPayRunSwitchForSubmit(client)",
    door,
  );
  const claim = src.indexOf("_claimWorkOrderInvoiceBeforeXero(", door);
  const boundary = src.indexOf(
    "...(woPayRunSwitch !== 'off' ? { openXeroBoundary: payRunNoXeroBoundary } : {})",
    door,
  );
  const hold = src.indexOf(
    "holdTradeInvoiceForPayRun(client, tradeInvoiceId, 'draft', woPayRunSwitch)",
    door,
  );
  const waitReturn = src.indexOf("if (woPayRunWait.waits) {", door);
  const officeReview = src.indexOf(
    "const woOfficeReview = await readInvoiceOfficeReview(client, tradeInvoiceId)",
    door,
  );
  const contact = src.indexOf("resolveTradeXeroSupplierContact(client", door);
  const bill = src.indexOf("createTradeXeroBillOnce(client", door);
  assert(
    door > 0 && read > door && read < claim,
    "switch read before the save",
  );
  assert(boundary > claim && boundary < hold, "no Xero token while waiting");
  assert(hold > claim && waitReturn > hold, "hold after the save");
  assert(
    waitReturn < officeReview && waitReturn < contact && waitReturn < bill,
    "wait returns before every Xero step",
  );
});

// ── Spec test 29: the real weekly handler ───────────────────────────────────

const TRADE_ID = "6c2f0a52-0000-4000-8000-00000000aa01";
const OTHER_USER = "6c2f0a52-0000-4000-8000-00000000aa02";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const JOB_ID = "6c2f0a52-0000-4000-8000-00000000b002";
const SAVED_ID = "6c2f0a52-0000-4000-8000-00000000d001";
const WEEK_START = "2026-11-02"; // a Monday

const JOBS = [{
  id: JOB_ID,
  org_id: ORG_ID,
  job_number: "ZZF-2002",
  client_name: "Fixture Client",
  type: "fencing",
  status: "scheduled",
  site_address: "1 Fixture St",
  site_suburb: "Testville",
  metadata: {},
  created_by: OTHER_USER,
}];
const ASSIGNMENTS = [{
  id: "c2",
  job_id: JOB_ID,
  user_id: TRADE_ID,
  status: "complete",
  is_ghost: false,
}];

type World = { flag: "on" | "off" | "error" };
type Captured = {
  status: number;
  body: any;
  patches: Array<{ query: string; body: any }>;
  xeroCalls: string[];
  tokenReads: number;
};

function filterValues(url: URL, column: string): string[] | null {
  const raw = url.searchParams.get(column);
  if (raw === null) return null;
  const eq = /^eq\.(.*)$/.exec(raw);
  if (eq) return [eq[1]];
  const inList = /^in\.\((.*)\)$/.exec(raw);
  if (inList) {
    return inList[1].split(",").map((v) => v.replace(/"/g, "").trim());
  }
  return null;
}

async function submitWeek(world: World): Promise<Captured> {
  const patches: Array<{ query: string; body: any }> = [];
  const xeroCalls: string[] = [];
  let tokenReads = 0;
  let status = "pending_acknowledgment";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") {
      // Anything not the stubbed database is the outside world (Xero).
      xeroCalls.push(url.hostname + url.pathname);
      return Promise.resolve(
        Response.json({ error: "no network in tests" }, { status: 500 }),
      );
    }
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    const accept = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) {
        return Promise.resolve(Response.json(rows));
      }
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (rows.length === 0 && accept.includes("nulls=stripped")) {
        return Promise.resolve(Response.json(null));
      }
      return Promise.resolve(
        Response.json({ code: "PGRST116", message: "no rows" }, {
          status: 406,
        }),
      );
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: TRADE_ID, email: "", aud: "authenticated" }),
      );
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      return Promise.resolve(Response.json(SAVED_ID));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (table === "feature_flags") {
      const names = filterValues(url, "flag_name");
      if (names?.includes("trade_pay_run_v1")) {
        if (world.flag === "error") {
          return Promise.resolve(
            Response.json({ code: "XX000", message: "boom" }, { status: 500 }),
          );
        }
        const row = {
          flag_name: "trade_pay_run_v1",
          enabled: world.flag === "on",
        };
        return reply([row]);
      }
      return reply([]);
    }
    if (table === "xero_tokens") {
      tokenReads += 1;
      return reply([]);
    }
    if (table === "users") {
      return reply([{
        id: TRADE_ID,
        org_id: ORG_ID,
        role: "lead_installer",
        name: "Fixture Trade",
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
      const ids = filterValues(url, "id");
      const numbers = filterValues(url, "job_number");
      return reply(
        JOBS.filter((row) =>
          (!ids || ids.includes(row.id)) &&
          (!numbers || numbers.includes(row.job_number))
        ),
      );
    }
    if (table === "job_assignments") {
      const users = filterValues(url, "user_id");
      const jobs = filterValues(url, "job_id");
      return reply(
        ASSIGNMENTS.filter((row) =>
          (!users || users.includes(row.user_id)) &&
          (!jobs || jobs.includes(row.job_id))
        ),
      );
    }
    if (table === "trade_rates") {
      return reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]);
    }
    if (table === "trade_invoices") {
      if (method === "POST") return reply([{ id: SAVED_ID }]);
      if (method === "PATCH") {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body)
          : {};
        patches.push({ query: url.search, body });
        const wantStatus = filterValues(url, "status");
        if (body.status && (!wantStatus || wantStatus.includes(status))) {
          status = body.status;
        }
        return reply([{ id: SAVED_ID, status }]);
      }
      // Only the saved invoice, read by its id; the week has no other invoice.
      const ids = filterValues(url, "id");
      return reply(
        ids?.includes(SAVED_ID)
          ? [{ id: SAVED_ID, status, query_note: null, xero_bill_id: null }]
          : [],
      );
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", "generate_trade_invoice");
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer trade-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          week_start: WEEK_START,
          gst_on: false,
          extra_items: [{
            type: "Materials",
            description: "Materials on ZZF-2002",
            quantity: 2,
            unit: "ea",
            rate: 10,
            date: "2026-11-03",
            job_id: JOB_ID,
            job_number: "ZZF-2002",
          }],
        }),
      }),
    );
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, patches, xeroCalls, tokenReads };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

handlerTest(
  "spec test 29: switch on, a weekly send ends pending_ops_review with no bill and no Xero call",
  async () => {
    const out = await submitWeek({ flag: "on" });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.body.code, "pay_run_waits");
    assertEquals(out.body.pay_run, {
      waits: true,
      held: true,
      words: PAY_RUN_WAIT_WORDS,
    });
    assertEquals([out.body.xero_bill_id, out.body.pending_ops_review], [
      null,
      true,
    ]);
    // Exactly one status move, to pending_ops_review, from the saved status, with no bill.
    const moves = out.patches.filter((p) => "status" in p.body);
    assertEquals(moves.map((p) => p.body.status), ["pending_ops_review"]);
    assert(
      moves[0].query.includes("status=eq.pending_acknowledgment"),
      moves[0].query,
    );
    assert(moves[0].query.includes("xero_bill_id=is.null"), moves[0].query);
    assertEquals(out.xeroCalls, []);
    assertEquals(out.tokenReads, 0);
  },
);

handlerTest(
  "switch unreadable: the send waits too, and Xero is never opened",
  async () => {
    const out = await submitWeek({ flag: "error" });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.body.code, "pay_run_switch_unreadable");
    assertEquals(
      out.patches.filter((p) => "status" in p.body).map((p) => p.body.status),
      ["pending_ops_review"],
    );
    assertEquals(out.xeroCalls, []);
    assertEquals(out.tokenReads, 0);
  },
);

handlerTest(
  "switch off: the send takes today's path (ready for Xero, then the push opens the token)",
  async () => {
    const out = await submitWeek({ flag: "off" });
    assert(out.body.pay_run === undefined, JSON.stringify(out.body));
    const statuses = out.patches.filter((p) => "status" in p.body).map((p) =>
      p.body.status
    );
    assert(!statuses.includes("pending_ops_review"), statuses.join(","));
    assert(statuses.includes("approved"), statuses.join(","));
    assert(
      out.tokenReads > 0 || out.xeroCalls.length > 0,
      "the off path reaches for Xero as before",
    );
  },
);
