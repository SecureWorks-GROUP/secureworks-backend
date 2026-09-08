/**
 * Trade invoicing money audit (2026-09) regression pins.
 *
 *  2. generate_trade_invoice manual lane: rate is server-side only, hours are
 *     sanitised (finite, > 0, <= 24).
 *  3. generate_trade_invoice: one live invoice per trade + week_end. A second
 *     submit returns the existing invoice instead of minting a second bill.
 *  4. submitTradeInvoice (legacy hourly lane) applies the assignment lock:
 *     live-held cards are refused and covered cards are stamped invoiced_in
 *     before any Xero contact.
 *  5. $35/m lives in one constant, overridable from users.trade_details.
 *  6. submitTradeInvoice takes the billing mode from users.invoice_type.
 *  7. my_hours preview reuses the invoice money split.
 *
 * Fake client pattern follows trade_invoice_weekly_resolver_test.ts: a
 * thenable builder that resolves per-table fixtures and records writes.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _findLiveTradeInvoiceForWeek,
  _resolvePerMetreRate,
  _sanitiseManualAssignmentHours,
  myHours,
  PER_METRE_DEFAULT_RATE,
  submitTradeInvoice,
} from "./index.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const WEEK_END = "2026-08-30";
const LIVE_INVOICE = "11111111-1111-1111-1111-111111111111";
const NEW_INVOICE = "22222222-2222-2222-2222-222222222222";

type Fixtures = {
  user?: any;
  assignments?: any[];
  invoices?: any[];
  rates?: any[];
};

type Write = { table: string; op: string; payload: any; filters: Record<string, unknown> };

function fakeClient(fx: Fixtures): { client: any; writes: Write[] } {
  const writes: Write[] = [];
  const client = {
    from(table: string) {
      let op = "select";
      let payload: any = null;
      const filters: Record<string, unknown> = {};
      const rows = (): any[] => {
        if (table === "users") return fx.user ? [fx.user] : [];
        if (table === "trade_rates") return fx.rates || [];
        if (table === "job_assignments") {
          const all = fx.assignments || [];
          if (op === "update") {
            const ids = Array.isArray(filters.id) ? filters.id.map(String) : null;
            return all.filter((a) => !ids || ids.includes(String(a.id)));
          }
          if (Array.isArray(filters.id)) {
            return all.filter((a) => (filters.id as unknown[]).map(String).includes(String(a.id)));
          }
          return all;
        }
        if (table === "trade_invoices") {
          if (op === "insert") return [{ id: NEW_INVOICE }];
          const all = fx.invoices || [];
          if (Array.isArray(filters.id)) {
            return all.filter((i) => (filters.id as unknown[]).map(String).includes(String(i.id)));
          }
          if (filters.week_end !== undefined) {
            return all.filter((i) => i.week_end === filters.week_end && (!filters.user_id || i.user_id === filters.user_id));
          }
          return all;
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
        maybeSingle: () => builder.then((r: any) => ({ data: (r.data || [])[0] ?? null, error: null })),
        single: () => builder.then((r: any) => ({ data: (r.data || [])[0] ?? null, error: null })),
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          if (op !== "select") writes.push({ table, op, payload, filters: { ...filters } });
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client, writes };
}

const completeAssignment = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  user_id: USER_ID,
  scheduled_date: "2026-08-26",
  started_at: "2026-08-26T00:00:00Z",
  completed_at: "2026-08-26T08:00:00Z",
  hours_worked: 8,
  status: "complete",
  role: "installer",
  assignment_type: "install",
  invoiced_in: null,
  jobs: { id: "job-1", type: "fencing", job_number: "SWF-1", client_name: "Client", site_address: "1 St", site_suburb: "Perth" },
  ...extra,
});

// ── 2. manual lane: sanitised hours, server-side rate ───────────────────────

Deno.test("audit 2: manual hours must be finite, more than 0 and at most 24", () => {
  assertEquals(_sanitiseManualAssignmentHours(8), 8);
  assertEquals(_sanitiseManualAssignmentHours("7.5"), 7.5);
  assertEquals(_sanitiseManualAssignmentHours(0), null);
  assertEquals(_sanitiseManualAssignmentHours(-1), null);
  assertEquals(_sanitiseManualAssignmentHours(24.01), null);
  assertEquals(_sanitiseManualAssignmentHours("abc"), null);
  assertEquals(_sanitiseManualAssignmentHours(Infinity), null);
  assertEquals(_sanitiseManualAssignmentHours(undefined), null);
});

Deno.test("audit 2: generate_trade_invoice manual lane never reads a client rate", () => {
  assertStringIncludes(INDEX, "hoursById[m.assignment_id] = cleanHours");
  assertStringIncludes(INDEX, "hours_worked: h, hourly_rate: resolvedRate,");
  assertEquals(INDEX.includes("clientRateProvided"), false, "client rate path must be gone");
  assertEquals(INDEX.includes("anyClientRate"), false, "client rate must not bypass RATE_NOT_CONFIGURED");
});

// ── 3. one live invoice per trade + week ─────────────────────────────────────

Deno.test("audit 3: a live invoice for the week is found; drafts are released", async () => {
  const { client } = fakeClient({
    invoices: [
      { id: "draft-1", user_id: USER_ID, week_end: WEEK_END, status: "draft" },
      { id: LIVE_INVOICE, user_id: USER_ID, week_end: WEEK_END, status: "pushed_to_xero", invoice_number: "SW-INV-1" },
    ],
  });
  const live = await _findLiveTradeInvoiceForWeek(client, USER_ID, WEEK_END);
  assertEquals(live?.id, LIVE_INVOICE);

  const draftsOnly = fakeClient({
    invoices: [{ id: "draft-1", user_id: USER_ID, week_end: WEEK_END, status: "draft" }],
  });
  assertEquals(await _findLiveTradeInvoiceForWeek(draftsOnly.client, USER_ID, WEEK_END), null);
});

Deno.test("audit 3: generate_trade_invoice returns the existing live invoice instead of a second bill", () => {
  const guardAt = INDEX.indexOf("const liveWeekInvoice = await _findLiveTradeInvoiceForWeek(client, tradeUser.id, weekEnd)");
  const insertAt = INDEX.indexOf("const invoicePayload = {");
  assert(guardAt > 0, "weekly dedupe guard must be wired into generate_trade_invoice");
  assert(guardAt < insertAt, "the guard must run before the invoice is persisted");
  const guard = INDEX.slice(guardAt, guardAt + 1500);
  assertStringIncludes(guard, "already_submitted: true");
});

// ── 4. legacy hourly lane applies the assignment lock ───────────────────────

Deno.test("audit 4: submitTradeInvoice refuses job cards held by a live invoice", async () => {
  const { client } = fakeClient({
    user: { id: USER_ID, name: "Trade", invoice_type: "hourly", trade_details: {} },
    assignments: [
      completeAssignment("asn-1", { invoiced_in: LIVE_INVOICE }),
      completeAssignment("asn-2", { invoiced_in: LIVE_INVOICE }),
    ],
    invoices: [{ id: LIVE_INVOICE, user_id: USER_ID, week_end: "2026-08-23", status: "pushed_to_xero" }],
    rates: [{ hourly_rate: 50 }],
  });
  await assertRejects(
    () => submitTradeInvoice(client, USER_ID, { week_ending: WEEK_END, gst_on: false }),
    Error,
    "already on a live invoice",
  );
});

Deno.test("audit 4: submitTradeInvoice stamps invoiced_in on covered cards before Xero", async () => {
  const { client, writes } = fakeClient({
    user: { id: USER_ID, name: "Trade", invoice_type: "hourly", trade_details: {} },
    assignments: [completeAssignment("asn-1"), completeAssignment("asn-2")],
    rates: [{ hourly_rate: 50 }],
  });
  // The fake has no xero_tokens row, so the run stops at the Xero boundary.
  await assertRejects(
    () => submitTradeInvoice(client, USER_ID, { week_ending: WEEK_END, gst_on: false }),
    Error,
    "No Xero token available",
  );
  const stamp = writes.find((w) => w.table === "job_assignments" && w.op === "update" && w.payload?.invoiced_in === NEW_INVOICE);
  assert(stamp, "covered assignments must be stamped with the new invoice id");
  assertEquals((stamp!.filters.id as string[]).sort(), ["asn-1", "asn-2"]);
  const invoiceInsertAt = writes.findIndex((w) => w.table === "trade_invoices" && w.op === "insert");
  assert(writes.indexOf(stamp!) > invoiceInsertAt, "stamp must follow the local invoice insert");
});

// ── 5. one per-metre constant ────────────────────────────────────────────────

Deno.test("audit 5: per-metre rate has one default and honours the user's own rate", () => {
  assertEquals(PER_METRE_DEFAULT_RATE, 35);
  assertEquals(_resolvePerMetreRate(null), 35);
  assertEquals(_resolvePerMetreRate({ gstRegistered: true }), 35);
  assertEquals(_resolvePerMetreRate({ ratePerMetre: 40 }), 40);
  assertEquals(_resolvePerMetreRate({ ratePerMetre: "abc" }), 35);
  assertEquals(INDEX.includes("|| 35"), false, "no hard-coded $35/m fallback may remain");
  assertStringIncludes(INDEX, "labourPerM:PER_METRE_DEFAULT_RATE");
});

// ── 6. billing mode comes from the users row ────────────────────────────────

Deno.test("audit 6: submitTradeInvoice ignores the client invoice_type and uses users.invoice_type", async () => {
  // Client claims per_metre and sends metres; the users row says hourly, and
  // there are no completed hours, so the HOURLY refusal must fire.
  const { client } = fakeClient({
    user: { id: USER_ID, name: "Trade", invoice_type: "hourly", trade_details: {} },
    assignments: [completeAssignment("asn-1", { status: "scheduled", started_at: null, completed_at: null })],
    rates: [{ hourly_rate: 50 }],
  });
  await assertRejects(
    () =>
      submitTradeInvoice(client, USER_ID, {
        week_ending: WEEK_END,
        gst_on: false,
        invoice_type: "per_metre",
        rate_per_metre: 99,
        items: [{ job_id: "job-1", metres: 10 }],
      }),
    Error,
    "No completed hours found for this week",
  );
  assertStringIncludes(INDEX, "invoice_type_source: 'user'");
});

// ── 7. my_hours preview reuses the invoice money split ──────────────────────

Deno.test("audit 7: my_hours preview money equals calculateTradeInvoiceMoney", async () => {
  const { client } = fakeClient({
    user: { id: USER_ID, invoice_type: "hourly", trade_details: { gstRegistered: true } },
    assignments: [completeAssignment("asn-1", { hours_worked: 8 })],
    rates: [{ hourly_rate: 50, effective_from: "2026-01-01" }],
  });
  const preview = await myHours(client, USER_ID, new URLSearchParams({ week_ending: WEEK_END }));
  const expected = calculateTradeInvoiceMoney({ grossEarned: 400, gstOn: true, earningsDate: WEEK_END });
  assertEquals(preview.subtotal, 400);
  assertEquals(preview.gst, expected.gst_amount);
  assertEquals(preview.super_amount, expected.super_amount);
  assertEquals(preview.net_pay, expected.net_pay);
  assertEquals(preview.trade_payable, expected.trade_payable);
  assertEquals(preview.total, expected.total_inc);
  assertEquals(INDEX.includes("const gst = Math.round(subtotal * 0.1 * 100) / 100"), false);
});
