/**
 * Trade invoice time entries (owner, 12 Oct 2026): a line that bills a
 * trade's time says which day it was worked and from when to when.
 *
 * Covers the contract in docs/trade-invoice-time-entries-2026-10-12.md:
 *   1. the rule itself (hours computed, mismatch, finish before start,
 *      missing fields under both flag states),
 *   2. every write path a time line goes through:
 *        - generate_trade_invoice: job cards (manual_assignments) and
 *          searched-in hour lines (extra_items) store the fields sent,
 *        - save_trade_invoice_draft: the no-week insert and the dated persist
 *          store the fields sent,
 *        - the auto-collected lanes (generate_trade_invoice's clock lane and
 *          submit_trade_invoice's legacy hourly lane) store none: see 6,
 *   3. a job's list reads its entries, billed and saved on the job view, and
 *      every read of an invoice line answers the four fields,
 *   4. the day worked is never after today, Perth, on every path,
 *   5. times saved on the job view (log_my_job_hours) are stored with the
 *      card's hours and returned by my_hours,
 *   6. an invoice line's time entry is only ever the trade's own statement
 *      on that line: a job card the server collects itself carries none
 *      (flag off) or is refused by name (flag on), whatever the clock or the
 *      job view holds,
 *   7. two days on one job are two job cards: each day's log goes on that
 *      day's card.
 *
 * The actions are driven through the REAL request handler against a
 * PostgREST-shaped fetch stub, so a write path that stops calling the rule
 * fails here, not just a helper.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _opsApiRequestHandlerForTest,
  _tradeLogMyJobHoursForTest,
  myHours,
  submitTradeInvoice,
} from "./index.ts";
import {
  assertManualTimeEntriesDistinct,
  draftTradeInvoiceTimeEntry,
  isTradeInvoiceTimeLineType,
  loadJobTradeTimeEntries,
  loggedTimeEntryForCard,
  perthToday,
  resolveTradeInvoiceTimeEntry,
  TRADE_INVOICE_TIME_ENTRY_FLAG,
  TradeInvoiceTimeEntryError,
  tradeInvoiceTimeEntryRequired,
} from "./trade_invoice_time_entry.ts";

const TRADE_ID = "7d4f0a52-0000-4000-8000-00000000aa01";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const JOB_A = "7d4f0a52-0000-4000-8000-00000000b001";
const JOB_B = "7d4f0a52-0000-4000-8000-00000000b002";
const CARD_A = "7d4f0a52-0000-4000-8000-00000000c001";
const CARD_B = "7d4f0a52-0000-4000-8000-00000000c002";
const NEW_INVOICE = "7d4f0a52-0000-4000-8000-00000000d001";
const WEEK_START = "2026-08-24"; // a Monday
const WEEK_END = "2026-08-30";

function refusal(fn: () => unknown): TradeInvoiceTimeEntryError {
  return assertThrows(fn, TradeInvoiceTimeEntryError);
}

// ── 1. The rule ─────────────────────────────────────────────────────────────

Deno.test("time entry: hours are finish minus start minus break, computed on the server", () => {
  assertEquals(
    resolveTradeInvoiceTimeEntry({
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:30",
      break_minutes: 30,
    }, { required: true }),
    {
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:30",
      break_minutes: 30,
      hours: 8,
    },
  );
  // No break sent: default 0. Twenty minutes is a third of an hour, 2 dp.
  const noBreak = resolveTradeInvoiceTimeEntry({
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "15:20",
  }, { required: false });
  assertEquals(noBreak?.break_minutes, 0);
  assertEquals(noBreak?.hours, 8.33);
});

for (const required of [false, true]) {
  const state = required ? "flag on" : "flag off";

  Deno.test(`time entry (${state}): a client hours figure more than 0.01 out is refused`, () => {
    const entry = {
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:20",
    };
    const error = refusal(() =>
      resolveTradeInvoiceTimeEntry(entry, { required, clientHours: 9 })
    );
    assertEquals(error.code, "time_entry_hours_mismatch");
    assertEquals(error.status, 422);
    assertStringIncludes(error.message, "8.33");
    // Within 0.01 either way is the same figure.
    for (const clientHours of [8.33, 8.3333, 8.34, 8.32, "8.33"]) {
      assertEquals(
        resolveTradeInvoiceTimeEntry(entry, { required, clientHours })?.hours,
        8.33,
      );
    }
    assertEquals(
      refusal(() =>
        resolveTradeInvoiceTimeEntry(entry, { required, clientHours: 8.35 })
      ).code,
      "time_entry_hours_mismatch",
    );
    // No hours sent at all: nothing to disagree with.
    assertEquals(
      resolveTradeInvoiceTimeEntry(entry, { required })?.hours,
      8.33,
    );
  });

  Deno.test(`time entry (${state}): finish must be after start on the same day`, () => {
    for (const finish_time of ["06:00", "07:00"]) {
      const error = refusal(() =>
        resolveTradeInvoiceTimeEntry({
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time,
        }, { required })
      );
      assertEquals(error.code, "time_entry_finish_before_start");
      assertStringIncludes(error.message, "two lines");
    }
  });

  Deno.test(`time entry (${state}): a half-filled or malformed entry is refused`, () => {
    assertEquals(
      refusal(() =>
        resolveTradeInvoiceTimeEntry({
          work_date: "2026-08-25",
          start_time: "07:00",
        }, { required })
      ).code,
      "time_entry_required",
    );
    for (
      const bad of [
        { work_date: "25/08/2026", start_time: "07:00", finish_time: "15:00" },
        { work_date: "2026-02-30", start_time: "07:00", finish_time: "15:00" },
        { work_date: "2026-08-25", start_time: "7am", finish_time: "15:00" },
        { work_date: "2026-08-25", start_time: "07:00", finish_time: "24:00" },
        // exactly HH:MM: seconds are not the contract form
        { work_date: "2026-08-25", start_time: "07:00:00", finish_time: "15:00" },
        { work_date: "2026-08-25", start_time: "07:00", finish_time: "15:00:00" },
        { work_date: "2026-08-25", start_time: "7:00", finish_time: "15:00" },
        {
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "15:00",
          break_minutes: 12.5,
        },
        {
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "15:00",
          break_minutes: -5,
        },
        // a break as long as the shift leaves no hours to bill
        {
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "08:00",
          break_minutes: 60,
        },
      ]
    ) {
      assertEquals(
        refusal(() => resolveTradeInvoiceTimeEntry(bad, { required })).code,
        "time_entry_invalid",
        JSON.stringify(bad),
      );
    }
  });
}

Deno.test("time entry: a line with none of the fields is accepted while the flag is off and refused when on", () => {
  for (const line of [{}, null, { hours: 6 }, { break_minutes: 30 }]) {
    assertEquals(
      resolveTradeInvoiceTimeEntry(line, { required: false }),
      null,
    );
    const error = refusal(() =>
      resolveTradeInvoiceTimeEntry(line, { required: true, label: "SWF-1" })
    );
    assertEquals(error.code, "time_entry_required");
    assertStringIncludes(error.message, "SWF-1");
  }
});

// Every type the trade app's manual hours row offers. A type added to the app
// goes here, and fails below until the server treats it as a time line.
const TRADE_APP_HOURS_TYPES = [
  "Labour",
  "Fencing",
  "Patio",
  "Make Safe",
  "General Labour",
  "Decking",
];

Deno.test("time entry: only lines that bill hours are time lines", () => {
  for (const type of TRADE_APP_HOURS_TYPES) {
    assert(isTradeInvoiceTimeLineType(type), type);
  }
  // one type, whatever its case and spacing
  for (
    const type of [
      "MakeSafe",
      "make safe",
      "MAKE  SAFE",
      " General Labour ",
      "generallabour",
      "DECKING",
    ]
  ) {
    assert(isTradeInvoiceTimeLineType(type), type);
  }
  for (
    const type of [
      "Materials",
      "Travel",
      "Equipment",
      "Commission",
      "Work Order",
      "Other",
      "final_payout_deduction",
      "labour_deduction",
      "",
      null,
    ]
  ) {
    assert(!isTradeInvoiceTimeLineType(type), String(type));
  }
});

for (const required of [false, true]) {
  const state = required ? "flag on" : "flag off";

  Deno.test(`time entry (${state}): a day worked after today, Perth, is refused; today is accepted`, () => {
    const shift = { start_time: "07:00", finish_time: "15:00" };
    const error = refusal(() =>
      resolveTradeInvoiceTimeEntry(
        { work_date: "2026-08-26", ...shift },
        { required, today: "2026-08-25", label: "SWF-TIME-1" },
      )
    );
    assertEquals(error.code, "time_entry_future_date");
    assertEquals(error.status, 422);
    assertStringIncludes(error.message, "2026-08-26");
    assertStringIncludes(error.message, "SWF-TIME-1");
    assertEquals(
      resolveTradeInvoiceTimeEntry(
        { work_date: "2026-08-25", ...shift },
        { required, today: "2026-08-25" },
      )?.work_date,
      "2026-08-25",
    );
    // With no `today` given the rule reads the clock, in Perth.
    assertEquals(
      refusal(() =>
        resolveTradeInvoiceTimeEntry({ work_date: "2099-01-01", ...shift }, {
          required,
        })
      ).code,
      "time_entry_future_date",
    );
    assertEquals(
      resolveTradeInvoiceTimeEntry({ work_date: perthToday(), ...shift }, {
        required,
      })?.work_date,
      perthToday(),
    );
  });
}

Deno.test("time entry: today is the Perth calendar day, not the UTC one", () => {
  // 16:30 UTC on 25 Aug is 00:30 on 26 Aug in Perth (UTC+8, no daylight saving).
  assertEquals(perthToday(new Date("2026-08-25T16:30:00Z")), "2026-08-26");
  assertEquals(perthToday(new Date("2026-08-25T15:59:00Z")), "2026-08-25");
});

Deno.test("time entry: a draft keeps what is well formed and refuses nothing", () => {
  assertEquals(
    draftTradeInvoiceTimeEntry({
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:00",
      break_minutes: 30,
    }),
    {
      columns: {
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 30,
      },
      hours: 7.5,
    },
  );
  // half-filled: kept as it stands, no hours yet
  assertEquals(
    draftTradeInvoiceTimeEntry({ work_date: "2026-08-25", start_time: "07:00" }),
    {
      columns: {
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: null,
        break_minutes: 0,
      },
      hours: null,
    },
  );
  // the table refuses a finish not after the start, so the draft drops it
  assertEquals(
    draftTradeInvoiceTimeEntry({
      work_date: "2026-08-25",
      start_time: "15:00",
      finish_time: "07:00",
    }).columns.finish_time,
    null,
  );
  assertEquals(draftTradeInvoiceTimeEntry({ hours: 4 }), {
    columns: {
      work_date: null,
      start_time: null,
      finish_time: null,
      break_minutes: null,
    },
    hours: null,
  });
  // a day worked after today is dropped like any other field that is not
  // valid: the times are kept, and no hours are set until the day is right
  assertEquals(
    draftTradeInvoiceTimeEntry({
      work_date: "2026-08-26",
      start_time: "07:00",
      finish_time: "15:00",
    }, "2026-08-25"),
    {
      columns: {
        work_date: null,
        start_time: "07:00",
        finish_time: "15:00",
        break_minutes: 0,
      },
      hours: null,
    },
  );
});

Deno.test("time entry: one job card may carry two days, never the same time twice", () => {
  const day = (work_date: string, start_time: string, finish_time: string) => ({
    work_date,
    start_time,
    finish_time,
    break_minutes: 0,
    hours: 1,
  });
  // two days on one card, and two cards on one day, are both fine
  assertManualTimeEntriesDistinct([
    { assignment_id: CARD_A, entry: day("2026-08-25", "07:00", "15:00") },
    { assignment_id: CARD_A, entry: day("2026-08-26", "07:00", "15:00") },
    { assignment_id: CARD_B, entry: day("2026-08-25", "07:00", "15:00") },
    { assignment_id: CARD_A, entry: day("2026-08-25", "15:00", "17:00") },
  ]);
  assertEquals(
    refusal(() =>
      assertManualTimeEntriesDistinct([
        { assignment_id: CARD_A, entry: day("2026-08-25", "07:00", "15:00") },
        { assignment_id: CARD_A, entry: day("2026-08-25", "14:00", "16:00") },
      ])
    ).code,
    "time_entry_overlap",
  );
  // a card sent twice with no times is the old double-tap: still refused
  assertEquals(
    refusal(() =>
      assertManualTimeEntriesDistinct([
        { assignment_id: CARD_A, entry: day("2026-08-25", "07:00", "15:00") },
        { assignment_id: CARD_A, entry: null },
      ])
    ).code,
    "time_entry_required",
  );
});

Deno.test("time entry flag: only an explicit true is on; missing, unreadable and thrown reads are off", async () => {
  const flagClient = (result: unknown, seen: string[] = []) => ({
    from(table: string) {
      seen.push(table);
      const builder: any = {
        select: () => builder,
        eq(column: string, value: unknown) {
          seen.push(`${column}=${String(value)}`);
          return builder;
        },
        limit: () => Promise.resolve(result),
      };
      return builder;
    },
  });
  const seen: string[] = [];
  assertEquals(
    await tradeInvoiceTimeEntryRequired(
      flagClient({ data: [{ enabled: true }], error: null }, seen),
    ),
    true,
  );
  assertEquals(seen, [
    "feature_flags",
    `flag_name=${TRADE_INVOICE_TIME_ENTRY_FLAG}`,
  ]);
  for (
    const result of [
      { data: [{ enabled: false }], error: null },
      { data: [], error: null },
      { data: null, error: { message: "boom" } },
      { data: [{ enabled: "true" }], error: null },
    ]
  ) {
    assertEquals(await tradeInvoiceTimeEntryRequired(flagClient(result)), false);
  }
  assertEquals(
    await tradeInvoiceTimeEntryRequired({
      from() {
        throw new Error("no client");
      },
    }),
    false,
  );
});

// ── 2a. The trade actions, through the real request handler ─────────────────

type Stub = {
  flagOn: boolean;
  cards?: any[];
  jobs?: any[];
  // the signed-in user's role; "admin" reaches the staff actions
  role?: string;
  // rows of job_assignment_logged_times (times saved on the job view)
  loggedTimes?: any[];
  // rows the reads of trade_invoices, trade_invoice_lines and the view answer
  invoices?: any[];
  invoiceLines?: any[];
  viewEntries?: any[];
  // table name -> PostgREST error message
  fail?: Record<string, string>;
};

// PostgREST answers only the columns a select names. Fixture rows for the
// reads under test go through this, so a read that stops naming a column
// stops answering it.
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function projectRow(row: any, select: string | null): any {
  if (!select || select.trim() === "*") return row;
  const out: any = {};
  for (const part of splitTopLevel(select)) {
    if (part === "*") {
      Object.assign(out, row);
      continue;
    }
    const embed = /^(?:(\w+):)?(\w+)(?:!\w+)?\((.*)\)$/s.exec(part);
    if (embed) {
      const key = embed[1] || embed[2];
      const value = row?.[key];
      out[key] = Array.isArray(value)
        ? value.map((item) => projectRow(item, embed[3]))
        : value == null
        ? null
        : projectRow(value, embed[3]);
      continue;
    }
    out[part] = row?.[part] ?? null;
  }
  return out;
}

type Captured = {
  status: number;
  body: any;
  lineRows: any[];
  rpcCalls: Array<{ name: string; args: any }>;
  writes: string[];
};

const CARDS = [
  {
    id: CARD_A,
    job_id: JOB_A,
    user_id: TRADE_ID,
    scheduled_date: "2026-08-25",
    status: "complete",
    invoiced_in: null,
  },
  {
    id: CARD_B,
    job_id: JOB_B,
    user_id: TRADE_ID,
    scheduled_date: "2026-08-26",
    status: "complete",
    invoiced_in: null,
  },
];
const JOBS = [
  {
    id: JOB_A,
    job_number: "SWF-TIME-1",
    client_name: "Client A",
    type: "fencing",
    status: "complete",
    site_address: "1 First St",
    site_suburb: "Perth",
    metadata: {},
  },
  {
    id: JOB_B,
    job_number: "SWF-TIME-2",
    client_name: "Client B",
    type: "fencing",
    status: "complete",
    site_address: "2 Second St",
    site_suburb: "Perth",
    metadata: {},
  },
];

async function callTradeAction(
  action: string,
  body: Record<string, unknown>,
  stub: Stub,
  params: Record<string, string> = {},
): Promise<Captured> {
  const lineRows: any[] = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const writes: string[] = [];
  const cards = stub.cards ?? CARDS;
  const jobs = stub.jobs ?? JOBS;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    const accept = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("accept") || "";
    // PostgREST answers `.single()` / `.maybeSingle()` with one object.
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Response.json(rows);
      if (rows.length === 1) return Response.json(rows[0]);
      return Response.json({
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      }, { status: 406 });
    };
    const payload = () => {
      const raw = init?.body;
      return typeof raw === "string" && raw ? JSON.parse(raw) : raw;
    };
    const idsIn = (column: string): string[] | null => {
      const filter = url.searchParams.get(column) || "";
      const one = /^eq\.(.*)$/.exec(filter);
      if (one) return [one[1]];
      const match = /^in\.\((.*)\)$/.exec(filter);
      if (!match) return null;
      return match[1].split(",").map((id) => id.replace(/"/g, "").trim());
    };
    const projected = (rows: any[]) =>
      rows.map((row) => projectRow(row, url.searchParams.get("select")));

    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: TRADE_ID, email: "", aud: "authenticated" }),
      );
    }
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (rpc) {
      rpcCalls.push({ name: rpc[1], args: payload() });
      writes.push(`RPC ${rpc[1]}`);
      return Promise.resolve(Response.json(NEW_INVOICE));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") {
      writes.push(`${method} ${table}`);
    }
    if (stub.fail?.[table]) {
      return Promise.resolve(
        Response.json({ message: stub.fail[table] }, { status: 500 }),
      );
    }
    if (table === "job_assignment_logged_times") {
      const cardIds = idsIn("assignment_id");
      const jobIds = idsIn("job_id");
      return Promise.resolve(reply((stub.loggedTimes ?? []).filter((row) =>
        (!cardIds || cardIds.includes(row.assignment_id)) &&
        (!jobIds || jobIds.includes(row.job_id))
      )));
    }
    if (table === "job_trade_time_entries") {
      const jobIds = idsIn("job_id");
      return Promise.resolve(reply(projected(
        (stub.viewEntries ?? []).filter((row) =>
          !jobIds || jobIds.includes(row.job_id)
        ),
      )));
    }
    if (table === "users") {
      return Promise.resolve(reply([{
        id: TRADE_ID,
        org_id: ORG_ID,
        role: stub.role ?? "trade",
        name: "Tess Trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        trade_details: {},
      }]));
    }
    if (table === "feature_flags") {
      const wanted = url.searchParams.get("flag_name") ===
        `eq.${TRADE_INVOICE_TIME_ENTRY_FLAG}`;
      return Promise.resolve(
        reply(wanted ? [{ enabled: stub.flagOn }] : []),
      );
    }
    if (table === "trade_rates") {
      return Promise.resolve(
        reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]),
      );
    }
    if (table === "job_assignments") {
      const ids = idsIn("id");
      return Promise.resolve(
        reply(cards.filter((card) => !ids || ids.includes(card.id))),
      );
    }
    if (table === "jobs") {
      const ids = idsIn("id");
      const numbers = idsIn("job_number");
      return Promise.resolve(reply(jobs.filter((job) =>
        (!ids || ids.includes(job.id)) &&
        (!numbers || numbers.includes(job.job_number))
      )));
    }
    if (table === "trade_invoices") {
      // A write answers the row it wrote. An update that answered no row
      // would read as "invoice state changed" and turn a saved invoice into
      // an HTTP 500.
      if (method === "POST" || method === "PATCH") {
        return Promise.resolve(reply([{ id: NEW_INVOICE }]));
      }
      if (method === "DELETE") {
        return Promise.resolve(reply([{ id: NEW_INVOICE }]));
      }
      return Promise.resolve(reply(projected(stub.invoices ?? [])));
    }
    if (table === "trade_invoice_lines") {
      if (method === "POST") {
        const rows = payload();
        lineRows.push(...(Array.isArray(rows) ? rows : [rows]));
        return Promise.resolve(reply([]));
      }
      return Promise.resolve(reply(projected(stub.invoiceLines ?? [])));
    }
    return Promise.resolve(reply([]));
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer trade-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, lineRows, rpcCalls, writes };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const timeOf = (row: any) => ({
  work_date: row.work_date,
  start_time: row.start_time,
  finish_time: row.finish_time,
  break_minutes: row.break_minutes,
});

const NO_TIME = {
  work_date: null,
  start_time: null,
  finish_time: null,
  break_minutes: null,
};

// A stored line with no time entry: the four fields null, or not sent at all.
const storedTimeOf = (row: any) => ({
  work_date: row.work_date ?? null,
  start_time: row.start_time ?? null,
  finish_time: row.finish_time ?? null,
  break_minutes: row.break_minutes ?? null,
});

const isMakeSafeType = (type: string) =>
  type.toLowerCase().replace(/\s+/g, "") === "makesafe";

const submitBody = (manual_assignments: any[], extra_items: any[] = []) => ({
  week_start: WEEK_START,
  gst_on: false,
  manual_assignments,
  extra_items,
});

for (const flagOn of [false, true]) {
  const state = flagOn ? "flag on" : "flag off";

  handlerTest(`generate_trade_invoice (${state}): a job card with a time entry is stored as one line per day, hours computed`, async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submitBody([
        // two days on one job card, and a second card: three lines
        {
          assignment_id: CARD_A,
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "15:30",
          break_minutes: 30,
          hours: 8,
        },
        {
          assignment_id: CARD_A,
          work_date: "2026-08-26",
          start_time: "07:00",
          finish_time: "11:00",
        },
        {
          assignment_id: CARD_B,
          work_date: "2026-08-26",
          start_time: "12:00",
          finish_time: "15:20",
        },
      ]),
      { flagOn },
    );
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.lineRows.length, 3, JSON.stringify(out.body));
    assertEquals(
      out.lineRows.map((row) => ({
        job_id: row.job_id,
        total_hours: row.total_hours,
        line_total_ex: row.line_total_ex,
        ...timeOf(row),
      })),
      [
        {
          job_id: JOB_A,
          total_hours: 8,
          line_total_ex: 400,
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "15:30",
          break_minutes: 30,
        },
        {
          job_id: JOB_A,
          total_hours: 4,
          line_total_ex: 200,
          work_date: "2026-08-26",
          start_time: "07:00",
          finish_time: "11:00",
          break_minutes: 0,
        },
        {
          job_id: JOB_B,
          total_hours: 3.33,
          line_total_ex: 166.5,
          work_date: "2026-08-26",
          start_time: "12:00",
          finish_time: "15:20",
          break_minutes: 0,
        },
      ],
    );
    // both lines of the two-day card keep the card they bill
    assertEquals(out.lineRows[0].assignment_ids, [CARD_A]);
    assertEquals(out.lineRows[1].assignment_ids, [CARD_A]);
  });

  handlerTest(`generate_trade_invoice (${state}): hours that disagree with the times, and a finish before the start, are refused before anything is saved`, async () => {
    const mismatch = await callTradeAction(
      "generate_trade_invoice",
      submitBody([{
        assignment_id: CARD_A,
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: "15:00",
        hours: 10,
      }]),
      { flagOn },
    );
    assertEquals(mismatch.status, 422);
    assertEquals(mismatch.body.code, "time_entry_hours_mismatch");
    assertEquals(mismatch.writes, []);

    const backwards = await callTradeAction(
      "generate_trade_invoice",
      submitBody([{
        assignment_id: CARD_A,
        work_date: "2026-08-25",
        start_time: "15:00",
        finish_time: "07:00",
      }]),
      { flagOn },
    );
    assertEquals(backwards.status, 422);
    assertEquals(backwards.body.code, "time_entry_finish_before_start");
    assertEquals(backwards.writes, []);

    const extraMismatch = await callTradeAction(
      "generate_trade_invoice",
      submitBody([], [{
        type: "Labour",
        description: "Extra hours",
        quantity: 6,
        unit: "hr",
        rate: 50,
        job_id: JOB_A,
        job_number: "SWF-TIME-1",
        work_date: "2026-08-27",
        start_time: "08:00",
        finish_time: "12:00",
      }]),
      { flagOn, cards: [] },
    );
    assertEquals(extraMismatch.status, 422);
    assertEquals(extraMismatch.body.code, "time_entry_hours_mismatch");
    assertEquals(extraMismatch.writes, []);
  });

  handlerTest(`generate_trade_invoice (${state}): a searched-in hours line stores its entry; materials carry none`, async () => {
    const out = await callTradeAction(
      "generate_trade_invoice",
      submitBody([], [
        {
          type: "Labour",
          description: "Extra hours",
          // no quantity: the server computes the hours from the times
          unit: "hr",
          rate: 50,
          job_id: JOB_A,
          job_number: "SWF-TIME-1",
          work_date: "2026-08-27",
          start_time: "08:00",
          finish_time: "12:30",
          break_minutes: 30,
        },
        {
          type: "Materials",
          description: "Screws",
          quantity: 2,
          unit: "ea",
          rate: 10,
          job_id: JOB_A,
          job_number: "SWF-TIME-1",
          date: "2026-08-27",
          // a client that sends times on a non-time line: ignored
          work_date: "2026-08-27",
          start_time: "08:00",
          finish_time: "09:00",
        },
      ]),
      { flagOn, cards: [] },
    );
    assertEquals(out.lineRows.length, 2, JSON.stringify(out.body));
    const [labour, materials] = out.lineRows;
    assertEquals(labour.line_type, "labour");
    assertEquals(timeOf(labour), {
      work_date: "2026-08-27",
      start_time: "08:00",
      finish_time: "12:30",
      break_minutes: 30,
    });
    assertEquals(
      [labour.quantity, labour.total_hours, labour.line_total_ex],
      [4, 4, 200],
    );
    assertEquals(labour.line_date, "2026-08-27");
    assertEquals(materials.line_type, "materials");
    assertEquals(timeOf(materials), NO_TIME);
    assertEquals(materials.line_total_ex, 20);
  });

  handlerTest(`generate_trade_invoice (${state}): every hours type the trade app offers stores the times sent on its line`, async () => {
    for (const type of [...TRADE_APP_HOURS_TYPES, "MakeSafe"]) {
      const makeSafe = isMakeSafeType(type);
      const out = await callTradeAction(
        "generate_trade_invoice",
        submitBody([], [{
          type,
          description: "Extra hours",
          unit: "hr",
          rate: 50,
          job_id: JOB_A,
          job_number: makeSafe ? "SWMS-261001" : "SWF-TIME-1",
          work_date: "2026-08-27",
          start_time: "08:00",
          finish_time: "12:30",
          break_minutes: 30,
        }]),
        {
          flagOn,
          cards: [],
          jobs: makeSafe
            ? [{ ...JOBS[0], type: "makesafe", job_number: "SWMS-261001" }]
            : JOBS,
        },
      );
      assertEquals(out.lineRows.length, 1, `${type}: ${JSON.stringify(out.body)}`);
      assertEquals(timeOf(out.lineRows[0]), {
        work_date: "2026-08-27",
        start_time: "08:00",
        finish_time: "12:30",
        break_minutes: 30,
      }, type);
      assertEquals(
        [out.lineRows[0].quantity, out.lineRows[0].total_hours, out.lineRows[0].line_total_ex],
        [4, 4, 200],
        type,
      );
    }
  });

  handlerTest(`save_trade_invoice_draft (${state}): a Decking hours line keeps its times`, async () => {
    const out = await callTradeAction("save_trade_invoice_draft", {
      gst_on: false,
      labour_lines: [],
      extra_items: [{
        type: "Decking",
        description: "Deck boards",
        quantity: 4,
        unit: "hr",
        rate: 50,
        job_id: JOB_A,
        job_number: "SWF-TIME-1",
        work_date: "2026-08-27",
        start_time: "08:00",
        finish_time: "12:00",
      }],
    }, { flagOn });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.lineRows.length, 1, JSON.stringify(out.body));
    assertEquals(timeOf(out.lineRows[0]), {
      work_date: "2026-08-27",
      start_time: "08:00",
      finish_time: "12:00",
      break_minutes: 0,
    });
  });

  handlerTest(`save_trade_invoice_draft (${state}): a draft stores the fields on both persist routes and is never refused`, async () => {
    const draftBody = {
      gst_on: false,
      labour_lines: [
        {
          job_id: JOB_A,
          job_number: "SWF-TIME-1",
          total_hours: 99, // stale client figure: the entry sets the hours
          hourly_rate: 50,
          line_total_ex: 400,
          assignment_ids: [CARD_A],
          work_date: "2026-08-25",
          start_time: "07:00",
          finish_time: "15:30",
          break_minutes: 30,
        },
        // still being filled in: start only, no hours yet
        {
          job_id: JOB_B,
          job_number: "SWF-TIME-2",
          total_hours: 0,
          hourly_rate: 50,
          line_total_ex: 0,
          work_date: "2026-08-26",
          start_time: "07:00",
        },
        // no entry at all (an old app build)
        {
          job_id: JOB_B,
          job_number: "SWF-TIME-2",
          total_hours: 3,
          hourly_rate: 50,
          line_total_ex: 150,
        },
      ],
      extra_items: [
        {
          type: "Labour",
          description: "Extra hours",
          quantity: 4,
          unit: "hr",
          rate: 50,
          work_date: "2026-08-27",
          start_time: "08:00",
          finish_time: "12:00",
        },
        { type: "Materials", description: "Screws", quantity: 2, rate: 10 },
      ],
    };
    const expected = [
      {
        total_hours: 8,
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: "15:30",
        break_minutes: 30,
      },
      {
        total_hours: 0,
        work_date: "2026-08-26",
        start_time: "07:00",
        finish_time: null,
        break_minutes: 0,
      },
      { total_hours: 3, ...NO_TIME },
      {
        total_hours: undefined,
        work_date: "2026-08-27",
        start_time: "08:00",
        finish_time: "12:00",
        break_minutes: 0,
      },
      { total_hours: undefined, ...NO_TIME },
    ];
    const shape = (rows: any[]) =>
      rows.map((row) => ({ total_hours: row.total_hours, ...timeOf(row) }));

    // no week: the direct insert
    const misc = await callTradeAction("save_trade_invoice_draft", draftBody, {
      flagOn,
    });
    assertEquals(misc.status, 200, JSON.stringify(misc.body));
    assertEquals(shape(misc.lineRows), expected);

    // a dated week: the persist function, which stamps the same fields
    const dated = await callTradeAction("save_trade_invoice_draft", {
      ...draftBody,
      week_start: WEEK_START,
    }, { flagOn });
    assertEquals(dated.status, 200, JSON.stringify(dated.body));
    assertEquals(dated.rpcCalls.length, 1);
    assertEquals(dated.rpcCalls[0].name, "persist_weekly_trade_invoice_v3");
    assertEquals(shape(dated.rpcCalls[0].args.p_lines), expected);
    assertEquals(dated.lineRows, []);
  });
}

handlerTest("generate_trade_invoice (flag off): a job card with no time entry is still accepted and stored as before", async () => {
  const out = await callTradeAction(
    "generate_trade_invoice",
    submitBody([
      { assignment_id: CARD_A, hours: 6 },
      { assignment_id: CARD_B, hours: 2.5 },
    ], [{
      type: "Labour",
      description: "Extra hours",
      quantity: 3,
      unit: "hr",
      rate: 50,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      date: "2026-08-27",
    }]),
    { flagOn: false },
  );
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.lineRows.length, 3, JSON.stringify(out.body));
  assertEquals(
    out.lineRows.map((row) => [row.job_id, row.total_hours, row.line_total_ex]),
    [[JOB_A, 6, 300], [JOB_B, 2.5, 125], [JOB_A, 3, 150]],
  );
  for (const row of out.lineRows) assertEquals(timeOf(row), NO_TIME);
  assertEquals(out.lineRows[2].line_date, "2026-08-27");
});

handlerTest("generate_trade_invoice (flag on): a time line without the fields is refused time_entry_required and nothing is saved", async () => {
  const card = await callTradeAction(
    "generate_trade_invoice",
    submitBody([{ assignment_id: CARD_A, hours: 6 }]),
    { flagOn: true },
  );
  assertEquals(card.status, 422);
  assertEquals(card.body.code, "time_entry_required");
  assertEquals(card.body.success, false);
  assertEquals(card.writes, []);

  const extra = await callTradeAction(
    "generate_trade_invoice",
    submitBody([], [{
      type: "Labour",
      description: "Extra hours",
      quantity: 3,
      unit: "hr",
      rate: 50,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      date: "2026-08-27",
    }]),
    { flagOn: true, cards: [] },
  );
  assertEquals(extra.status, 422);
  assertEquals(extra.body.code, "time_entry_required");
  assertEquals(extra.writes, []);

  // a line that is not time is never asked for one
  const materials = await callTradeAction(
    "generate_trade_invoice",
    submitBody([], [{
      type: "Materials",
      description: "Screws",
      quantity: 2,
      unit: "ea",
      rate: 10,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      date: "2026-08-27",
    }]),
    { flagOn: true, cards: [] },
  );
  assertEquals(materials.lineRows.length, 1, JSON.stringify(materials.body));
  assertEquals(timeOf(materials.lineRows[0]), NO_TIME);
});

handlerTest("generate_trade_invoice: a make-safe job split over two day lines is still one charge against its allowance", async () => {
  // Allowance is the 2 hour rule default. One line of 3 hours flagged before
  // the split; two day lines of 1.5 hours must flag too, not slip under it.
  const out = await callTradeAction(
    "generate_trade_invoice",
    submitBody([
      {
        assignment_id: CARD_A,
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: "08:30",
      },
      {
        assignment_id: CARD_A,
        work_date: "2026-08-26",
        start_time: "07:00",
        finish_time: "08:30",
      },
      {
        assignment_id: CARD_B,
        work_date: "2026-08-26",
        start_time: "09:00",
        finish_time: "10:30",
      },
    ]),
    {
      flagOn: true,
      jobs: JOBS.map((job) =>
        job.id === JOB_A
          ? { ...job, type: "makesafe", job_number: "SWMS-TIME-1" }
          : job
      ),
    },
  );
  assertEquals(out.lineRows.length, 3, JSON.stringify(out.body));
  const [dayOne, dayTwo, otherJob] = out.lineRows;
  for (const line of [dayOne, dayTwo]) {
    assertEquals(line.total_hours, 1.5);
    assertEquals(line.flag_type, "hours_over_baseline");
    assertEquals(line.baseline_hours, 2);
    assertStringIncludes(String(line.query_note), "3");
  }
  // a fencing job on the same invoice is never a make-safe line
  assertEquals(otherJob.flag_type, null);
});

handlerTest("generate_trade_invoice: an hours line of any type the trade app offers needs its times when the flag is on", async () => {
  for (const type of [...TRADE_APP_HOURS_TYPES, "MakeSafe"]) {
    const makeSafe = isMakeSafeType(type);
    const line = {
      type,
      description: "Extra hours",
      quantity: 4,
      unit: "hr",
      rate: 50,
      job_id: JOB_A,
      job_number: makeSafe ? "SWMS-261001" : "SWF-TIME-1",
    };
    const jobs = makeSafe
      ? [{ ...JOBS[0], type: "makesafe", job_number: "SWMS-261001" }]
      : JOBS;

    // flag on, no times: refused, nothing saved
    const refused = await callTradeAction(
      "generate_trade_invoice",
      submitBody([], [line]),
      { flagOn: true, cards: [], jobs },
    );
    assertEquals(refused.status, 422, `${type}: ${JSON.stringify(refused.body)}`);
    assertEquals(refused.body.code, "time_entry_required", type);
    assertEquals(refused.writes, [], type);

    // flag off, no times: saved as before, with no entry
    const saved = await callTradeAction(
      "generate_trade_invoice",
      submitBody([], [line]),
      { flagOn: false, cards: [], jobs },
    );
    assertEquals(saved.lineRows.length, 1, `${type}: ${JSON.stringify(saved.body)}`);
    assertEquals(saved.lineRows[0].total_hours, 4, type);
    assertEquals(timeOf(saved.lineRows[0]), NO_TIME, type);
  }
});

// The auto-collected clock lane: no manual cards, so the server gathers the
// week's completed, clocked job cards itself.
const clockedCard = (id: string, jobId: string, extra: Record<string, unknown>) => ({
  id,
  job_id: jobId,
  user_id: TRADE_ID,
  scheduled_date: "2026-08-25",
  status: "complete",
  invoiced_in: null,
  hours_worked: 8,
  break_minutes: 30,
  manual_override_flag: false,
  clocked_on_at: "2026-08-24T23:00:00Z", // 07:00 Perth, 25 Aug
  clocked_off_at: "2026-08-25T07:30:00Z", // 15:30 Perth
  ...extra,
});
const clockBody = {
  week_start: WEEK_START,
  gst_on: false,
  extra_items: [{
    type: "Materials",
    description: "Screws",
    quantity: 2,
    unit: "ea",
    rate: 10,
    job_id: JOB_A,
    job_number: "SWF-TIME-1",
    date: "2026-08-27",
  }],
};

// A saved job-view row, as log_my_job_hours stores it.
const savedTimes = (assignment_id: string, job_id: string, extra: Record<string, unknown> = {}) => ({
  assignment_id,
  job_id,
  user_id: TRADE_ID,
  work_date: "2026-08-25",
  start_time: "06:30",
  finish_time: "15:00",
  break_minutes: 30,
  hours: 8,
  ...extra,
});

const NEEDS_TIMES_ON_TWO_JOBS =
  "Enter your start and finish time for: SWF-TIME-1 on 2026-08-25; SWF-TIME-2 on 2026-08-26. " +
  "Enter them on that job's card in the Weekly Invoice, then submit again.";

handlerTest("generate_trade_invoice clock lane (flag off): the lines are saved as before, with no time entry", async () => {
  const twoDays = [
    clockedCard(CARD_A, JOB_A, {}),
    clockedCard(CARD_B, JOB_A, {
      scheduled_date: "2026-08-26",
      hours_worked: 4,
      break_minutes: 0,
      clocked_on_at: "2026-08-25T23:00:00Z",
      clocked_off_at: "2026-08-26T03:00:00Z",
    }),
  ];
  // two days on one job stay one line
  const grouped = await callTradeAction("generate_trade_invoice", clockBody, {
    flagOn: false,
    cards: twoDays,
  });
  const groupedLabour = grouped.lineRows.filter((row) => row.line_type === "labour");
  assertEquals(groupedLabour.length, 1, JSON.stringify(grouped.body));
  assertEquals(
    [groupedLabour[0].total_hours, groupedLabour[0].days_worked],
    [12, 2],
  );
  assertEquals(storedTimeOf(groupedLabour[0]), NO_TIME);

  // one card with a same-day clock record and times saved on the job view:
  // the server fills in neither, and never reads the saved times
  const single = await callTradeAction("generate_trade_invoice", clockBody, {
    flagOn: false,
    cards: [twoDays[0]],
    loggedTimes: [savedTimes(CARD_A, JOB_A)],
    fail: { job_assignment_logged_times: "relation missing" },
  });
  const singleLabour = single.lineRows.filter((row) => row.line_type === "labour");
  assertEquals(singleLabour.length, 1, JSON.stringify(single.body));
  assertEquals(singleLabour[0].total_hours, 8);
  assertEquals(storedTimeOf(singleLabour[0]), NO_TIME);
});

handlerTest("generate_trade_invoice clock lane (flag on): every auto-collected card is refused by name, whatever the clock or the job view holds", async () => {
  const out = await callTradeAction("generate_trade_invoice", clockBody, {
    flagOn: true,
    cards: [
      // a same-day clock record, and times saved on the job view
      clockedCard(CARD_A, JOB_A, {}),
      // hours typed on the job view, never clocked
      clockedCard(CARD_B, JOB_B, {
        scheduled_date: "2026-08-26",
        hours_worked: 4,
        break_minutes: 0,
        clocked_on_at: null,
        clocked_off_at: null,
      }),
    ],
    loggedTimes: [
      savedTimes(CARD_A, JOB_A),
      savedTimes(CARD_B, JOB_B, {
        work_date: "2026-08-26",
        start_time: "07:00",
        finish_time: "11:00",
        break_minutes: 0,
        hours: 4,
      }),
    ],
    // the saved times are never read on this lane
    fail: { job_assignment_logged_times: "relation missing" },
  });
  assertEquals(out.status, 422, JSON.stringify(out.body));
  assertEquals(out.body.code, "time_entry_required");
  assertEquals(out.body.saved, false);
  assertEquals(out.body.needs_times, [
    {
      assignment_id: CARD_A,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      work_date: "2026-08-25",
    },
    {
      assignment_id: CARD_B,
      job_id: JOB_B,
      job_number: "SWF-TIME-2",
      work_date: "2026-08-26",
    },
  ]);
  // each job and day, and the one way to give the times
  assertEquals(out.body.userMessage, NEEDS_TIMES_ON_TWO_JOBS);
  assertEquals(out.writes, []);
});

// ── 2b. submit_trade_invoice: the legacy hourly lane ────────────────────────

type Write = { table: string; op: string; payload: any };

function legacyClient(
  fx: { flagOn: boolean; assignments: any[]; invoiceType?: string },
): { client: any; writes: Write[] } {
  const writes: Write[] = [];
  const client = {
    from(table: string) {
      let op = "select";
      let payload: any = null;
      const filters: Record<string, unknown> = {};
      const rows = (): any[] => {
        if (table === "users") {
          return [{
            name: "Tess Trade",
            email: "",
            xero_contact_id: null,
            trade_details: {},
            invoice_type: fx.invoiceType || "hourly",
          }];
        }
        if (table === "feature_flags") {
          return filters.flag_name === TRADE_INVOICE_TIME_ENTRY_FLAG
            ? [{ enabled: fx.flagOn }]
            : [];
        }
        if (table === "trade_rates") return [{ hourly_rate: 50 }];
        if (table === "job_assignments") {
          const ids = Array.isArray(filters.id) ? filters.id.map(String) : null;
          return fx.assignments.filter((a) => !ids || ids.includes(String(a.id)));
        }
        if (table === "trade_invoices") {
          return op === "insert" ? [{ id: NEW_INVOICE }] : [];
        }
        return [];
      };
      const builder: any = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        in(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        insert(p: any) {
          op = "insert";
          payload = p;
          return builder;
        },
        update(p: any) {
          op = "update";
          payload = p;
          return builder;
        },
        delete() {
          op = "delete";
          return builder;
        },
        maybeSingle: () =>
          builder.then((r: any) => ({ data: (r.data || [])[0] ?? null, error: null })),
        single: () =>
          builder.then((r: any) => ({ data: (r.data || [])[0] ?? null, error: null })),
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          if (op !== "select") writes.push({ table, op, payload });
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, writes };
}

const completedCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: TRADE_ID,
  scheduled_date: "2026-08-26",
  started_at: "2026-08-26T00:00:00Z", // 08:00 Perth
  completed_at: "2026-08-26T08:00:00Z", // 16:00 Perth
  status: "complete",
  role: "installer",
  assignment_type: "install",
  invoiced_in: null,
  jobs: {
    id: JOB_A,
    type: "fencing",
    job_number: "SWF-TIME-1",
    client_name: "Client A",
    site_address: "1 First St",
    site_suburb: "Perth",
  },
  ...extra,
});

// The lane goes on to Xero, which a fake client cannot answer: every run
// rejects there. What matters is what was written before that point.
async function submitLegacy(
  fx: { flagOn: boolean; assignments: any[] },
): Promise<{ lines: any[]; writes: Write[]; error: Error }> {
  const { client, writes } = legacyClient(fx);
  const error = await assertRejects(() =>
    submitTradeInvoice(client, TRADE_ID, { week_ending: WEEK_END, gst_on: false })
  ) as Error;
  const lines = writes
    .filter((w) => w.table === "trade_invoice_lines" && w.op === "insert")
    .flatMap((w) => w.payload);
  return { lines, writes, error };
}

Deno.test("submit_trade_invoice (flag off): the lines are saved as before, with no time entry", async () => {
  const dayTwo = completedCard(CARD_B, {
    scheduled_date: "2026-08-27",
    started_at: "2026-08-26T23:00:00Z", // 07:00 Perth, 27 Aug
    completed_at: "2026-08-27T03:00:00Z", // 11:00 Perth
  });

  // one card with a same-day pair of stamps: the server fills in no entry
  const single = await submitLegacy({
    flagOn: false,
    assignments: [completedCard(CARD_A)],
  });
  assertEquals(single.lines.length, 1);
  assertEquals(
    [single.lines[0].total_hours, single.lines[0].line_total_ex],
    [8, 400],
  );
  assertEquals(storedTimeOf(single.lines[0]), NO_TIME);

  // two days on one job: one line, as before
  const grouped = await submitLegacy({
    flagOn: false,
    assignments: [completedCard(CARD_A), dayTwo],
  });
  assertEquals(grouped.lines.length, 1);
  assertEquals(
    [grouped.lines[0].total_hours, grouped.lines[0].line_total_ex],
    [12, 600],
  );
  assertEquals(grouped.lines[0].assignment_ids, [CARD_A, CARD_B]);
  assertEquals(storedTimeOf(grouped.lines[0]), NO_TIME);
});

Deno.test("submit_trade_invoice (flag on): every card is refused by name before any write", async () => {
  const on = await submitLegacy({
    flagOn: true,
    assignments: [
      completedCard(CARD_A, { scheduled_date: "2026-08-25" }),
      completedCard(CARD_B, {
        scheduled_date: "2026-08-26",
        jobs: { id: JOB_B, type: "fencing", job_number: "SWF-TIME-2" },
      }),
    ],
  });
  assertEquals((on.error as any).status, 422);
  assertEquals((on.error as any).body?.code, "time_entry_required");
  assertEquals((on.error as any).body?.needs_times, [
    {
      assignment_id: CARD_A,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      work_date: "2026-08-25",
    },
    {
      assignment_id: CARD_B,
      job_id: JOB_B,
      job_number: "SWF-TIME-2",
      work_date: "2026-08-26",
    },
  ]);
  // each job and day, and the one way to give the times
  assertEquals(on.error.message, NEEDS_TIMES_ON_TWO_JOBS);
  assertEquals(on.writes, []);
});

Deno.test("submit_trade_invoice (group switch off): no group table is read", async () => {
  const tables: string[] = [];
  const { client, writes } = legacyClient({
    flagOn: false,
    assignments: [completedCard(CARD_A)],
  });
  const wrapped = {
    from(table: string) {
      tables.push(table);
      return client.from(table);
    },
  };
  await assertRejects(() =>
    submitTradeInvoice(wrapped, TRADE_ID, {
      week_ending: WEEK_END,
      gst_on: false,
    })
  );
  assertEquals(tables.some((table) => table.startsWith("group_")), false);
  assertEquals(
    writes.some((row) =>
      row.table === "trade_invoice_lines" && row.op === "insert"
    ),
    true,
  );
});

// ── 3. A job's list ─────────────────────────────────────────────────────────

const billedEntry = (extra: Record<string, unknown> = {}) => ({
  trade_invoice_line_id: "7d4f0a52-0000-4000-8000-00000000e001",
  job_id: JOB_A,
  job_number: "SWF-TIME-1",
  user_id: TRADE_ID,
  user_name: "Tess Trade",
  work_date: "2026-08-25",
  start_time: "07:00",
  finish_time: "15:30",
  break_minutes: 30,
  hours: 8,
  started_at: "2026-08-24T23:00:00+00:00",
  finished_at: "2026-08-25T07:30:00+00:00",
  line_type: "labour",
  trade_invoice_id: NEW_INVOICE,
  invoice_number: "SW-INV-TT-260830-001",
  invoice_status: "approved",
  submitted_at: "2026-08-30T10:00:00+00:00",
  ...extra,
});

// A job card as the job's list reads it: its hours, its trade and its job.
const listedCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  job_id: JOB_A,
  user_id: TRADE_ID,
  scheduled_date: "2026-08-26",
  status: "complete",
  hours_worked: 8,
  invoiced_in: null,
  users: { name: "Tess Trade" },
  jobs: { job_number: "SWF-TIME-1" },
  ...extra,
});

const jobDetailOf = (stub: Omit<Stub, "flagOn" | "role">) =>
  callTradeAction(
    "job_detail",
    {},
    { flagOn: false, role: "admin", ...stub },
    { jobId: JOB_A },
  );

handlerTest("job_detail: a job's list carries its billed entries and the times saved on the job view, each marked with its source", async () => {
  const OTHER_TRADE = "7d4f0a52-0000-4000-8000-00000000aa02";
  const CARD_C = "7d4f0a52-0000-4000-8000-00000000c003";
  const CARD_D = "7d4f0a52-0000-4000-8000-00000000c004";
  const out = await jobDetailOf({
    cards: [
      listedCard(CARD_A, { scheduled_date: "2026-08-25" }),
      listedCard(CARD_B),
      listedCard(CARD_C, {
        user_id: OTHER_TRADE,
        hours_worked: 6,
        users: { name: "Olly Other" },
      }),
      listedCard(CARD_D, { user_id: OTHER_TRADE, users: { name: "Olly Other" } }),
    ],
    viewEntries: [
      billedEntry(),
      // another job's line is not this job's
      billedEntry({ job_id: JOB_B, trade_invoice_line_id: "other-job" }),
    ],
    loggedTimes: [
      // already billed: the same trade has a time line on this job that day
      savedTimes(CARD_A, JOB_A),
      // not billed yet
      savedTimes(CARD_B, JOB_A, {
        work_date: "2026-08-26",
        start_time: "06:00",
        finish_time: "14:30",
      }),
      // stale: the card's hours were changed since the times were saved
      savedTimes(CARD_C, JOB_A, { user_id: OTHER_TRADE, work_date: "2026-08-26" }),
      // saved by a trade who no longer holds the card
      savedTimes(CARD_D, JOB_A, { work_date: "2026-08-24" }),
      // another job's card
      savedTimes("7d4f0a52-0000-4000-8000-00000000c009", JOB_B),
    ],
  });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.body.trade_time_entries_error, null);
  assertEquals(out.body.trade_time_entries, [
    // who, which day, start, finish, hours, which invoice
    { source: "invoice", ...billedEntry() },
    {
      source: "job_view",
      trade_invoice_line_id: null,
      job_id: JOB_A,
      job_number: "SWF-TIME-1",
      user_id: TRADE_ID,
      user_name: "Tess Trade",
      work_date: "2026-08-26",
      start_time: "06:00",
      finish_time: "14:30",
      break_minutes: 30,
      hours: 8,
      started_at: "2026-08-25T22:00:00.000Z",
      finished_at: "2026-08-26T06:30:00.000Z",
      line_type: null,
      trade_invoice_id: null,
      invoice_number: null,
      invoice_status: null,
      submitted_at: null,
    },
  ]);
  assertEquals(out.writes, []);

  // nobody recorded time: an empty list, with no error
  const none = await jobDetailOf({});
  assertEquals(none.status, 200, JSON.stringify(none.body));
  assertEquals(
    [none.body.trade_time_entries, none.body.trade_time_entries_error],
    [[], null],
  );
});

handlerTest("job_detail: a failed read of either source is unknown with the reason, never a short or empty list", async () => {
  for (const table of ["job_trade_time_entries", "job_assignment_logged_times"]) {
    const out = await jobDetailOf({
      cards: [listedCard(CARD_B)],
      viewEntries: [billedEntry()],
      loggedTimes: [savedTimes(CARD_B, JOB_A, { work_date: "2026-08-26" })],
      fail: { [table]: "relation missing" },
    });
    // the job detail itself still answers
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.body.job?.id, JOB_A);
    assertEquals(out.body.trade_time_entries, null, table);
    assertEquals(out.body.trade_time_entries_error, "relation missing", table);
  }
});

Deno.test("job list: a read that throws is unknown with the reason", async () => {
  assertEquals(
    await loadJobTradeTimeEntries({
      from() {
        throw new Error("no client");
      },
    }, JOB_A),
    { entries: null, error: "no client" },
  );
});

const TIME_FIELDS = {
  work_date: "2026-08-25",
  start_time: "07:00",
  finish_time: "15:30",
  break_minutes: 30,
};

handlerTest("list_trade_invoices: each invoice line answers when it was worked", async () => {
  const out = await callTradeAction("list_trade_invoices", {}, {
    flagOn: false,
    role: "admin",
    invoices: [{
      id: NEW_INVOICE,
      week_start: WEEK_START,
      week_end: WEEK_END,
      total_hours: 8,
      subtotal_ex: 400,
      total_inc: 400,
      invoice_source: "hourly",
      status: "pending_ops_review",
      users: { name: "Tess Trade" },
      lines: [
        {
          id: "line-time",
          job_id: JOB_A,
          job_number: "SWF-TIME-1",
          line_type: "labour",
          total_hours: 8,
          hourly_rate: 50,
          line_total_ex: 400,
          line_position: 0,
          ...TIME_FIELDS,
        },
        {
          id: "line-materials",
          job_id: JOB_A,
          job_number: "SWF-TIME-1",
          line_type: "materials",
          line_total_ex: 20,
          line_position: 1,
        },
      ],
    }],
  });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.body.invoices.length, 1);
  const [timeLine, materials] = out.body.invoices[0].lines;
  assertEquals(timeOf(timeLine), TIME_FIELDS);
  assertEquals(timeLine.total_hours, 8);
  // a line that is not time answers the four fields as null
  assertEquals(timeOf(materials), NO_TIME);
});

handlerTest("crew_charges_on_my_jobs: a lead sees when each crew charge was worked", async () => {
  const charge = (id: string, extra: Record<string, unknown>) => ({
    id,
    job_id: JOB_A,
    job_number: "SWF-TIME-1",
    total_hours: 8,
    hourly_rate: 50,
    line_total_ex: 400,
    line_date: "2026-08-25",
    description: "Install",
    trade_invoices: {
      user_id: "7d4f0a52-0000-4000-8000-00000000aa02",
      week_start: WEEK_START,
      status: "approved",
      users: { name: "Olly Other" },
    },
    ...extra,
  });
  const out = await callTradeAction("crew_charges_on_my_jobs", {}, {
    flagOn: false,
    cards: [{ ...CARDS[0], is_lead: true }],
    invoiceLines: [charge("line-time", TIME_FIELDS), charge("line-old", {})],
  });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(
    out.body.charges.map((row: any) => ({
      line_id: row.line_id,
      trade_name: row.trade_name,
      hours: row.total_hours,
      ...timeOf(row),
    })),
    [
      { line_id: "line-time", trade_name: "Olly Other", hours: 8, ...TIME_FIELDS },
      // a line saved before 12 Oct 2026 carries none
      { line_id: "line-old", trade_name: "Olly Other", hours: 8, ...NO_TIME },
    ],
  );
});

// ── 4. The day worked is never after today, on the submit paths ─────────────

for (const flagOn of [false, true]) {
  const state = flagOn ? "flag on" : "flag off";

  handlerTest(`generate_trade_invoice (${state}): a job card or an hours line dated after today is refused before anything is saved`, async () => {
    const card = await callTradeAction(
      "generate_trade_invoice",
      submitBody([{
        assignment_id: CARD_A,
        work_date: "2099-01-01",
        start_time: "07:00",
        finish_time: "15:00",
      }]),
      { flagOn },
    );
    assertEquals(card.status, 422, JSON.stringify(card.body));
    assertEquals(card.body.code, "time_entry_future_date");
    assertEquals(card.body.saved, false);
    assertEquals(card.writes, []);

    const extra = await callTradeAction(
      "generate_trade_invoice",
      submitBody([], [{
        type: "Labour",
        job_id: JOB_A,
        job_number: "SWF-TIME-1",
        description: "Extra hours",
        rate: 50,
        work_date: "2099-01-01",
        start_time: "07:00",
        finish_time: "15:00",
      }]),
      { flagOn },
    );
    assertEquals(extra.status, 422, JSON.stringify(extra.body));
    assertEquals(extra.body.code, "time_entry_future_date");
    assertEquals(extra.writes, []);
  });
}

// ── 5. Times saved on the job view (log_my_job_hours → my_hours) ────────────

type Tables = Record<string, any[]>;

// A small in-memory PostgREST stand-in: filters are applied to the seeded
// rows, and insert, update, upsert and delete change them.
function tableClient(tables: Tables, fail: Record<string, string> = {}) {
  const from = (table: string) => {
    const preds: Array<(row: any) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let conflict = "id";
    let limitN: number | null = null;
    const matched = () =>
      (tables[table] ||= []).filter((row) => preds.every((p) => p(row)));
    const run = () => {
      const fault = fail[`${op} ${table}`];
      if (fault) return { data: null, error: { message: fault } };
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((
          row: any,
        ) => ({ id: `${table}-${(tables[table] ||= []).length + 1}`, ...row }));
        tables[table].push(...rows);
        return { data: rows, error: null };
      }
      if (op === "upsert") {
        const existing = (tables[table] ||= []).find((row) =>
          String(row[conflict]) === String(payload[conflict])
        );
        if (existing) Object.assign(existing, payload);
        else tables[table].push({ ...payload });
        return { data: [payload], error: null };
      }
      if (op === "update") {
        const rows = matched();
        for (const row of rows) Object.assign(row, payload);
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const rows = matched();
        tables[table] = tables[table].filter((row) => !rows.includes(row));
        return { data: rows, error: null };
      }
      const rows = matched();
      return { data: limitN == null ? rows : rows.slice(0, limitN), error: null };
    };
    const one = () => {
      const out = run();
      return Promise.resolve({
        data: Array.isArray(out.data) ? out.data[0] ?? null : out.data,
        error: out.error,
      });
    };
    const api: any = {
      select: () => api,
      order: () => api,
      or: () => api,
      not: () => api,
      limit(n: number) {
        limitN = n;
        return api;
      },
      eq(column: string, value: unknown) {
        preds.push((row) =>
          String((column === "is_ghost" ? row?.[column] ?? false : row?.[column]) ?? "") ===
            String(value)
        );
        return api;
      },
      neq(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") !== String(value));
        return api;
      },
      is(column: string, value: unknown) {
        preds.push((row) => (row?.[column] ?? null) === value);
        return api;
      },
      in(column: string, values: unknown[]) {
        preds.push((row) => values.map(String).includes(String(row?.[column] ?? "")));
        return api;
      },
      gte(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") >= String(value));
        return api;
      },
      lte(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") <= String(value));
        return api;
      },
      insert(row: any) {
        op = "insert";
        payload = row;
        return api;
      },
      update(row: any) {
        op = "update";
        payload = row;
        return api;
      },
      upsert(row: any, opts?: { onConflict?: string }) {
        op = "upsert";
        payload = row;
        conflict = opts?.onConflict || "id";
        return api;
      },
      delete() {
        op = "delete";
        return api;
      },
      single: one,
      maybeSingle: one,
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  };
  return { from };
}

const jobViewTables = (): Tables => ({
  users: [{
    id: TRADE_ID,
    org_id: ORG_ID,
    role: "trade",
    invoice_type: "hourly",
    trade_details: {},
  }],
  jobs: [{
    id: JOB_A,
    org_id: ORG_ID,
    type: "fencing",
    job_number: "SWF-TIME-1",
    status: "processing",
    metadata: {},
  }],
  job_assignments: [{
    id: CARD_A,
    job_id: JOB_A,
    user_id: TRADE_ID,
    status: "scheduled",
    role: "installer",
    assignment_type: "install",
    scheduled_date: "2026-08-25",
    hours_worked: null,
    invoiced_in: null,
    is_ghost: false,
    jobs: { id: JOB_A, type: "fencing", job_number: "SWF-TIME-1" },
  }],
  trade_rates: [{ user_id: TRADE_ID, hourly_rate: 50, effective_from: "2026-01-01" }],
  job_assignment_logged_times: [],
  job_events: [],
});

const jobViewTrade = {
  id: TRADE_ID,
  email: "tess@example.test",
  orgId: ORG_ID,
  role: "trade",
  managedVerticals: [] as string[],
  seeEverything: false,
};
const jobViewAccess = { orgId: ORG_ID, managedVerticals: [] as string[] };

const logHours = (tables: Tables, body: Record<string, unknown>, fail = {}) =>
  _tradeLogMyJobHoursForTest(
    tableClient(tables, fail),
    { jobId: JOB_A, ...body },
    jobViewTrade as any,
    jobViewAccess,
  );

const weekCards = async (tables: Tables, fail = {}) =>
  (await myHours(
    tableClient(tables, fail),
    TRADE_ID,
    new URLSearchParams({ week_ending: WEEK_END }),
  )).assignments;

Deno.test("log_my_job_hours: times typed on the job view are saved with the card's hours and my_hours returns them", async () => {
  const tables = jobViewTables();
  const res = await logHours(tables, {
    work_date: "2026-08-25",
    start_time: "07:10",
    finish_time: "15:30",
    break_minutes: 30,
  });
  // hours are the server's: 07:10 to 15:30 less 30 minutes, not rounded to
  // the quarter hour
  assertEquals(res.hours, 7.83);
  const entry = {
    work_date: "2026-08-25",
    start_time: "07:10",
    finish_time: "15:30",
    break_minutes: 30,
    hours: 7.83,
  };
  assertEquals(res.time_entry, entry);
  assertEquals(tables.job_assignments[0].hours_worked, 7.83);
  assertEquals(tables.job_assignments[0].status, "complete");
  assertEquals(tables.job_assignment_logged_times.length, 1);
  const saved = tables.job_assignment_logged_times[0];
  assertEquals(
    { assignment_id: saved.assignment_id, job_id: saved.job_id, user_id: saved.user_id },
    { assignment_id: CARD_A, job_id: JOB_A, user_id: TRADE_ID },
  );
  const audit = tables.job_events.find((e) => e.event_type === "trade_hours_logged");
  assertEquals(audit.detail_json.start_time, "07:10");
  assertEquals(audit.detail_json.finish_time, "15:30");

  // the read the Weekly Invoice card uses
  const cards = await weekCards(tables);
  assertEquals(cards.length, 1);
  assertEquals(cards[0].hours, 7.83);
  assertEquals(cards[0].logged_time_entry, entry);

  // a re-log replaces the one saved row, never adds a second
  const again = await logHours(tables, {
    work_date: "2026-08-25",
    start_time: "08:00",
    finish_time: "12:00",
    hours: 4,
  });
  assertEquals(again.hours, 4);
  assertEquals(tables.job_assignment_logged_times.length, 1);
  assertEquals((await weekCards(tables))[0].logged_time_entry, {
    work_date: "2026-08-25",
    start_time: "08:00",
    finish_time: "12:00",
    break_minutes: 0,
    hours: 4,
  });
});

Deno.test("log_my_job_hours: hours logged without times work as before and clear saved times", async () => {
  const tables = jobViewTables();
  await logHours(tables, {
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "15:00",
  });
  const bare = await logHours(tables, { hours: 3.1 });
  assertEquals(bare.hours, 3); // the quarter-hour rule of the bare door
  assertEquals(bare.time_entry, null);
  assertEquals(tables.job_assignments[0].hours_worked, 3);
  assertEquals(tables.job_assignment_logged_times, []);
  const cards = await weekCards(tables);
  assertEquals(cards[0].hours, 3);
  assertEquals(cards[0].logged_time_entry, null);
});

Deno.test("log_my_job_hours: a wrong or half-filled entry is refused and nothing is written", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ work_date: "2099-01-01", start_time: "07:00", finish_time: "15:00" }, "time_entry_future_date"],
    [{ work_date: "2026-08-25", start_time: "15:00", finish_time: "07:00" }, "time_entry_finish_before_start"],
    [{ work_date: "2026-08-25", start_time: "07:00", finish_time: "15:00", hours: 9 }, "time_entry_hours_mismatch"],
    [{ work_date: "2026-08-25", start_time: "07:00", hours: 8 }, "time_entry_required"],
    [{ work_date: "2026-08-25", start_time: "7am", finish_time: "15:00" }, "time_entry_invalid"],
  ];
  for (const [body, code] of cases) {
    const tables = jobViewTables();
    const error = await assertRejects(() => logHours(tables, body)) as any;
    assertEquals(error.status, 422, code);
    assertEquals(error.body?.code, code);
    assertEquals(tables.job_assignments[0].hours_worked, null, code);
    assertEquals(tables.job_assignment_logged_times, [], code);
    assertEquals(tables.job_events, [], code);
  }
});

Deno.test("log_my_job_hours: when the times cannot be saved the card's hours are not changed", async () => {
  const tables = jobViewTables();
  await assertRejects(() =>
    logHours(tables, {
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:00",
    }, { "upsert job_assignment_logged_times": "relation missing" })
  );
  assertEquals(tables.job_assignments[0].hours_worked, null);
  assertEquals(tables.job_assignments[0].status, "scheduled");
});

Deno.test("my_hours: saved times are shown only while they still describe the card's hours", async () => {
  const tables = jobViewTables();
  await logHours(tables, {
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "15:00",
  });
  // another writer (the office, the clock) changes the hours afterwards
  tables.job_assignments[0].hours_worked = 6;
  assertEquals((await weekCards(tables))[0].logged_time_entry, null);
  tables.job_assignments[0].hours_worked = 8;
  assertEquals((await weekCards(tables))[0].logged_time_entry?.start_time, "07:00");

  // a failed read of the saved times never fails the hours view
  const cards = await weekCards(tables, {
    "select job_assignment_logged_times": "relation missing",
  });
  assertEquals(cards.length, 1);
  assertEquals(cards[0].hours, 8);
  assertEquals(cards[0].logged_time_entry, null);

  // the pure rule
  const row = {
    user_id: TRADE_ID,
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "15:00",
    break_minutes: null,
    hours: "8",
  };
  assertEquals(loggedTimeEntryForCard(row, 8.004)?.finish_time, "15:00");
  assertEquals(loggedTimeEntryForCard(row, 8.5), null);
  assertEquals(loggedTimeEntryForCard(row, null), null);
  assertEquals(loggedTimeEntryForCard(null, 8), null);
  // only the trade who saved them
  assertEquals(loggedTimeEntryForCard(row, 8, TRADE_ID)?.start_time, "07:00");
  assertEquals(loggedTimeEntryForCard(row, 8, "someone-else"), null);
  // a stored time is exactly HH:MM
  assertEquals(loggedTimeEntryForCard({ ...row, start_time: "07:00:00" }, 8), null);
});

// ── 6. Two days on one job are two job cards ────────────────────────────────

const CARD_MON = "7d4f0a52-0000-4000-8000-00000000c0a1";
const CARD_TUE = "7d4f0a52-0000-4000-8000-00000000c0a2";

// A job card with no clock record, as the hours view and the clock lane read it.
const dayCard = (id: string, scheduled_date: string, extra: Record<string, unknown> = {}) => ({
  id,
  job_id: JOB_A,
  user_id: TRADE_ID,
  status: "complete",
  role: "installer",
  assignment_type: "install",
  scheduled_date,
  hours_worked: 8,
  break_minutes: 0,
  manual_override_flag: false,
  clocked_on_at: null,
  clocked_off_at: null,
  invoiced_in: null,
  is_ghost: false,
  jobs: { id: JOB_A, type: "fencing", job_number: "SWF-TIME-1" },
  ...extra,
});

const twoDayTables = (): Tables => ({
  ...jobViewTables(),
  job_assignments: [
    dayCard(CARD_MON, "2026-08-24"),
    dayCard(CARD_TUE, "2026-08-25"),
  ],
});

const cardOf = (tables: Tables, id: string) =>
  tables.job_assignments.find((row) => row.id === id);
const savedOf = (tables: Tables, id: string) => {
  const row = tables.job_assignment_logged_times.find((saved) =>
    saved.assignment_id === id
  );
  return row ? { ...timeOf(row), hours: row.hours } : null;
};

handlerTest("two days on one job (flag on): each day's times go on that day's card, and the invoice carries only what the trade enters on its cards", async () => {
  const tables = twoDayTables();
  const submit = (manual_assignments: any[] = []) =>
    callTradeAction(
      "generate_trade_invoice",
      { ...clockBody, manual_assignments },
      {
        flagOn: true,
        cards: tables.job_assignments,
        loggedTimes: tables.job_assignment_logged_times,
      },
    );

  // no cards entered: the server collects both, and neither says when
  const refused = await submit();
  assertEquals(refused.status, 422, JSON.stringify(refused.body));
  assertEquals(refused.body.code, "time_entry_required");
  assertEquals(
    refused.body.needs_times.map((card: any) => [card.assignment_id, card.work_date]),
    [[CARD_MON, "2026-08-24"], [CARD_TUE, "2026-08-25"]],
  );
  assertEquals(refused.writes, []);

  // the trade logs each day on the job view
  const monday = await logHours(tables, {
    work_date: "2026-08-24",
    start_time: "07:00",
    finish_time: "15:30",
    break_minutes: 30,
  });
  assertEquals(monday.assignment.id, CARD_MON);
  const tuesday = await logHours(tables, {
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "11:00",
  });
  assertEquals(tuesday.assignment.id, CARD_TUE);

  // logging one day never replaced the other day's hours
  assertEquals(
    [cardOf(tables, CARD_MON).hours_worked, cardOf(tables, CARD_TUE).hours_worked],
    [8, 4],
  );
  assertEquals(savedOf(tables, CARD_MON), {
    work_date: "2026-08-24",
    start_time: "07:00",
    finish_time: "15:30",
    break_minutes: 30,
    hours: 8,
  });
  assertEquals(savedOf(tables, CARD_TUE), {
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "11:00",
    break_minutes: 0,
    hours: 4,
  });

  // times saved on the job view are not an invoice line's entry: the same
  // submit is refused the same way
  const stillRefused = await submit();
  assertEquals(stillRefused.status, 422, JSON.stringify(stillRefused.body));
  assertEquals(
    stillRefused.body.needs_times.map((card: any) => card.assignment_id),
    [CARD_MON, CARD_TUE],
  );
  assertEquals(stillRefused.writes, []);

  // the Weekly Invoice card opens on each card's saved times, and the trade
  // submits them as that card's own line
  const cards = await weekCards(tables);
  assertEquals(
    cards.map((card: any) => [card.id, card.logged_time_entry?.work_date]),
    [[CARD_MON, "2026-08-24"], [CARD_TUE, "2026-08-25"]],
  );
  const sent = await submit(
    cards.map((card: any) => ({
      assignment_id: card.id,
      ...card.logged_time_entry,
    })),
  );
  const labour = sent.lineRows.filter((row) => row.line_type === "labour");
  assertEquals(labour.length, 2, JSON.stringify(sent.body));
  assertEquals(
    labour.map((row) => ({
      cards: row.assignment_ids,
      hours: row.total_hours,
      ...timeOf(row),
    })),
    [
      {
        cards: [CARD_MON],
        hours: 8,
        work_date: "2026-08-24",
        start_time: "07:00",
        finish_time: "15:30",
        break_minutes: 30,
      },
      {
        cards: [CARD_TUE],
        hours: 4,
        work_date: "2026-08-25",
        start_time: "07:00",
        finish_time: "11:00",
        break_minutes: 0,
      },
    ],
  );
});

Deno.test("log_my_job_hours: a named job card wins over the day, and a card that is not the trade's is refused", async () => {
  const tables = twoDayTables();
  // the trade corrects the Tuesday card: it was worked on the Wednesday
  const named = await logHours(tables, {
    assignment_id: CARD_TUE,
    work_date: "2026-08-26",
    start_time: "08:00",
    finish_time: "14:00",
  });
  assertEquals(named.assignment.id, CARD_TUE);
  assertEquals(
    [cardOf(tables, CARD_MON).hours_worked, cardOf(tables, CARD_TUE).hours_worked],
    [8, 6],
  );
  assertEquals(savedOf(tables, CARD_MON), null);
  assertEquals(savedOf(tables, CARD_TUE)?.work_date, "2026-08-26");

  // a named card also takes hours logged without times
  const bare = await logHours(tables, { assignment_id: CARD_MON, hours: 5 });
  assertEquals(bare.assignment.id, CARD_MON);
  assertEquals(
    [cardOf(tables, CARD_MON).hours_worked, cardOf(tables, CARD_TUE).hours_worked],
    [5, 6],
  );

  // a card that is not this trade's on this job: nothing is written
  const before = JSON.stringify(tables);
  for (
    const assignment_id of [
      "7d4f0a52-0000-4000-8000-00000000c0ff",
      "not-a-card",
    ]
  ) {
    const error = await assertRejects(() =>
      logHours(tables, {
        assignment_id,
        work_date: "2026-08-24",
        start_time: "07:00",
        finish_time: "15:00",
      })
    ) as any;
    assertEquals(error.status, 404, assignment_id);
  }
  tables.job_assignments.push(
    dayCard("7d4f0a52-0000-4000-8000-00000000c0b1", "2026-08-26", {
      user_id: "7d4f0a52-0000-4000-8000-00000000aa02",
    }),
  );
  const someoneElses = await assertRejects(() =>
    logHours(tables, {
      assignment_id: "7d4f0a52-0000-4000-8000-00000000c0b1",
      work_date: "2026-08-26",
      start_time: "07:00",
      finish_time: "15:00",
    })
  ) as any;
  assertEquals(someoneElses.status, 404);
  tables.job_assignments.pop();
  assertEquals(JSON.stringify(tables), before);
});

Deno.test("log_my_job_hours: times for a day other than the card's scheduled day land on a card holding hours with no saved times", async () => {
  // one card scheduled Tuesday; 2 hours were logged on it without times
  const tables: Tables = {
    ...jobViewTables(),
    job_assignments: [dayCard(CARD_TUE, "2026-08-25", { hours_worked: 2 })],
  };
  // the work was done on the Wednesday
  const logged = await logHours(tables, {
    work_date: "2026-08-26",
    start_time: "09:00",
    finish_time: "11:30",
  });
  assertEquals(logged.assignment.id, CARD_TUE);
  assertEquals(logged.hours, 2.5);
  assertEquals(cardOf(tables, CARD_TUE).hours_worked, 2.5);
  assertEquals(cardOf(tables, CARD_TUE).scheduled_date, "2026-08-25");
  assertEquals(savedOf(tables, CARD_TUE), {
    work_date: "2026-08-26",
    start_time: "09:00",
    finish_time: "11:30",
    break_minutes: 0,
    hours: 2.5,
  });
  assertEquals((await weekCards(tables))[0].logged_time_entry?.work_date, "2026-08-26");

  // the office changes the hours: the saved times no longer describe them, so
  // they hold no day and a log for another day lands
  cardOf(tables, CARD_TUE).hours_worked = 5;
  const later = await logHours(tables, {
    work_date: "2026-08-27",
    start_time: "07:00",
    finish_time: "10:00",
  });
  assertEquals(later.assignment.id, CARD_TUE);
  assertEquals(cardOf(tables, CARD_TUE).hours_worked, 3);
  assertEquals(tables.job_assignment_logged_times.length, 1);
  assertEquals(savedOf(tables, CARD_TUE)?.work_date, "2026-08-27");
});

Deno.test("log_my_job_hours: with no card scheduled that day the usual card is used, but never one holding saved times for another day", async () => {
  // one card, scheduled Tuesday, no hours yet; the work was done on Wednesday
  const tables: Tables = {
    ...jobViewTables(),
    job_assignments: [
      dayCard(CARD_TUE, "2026-08-25", { status: "scheduled", hours_worked: null }),
    ],
  };
  const wednesday = { work_date: "2026-08-26", start_time: "07:00", finish_time: "15:00" };
  const first = await logHours(tables, wednesday);
  assertEquals(first.assignment.id, CARD_TUE);
  assertEquals(cardOf(tables, CARD_TUE).hours_worked, 8);

  // logging the same day again corrects that card
  const again = await logHours(tables, { ...wednesday, finish_time: "13:00" });
  assertEquals(again.assignment.id, CARD_TUE);
  assertEquals(cardOf(tables, CARD_TUE).hours_worked, 6);
  assertEquals(tables.job_assignment_logged_times.length, 1);
  assertEquals(savedOf(tables, CARD_TUE)?.finish_time, "13:00");

  // the only card holds saved times for the Wednesday: a log for any other
  // day, its own scheduled day included, is refused
  for (const work_date of ["2026-08-27", "2026-08-25"]) {
    const before = JSON.stringify(tables);
    const error = await assertRejects(() =>
      logHours(tables, { work_date, start_time: "07:00", finish_time: "09:00" })
    ) as any;
    assertEquals(error.status, 409, work_date);
    assertStringIncludes(error.message, "2026-08-26");
    assertStringIncludes(error.message, work_date);
    assertStringIncludes(error.message, "Weekly Invoice");
    assertEquals(JSON.stringify(tables), before, work_date);
  }

  // hours logged without times keep the usual pick, as before
  const twoDays = twoDayTables();
  const bare = await logHours(twoDays, { hours: 3 });
  assertEquals(bare.assignment.id, CARD_TUE);
  assertEquals(
    [cardOf(twoDays, CARD_MON).hours_worked, cardOf(twoDays, CARD_TUE).hours_worked],
    [8, 3],
  );

  // the saved times that decide a card's day must be readable
  const unreadable = twoDayTables();
  await assertRejects(() =>
    logHours(unreadable, {
      work_date: "2026-08-24",
      start_time: "07:00",
      finish_time: "15:00",
    }, { "select job_assignment_logged_times": "relation missing" })
  );
  assertEquals(
    [cardOf(unreadable, CARD_MON).hours_worked, cardOf(unreadable, CARD_TUE).hours_worked],
    [8, 8],
  );
});
