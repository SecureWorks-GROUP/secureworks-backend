import {
  assertEquals,
  assertRejects,
  // deno-lint-ignore no-import-prefix
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { syncXeroAccounts, xeroAccountRow } from "./accounts.ts";
import {
  BANK_TXN_HEAL_LIMIT,
  BANK_TXN_PAGE_SIZE,
  bankTransactionLinesRow,
  bankTransactionRow,
  bankTransactionsWhere,
  bankTransactionType,
  dayBeforeFinancialYear,
  daysAgo,
  syncBankTransactionLines,
} from "./bank_transactions.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const KEY = `bank_transactions:${ORG}:${TENANT}`;
const FULL = `bank_transactions_full:${ORG}:${TENANT}`;
const NOW = new Date("2026-11-15T02:00:00.000Z");
const WHERE_90 = "Date>DateTime(2026,08,17)&&IsReconciled==true";
const WHERE_WIDE = "Date>DateTime(2026,06,30)&&IsReconciled==true";
const HEAD = "xero_bank_transactions";
const LINES = "xero_bank_transaction_lines";

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Shaped like Xero's paged /BankTransactions entries; synthetic values only.
function txn(n: number, over: Record<string, unknown> = {}) {
  return {
    BankTransactionID: id(n),
    Type: "SPEND",
    BankAccount: { AccountID: "bbbbbbbb-0000-4000-8000-000000000001", Name: "Synthetic Card" },
    Contact: { ContactID: "cccccccc-0000-4000-8000-000000000001", Name: "Synthetic Hardware" },
    DateString: "2026-10-03T00:00:00",
    Date: "/Date(1790985600000+0000)/",
    Reference: "Screws",
    Status: "AUTHORISED",
    IsReconciled: true,
    LineAmountTypes: "Inclusive",
    SubTotal: 100,
    TotalTax: 10,
    Total: 110,
    UpdatedDateUTC: "/Date(1791072000000+0000)/",
    LineItems: [
      { LineItemID: "l1", Description: "Screws", AccountCode: "310", TaxAmount: 6, LineAmount: 66, Tracking: [] },
      { LineItemID: "l2", Description: "Fuel", AccountCode: "449", TaxAmount: 4, LineAmount: 44 },
    ],
    ...over,
  };
}
/** The same transaction as the unpaged list sends it: no lines. */
const bare = (n: number, over: Record<string, unknown> = {}) => txn(n, { LineItems: undefined, ...over });

type Upsert = { table: string; rows: Record<string, unknown>[] };

function fakeDb(opts: {
  cursors?: { key: string; cursor_at: string | null }[];
  cursorError?: string;
  failBulk?: string;
  failRow?: { table: string; id: string };
  cursorWriteError?: string;
} = {}) {
  const upserts: Upsert[] = [];
  const sb = {
    from(table: string) {
      return {
        select: () => ({
          in: () =>
            Promise.resolve(
              opts.cursorError
                ? { data: null, error: { message: opts.cursorError } }
                : { data: opts.cursors ?? [], error: null },
            ),
        }),
        upsert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          if (table === "xero_sync_state" && opts.cursorWriteError) {
            return Promise.resolve({ error: { message: opts.cursorWriteError } });
          }
          if (Array.isArray(payload) && opts.failBulk === table) {
            return Promise.resolve({ error: { message: "bulk refused" } });
          }
          if (!Array.isArray(payload) && opts.failRow?.table === table && payload.xero_txn_id === opts.failRow.id) {
            return Promise.resolve({ error: { message: "row refused" } });
          }
          upserts.push({ table, rows });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const rowsOf = (table: string) => upserts.filter((u) => u.table === table).flatMap((u) => u.rows);
  return { sb, upserts, rowsOf, cursorKeys: () => rowsOf("xero_sync_state").map((c) => c.key) };
}

type Call = { path: string; params: Record<string, string>; headers: Record<string, string> };
type Answer = unknown[] | Error;

/** Answers by request shape: unpaged list (by where), paged list (by where and page), one by id. */
function fakeXero(a: { unpaged?: Record<string, Answer>; paged?: Record<string, Answer[]>; byId?: Record<string, Answer> }) {
  const calls: Call[] = [];
  const get = (path: string, params: Record<string, string>, headers: Record<string, string>) => {
    calls.push({ path, params, headers });
    let answer: Answer | undefined;
    if (path !== "/BankTransactions") answer = a.byId?.[path.split("/").pop()!] ?? [];
    else if (params.page) answer = a.paged?.[params.where]?.[Number(params.page) - 1] ?? [];
    else answer = a.unpaged?.[params.where] ?? [];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ BankTransactions: answer });
  };
  return { get, calls, paged: () => calls.filter((c) => c.params.page), byId: () => calls.filter((c) => c.path !== "/BankTransactions") };
}

Deno.test("the transaction row keeps every earlier field's meaning and carries no line text", () => {
  const row = bankTransactionRow(txn(1), ORG, NOW)!;
  assertEquals(row, {
    org_id: ORG,
    xero_txn_id: id(1),
    account_id: "bbbbbbbb-0000-4000-8000-000000000001",
    account_name: "Synthetic Card",
    txn_date: "2026-10-03",
    txn_type: "SPEND",
    contact_name: "Synthetic Hardware",
    contact_id: "cccccccc-0000-4000-8000-000000000001",
    reference: "Screws",
    amount: -110,
    sub_total: 100,
    total_tax: 10,
    status: "AUTHORISED",
    is_reconciled: true,
    synced_at: NOW.toISOString(),
  });
});

Deno.test("the lines row is Xero's lines as sent, and absent when there are none", () => {
  const row = bankTransactionLinesRow(txn(1), ORG, NOW)!;
  assertEquals(row.xero_txn_id, id(1));
  // Xero's own type, not the folded SPEND / RECEIVE / TRANSFER: a prepayment stays a prepayment.
  assertEquals(row.xero_type, "SPEND");
  assertEquals(bankTransactionLinesRow(txn(1, { Type: "SPEND-PREPAYMENT" }), ORG, NOW)!.xero_type, "SPEND-PREPAYMENT");
  assertEquals(bankTransactionLinesRow(txn(1, { Type: undefined }), ORG, NOW)!.xero_type, null);
  assertEquals(row.line_amount_types, "Inclusive");
  assertEquals(row.line_items.length, 2);
  assertEquals(row.line_items[1].AccountCode, "449");
  assertEquals(row.xero_updated_at, "2026-10-04T00:00:00.000Z");
  for (const over of [{ LineItems: undefined }, { LineItems: [] }, { LineItems: "x" }, { BankTransactionID: undefined }]) {
    assertEquals(bankTransactionLinesRow(txn(1, over), ORG, NOW), null);
  }
});

Deno.test("types, signs, missing identity and the fallbacks the earlier code had", () => {
  assertEquals(bankTransactionType("RECEIVE-PREPAYMENT"), "RECEIVE");
  assertEquals(bankTransactionType("SPEND-TRANSFER"), "TRANSFER");
  assertEquals(bankTransactionType("SPEND-OVERPAYMENT"), "SPEND");
  assertEquals(bankTransactionRow(txn(1, { Type: "RECEIVE" }), ORG, NOW)!.amount, 110);
  assertEquals(bankTransactionRow(txn(1, { Total: 0, SubTotal: 40 }), ORG, NOW)!.amount, -40);
  assertEquals(bankTransactionRow(txn(1, { Total: "110" }), ORG, NOW)!.amount, -110);
  assertEquals(bankTransactionRow(txn(1, { TotalTax: 0 }), ORG, NOW)!.total_tax, null);
  assertEquals(bankTransactionRow(txn(1, { IsReconciled: undefined }), ORG, NOW)!.is_reconciled, true);
  assertEquals(bankTransactionRow(txn(1, { BankTransactionID: undefined }), ORG, NOW), null);
  assertEquals(bankTransactionRow(txn(1, { DateString: undefined }), ORG, NOW)!.txn_date, "2026-10-03");
  assertEquals(
    bankTransactionRow(txn(1, { DateString: undefined, Date: "2026-10-01T00:00:00+08:00" }), ORG, NOW)!.txn_date,
    "2026-10-01",
  );
  assertEquals(
    bankTransactionRow(txn(1, { DateString: undefined, Date: undefined }), ORG, NOW)!.txn_date,
    "2026-11-15",
  );
  assertEquals(bankTransactionRow(txn(1, { BankAccount: undefined }), ORG, NOW)!.account_id, "");
});

Deno.test("window helpers", () => {
  assertEquals(dayBeforeFinancialYear(new Date("2026-11-15T02:00:00Z")), "2026-06-30");
  assertEquals(dayBeforeFinancialYear(new Date("2026-06-30T15:59:00Z")), "2025-06-30");
  // 16:00 UTC on 30 June is already 1 July in Perth.
  assertEquals(dayBeforeFinancialYear(new Date("2026-06-30T16:00:00Z")), "2026-06-30");
  assertEquals(daysAgo(NOW, 90), "2026-08-17");
  assertEquals(bankTransactionsWhere("2026-08-17"), WHERE_90);
});

Deno.test("an ordinary run before the first whole read: the old read, and nothing else", async () => {
  const db = fakeDb();
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1), bare(2), bare(2)] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(xero.calls.length, 1);
  assertEquals(xero.calls[0], { path: "/BankTransactions", params: { where: WHERE_90, order: "Date DESC" }, headers: {} });
  assertEquals(result.transactions_synced, 2);
  assertEquals(result.lines, { ok: null, mode: "waiting", reason: "awaiting_first_whole_read" });
  assertEquals(db.rowsOf(HEAD).map((r) => r.xero_txn_id), [id(1), id(2)]);
  // The widely readable table never receives line text.
  assertEquals(db.rowsOf(HEAD).every((r) => !("line_items" in r) && !("description" in r)), true);
  assertEquals(db.rowsOf(LINES).length, 0);
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("an ordinary run after it: the old read plus only what changed, over the wide window", async () => {
  const db = fakeDb({
    cursors: [
      { key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" },
      { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" },
    ],
  });
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1)] }, paged: { [WHERE_WIDE]: [[txn(7)]] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(xero.calls.length, 2);
  assertEquals(xero.calls[1].headers, { "If-Modified-Since": "2026-11-15T01:30:00.000Z" });
  assertEquals(xero.calls[1].params, { where: WHERE_WIDE, order: "Date DESC", page: "1", pageSize: "100" });
  assertEquals(result.lines, {
    ok: true,
    mode: "incremental",
    pages: 1,
    written: 1,
    modified_since: "2026-11-15T01:30:00.000Z",
    healed: 0,
  });
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id), [id(7)]);
  // Only the incremental cursor moves.
  assertEquals(db.cursorKeys(), [KEY]);
});

Deno.test("304 to the incremental read means nothing changed, and the cursor moves", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" }] });
  const xero = fakeXero({ paged: { [WHERE_WIDE]: [new XeroSyncProviderError(304, "/BankTransactions")] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(result.lines.ok, true);
  assertEquals(db.rowsOf(LINES).length, 0);
  assertEquals(db.cursorKeys(), [KEY]);
});

Deno.test("a failed lines read never fails the transaction copy, and moves no cursor", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1)] },
    paged: { [WHERE_WIDE]: [new XeroSyncProviderError(500, "/BankTransactions")] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(result.success, true);
  assertEquals(result.transactions_synced, 1);
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.mode, "incremental");
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("an unreadable cursor is a failed lines read, not a failed copy", async () => {
  const db = fakeDb({ cursorError: "permission denied" });
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1)] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.transactions_synced, 1);
  assertEquals(result.lines.ok, false);
  assertEquals(xero.calls.length, 1);
});

Deno.test("a rate limit always stops the run", async () => {
  const cooldown = Object.create(XeroCooldownError.prototype) as Error;
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" }] });
  const xero = fakeXero({ paged: { [WHERE_WIDE]: [cooldown] } });
  await assertRejects(() => syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW));
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("a failed transaction copy still throws, as it always did", async () => {
  const db = fakeDb();
  const xero = fakeXero({ unpaged: { [WHERE_90]: new XeroSyncProviderError(500, "/BankTransactions") } });
  await assertRejects(() => syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW));
  assertEquals(db.upserts.length, 0);
});

Deno.test("the first whole read goes back to 1 July, page by page, and starts both cursors", async () => {
  const page1 = Array.from({ length: BANK_TXN_PAGE_SIZE }, (_, i) => txn(i + 1));
  // Page 2 repeats one of page 1's rows (the list moved); it is written once.
  const page2 = [txn(BANK_TXN_PAGE_SIZE), txn(BANK_TXN_PAGE_SIZE + 1)];
  const all = [...page1, txn(BANK_TXN_PAGE_SIZE + 1)].map((t) => bare(Number(String(t.BankTransactionID).slice(-12))));
  const db = fakeDb();
  const xero = fakeXero({
    unpaged: { [WHERE_90]: all.slice(0, 40), [WHERE_WIDE]: all },
    paged: { [WHERE_WIDE]: [page1, page2] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines, {
    ok: true,
    mode: "first_whole",
    pages: 2,
    written: BANK_TXN_PAGE_SIZE + 1,
    modified_since: null,
    healed: 0,
  });
  assertEquals(xero.paged().map((c) => c.params.page), ["1", "2"]);
  assertEquals(xero.paged()[0].headers, {});
  assertEquals(db.rowsOf(LINES).length, BANK_TXN_PAGE_SIZE + 1);
  assertEquals(db.cursorKeys(), [KEY, FULL]);
});

Deno.test("a later whole read covers 90 days and leaves the incremental cursor to the incremental read", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2)] },
    paged: { [WHERE_WIDE]: [[]], [WHERE_90]: [[txn(1), txn(2)]] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, true);
  assertEquals(result.lines.mode, "whole");
  // No second unpaged call: the 90-day list from step 1 is the check.
  assertEquals(xero.calls.filter((c) => !c.params.page).length, 1);
  assertEquals(xero.paged().map((c) => [c.params.where, c.headers["If-Modified-Since"] ?? null]), [
    [WHERE_WIDE, "2026-11-15T01:30:00.000Z"],
    [WHERE_90, null],
  ]);
  // The incremental read stamps its own cursor; the whole read stamps only its own.
  assertEquals(db.cursorKeys(), [KEY, FULL]);
  assertEquals(db.upserts.filter((u) => u.table === "xero_sync_state").map((u) => u.rows.length), [1, 1]);
});

Deno.test("a transaction the pages skipped is fetched by its id before the whole read counts", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2), bare(3)] },
    paged: { [WHERE_90]: [[txn(1), txn(3)]] },
    byId: { [id(2)]: [txn(2)] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(xero.byId().map((c) => c.path), [`/BankTransactions/${id(2)}`]);
  assertEquals(result.lines.ok, true);
  assertEquals(result.lines.ok && result.lines.healed, 1);
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id).sort(), [id(1), id(2), id(3)]);
  assertEquals(db.cursorKeys().includes(FULL), true);
});

Deno.test("more skipped than one run may fetch: the whole-read cursor stays and the result says how many", async () => {
  const n = BANK_TXN_HEAL_LIMIT + 3;
  const listed = Array.from({ length: n }, (_, i) => bare(i + 1));
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: listed },
    paged: { [WHERE_90]: [[]] },
    byId: Object.fromEntries(listed.map((t, i) => [t.BankTransactionID, [txn(i + 1)]])),
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(xero.byId().length, BANK_TXN_HEAL_LIMIT);
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.ok === false && result.lines.missed, 3);
  assertEquals(db.cursorKeys().includes(FULL), false);
});

Deno.test("a transaction that arrives without lines is not counted as read", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2)] },
    paged: { [WHERE_90]: [[txn(1)]] },
    byId: { [id(2)]: [] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, false);
  assertEquals(db.cursorKeys().includes(FULL), false);
});

Deno.test("a page that answers without lines is not a read: each such transaction is fetched by its id", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2), bare(3), bare(4)] },
    // The pages name all four, but only the first came with its lines.
    paged: { [WHERE_90]: [[txn(1), bare(2), bare(3), bare(4)]] },
    // 2 heals. 3 answers without lines again. 4 answers with another transaction.
    byId: { [id(2)]: [txn(2)], [id(3)]: [bare(3)], [id(4)]: [txn(99)] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(xero.byId().map((c) => c.path).sort(), [2, 3, 4].map((n) => `/BankTransactions/${id(n)}`));
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.ok === false && result.lines.missed, 2);
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id).sort(), [id(1), id(2)]);
  // Another transaction's answer is written nowhere.
  assertEquals(db.rowsOf(HEAD).some((r) => r.xero_txn_id === id(99)), false);
  assertEquals(db.cursorKeys().includes(FULL), false);
});

Deno.test("every page answering without lines never counts as a whole read", async () => {
  const db = fakeDb();
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2)], [WHERE_WIDE]: [bare(1), bare(2)] },
    paged: { [WHERE_WIDE]: [[bare(1), bare(2)]] },
    byId: { [id(1)]: [bare(1)], [id(2)]: [bare(2)] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.ok === false && result.lines.missed, 2);
  assertEquals(db.rowsOf(LINES).length, 0);
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("an ordinary run whose lines row is refused holds its cursor and says so", async () => {
  const db = fakeDb({
    cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" }],
    failBulk: LINES,
    failRow: { table: LINES, id: id(7) },
  });
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1)] }, paged: { [WHERE_WIDE]: [[txn(7), txn(8)]] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(result.success, true);
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.mode, "incremental");
  assertEquals(result.lines.ok === false && result.lines.written, 1);
  assertEquals(result.lines.ok === false && result.lines.reason.includes("incremental cursor retained"), true);
  // The row that would write is kept; the cursor does not move, so the next run reads the change again.
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id), [id(8)]);
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("a whole read after a refused incremental row stamps only its own cursor", async () => {
  const db = fakeDb({
    cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }],
    failBulk: LINES,
    failRow: { table: LINES, id: id(7) },
  });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1)] },
    paged: { [WHERE_WIDE]: [[txn(7)]], [WHERE_90]: [[txn(1)]] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  // The whole read stands and stamps its cursor; the refused row is still reported, never hidden.
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.mode, "whole");
  assertEquals(result.lines.ok === false && result.lines.reason.includes("incremental cursor retained"), true);
  assertEquals(db.cursorKeys(), [FULL]);
});

Deno.test("only spend is checked: money received and transfers without lines never hold the whole read", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2, { Type: "RECEIVE" }), bare(3, { Type: "SPEND-TRANSFER" }), bare(4, { Type: "RECEIVE-TRANSFER" })] },
    paged: { [WHERE_90]: [[txn(1), bare(2, { Type: "RECEIVE" }), txn(3, { Type: "SPEND-TRANSFER", LineItems: [] })]] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(xero.byId().length, 0);
  assertEquals(result.lines.ok, true);
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id), [id(1)]);
  assertEquals(db.cursorKeys().includes(FULL), true);
});

Deno.test("spend Xero itself says has no lines is counted apart and does not hold the whole read", async () => {
  const db = fakeDb({ cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }] });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2)] },
    paged: { [WHERE_90]: [[txn(1), txn(2, { LineItems: [] })]] },
    // Asked for by its own id, Xero answers the full record: an empty list is its answer, not a gap.
    byId: { [id(2)]: [txn(2, { LineItems: [] })] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(xero.byId().length, 1);
  assertEquals(result.lines.ok, true);
  assertEquals(result.lines.ok && result.lines.without_lines, 1);
  assertEquals(result.lines.ok && result.lines.healed, 0);
  assertEquals(db.rowsOf(LINES).map((r) => r.xero_txn_id), [id(1)]);
  assertEquals(db.cursorKeys().includes(FULL), true);
});

Deno.test("a transaction fetched by its id whose lines row is refused is not healed", async () => {
  const db = fakeDb({
    cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }],
    failBulk: LINES,
    failRow: { table: LINES, id: id(2) },
  });
  const xero = fakeXero({
    unpaged: { [WHERE_90]: [bare(1), bare(2)] },
    paged: { [WHERE_90]: [[txn(1)]] },
    byId: { [id(2)]: [txn(2)] },
  });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, false);
  assertEquals(result.lines.ok === false && result.lines.missed, 1);
  assertEquals(result.lines.ok === false && result.lines.reason.includes("did not arrive with lines"), true);
  assertEquals(db.cursorKeys().includes(FULL), false);
});

Deno.test("a failure on a later page keeps what was written and moves no whole-read cursor", async () => {
  const page1 = Array.from({ length: BANK_TXN_PAGE_SIZE }, (_, i) => txn(i + 1));
  const db = fakeDb();
  const xero = fakeXero({ paged: { [WHERE_WIDE]: [page1, new XeroSyncProviderError(500, "/BankTransactions")] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, false);
  assertEquals(db.rowsOf(LINES).length, BANK_TXN_PAGE_SIZE);
  assertEquals(db.cursorKeys().length, 0);
});

Deno.test("one transaction row the database refuses is counted and the rest are written", async () => {
  const db = fakeDb({ failBulk: HEAD, failRow: { table: HEAD, id: id(2) } });
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1), bare(2), bare(3)] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: false }, () => NOW);
  assertEquals(result.transactions_synced, 2);
  assertEquals(result.skipped, 1);
  assertEquals(result.first_error, "row refused");
  assertEquals(db.rowsOf(HEAD).map((r) => r.xero_txn_id), [id(1), id(3)]);
});

Deno.test("a lines row the database refuses holds the whole-read cursor", async () => {
  const db = fakeDb({
    cursors: [{ key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" }, { key: FULL, cursor_at: "2026-11-14T01:00:00.000Z" }],
    failBulk: LINES,
    failRow: { table: LINES, id: id(2) },
  });
  const xero = fakeXero({ unpaged: { [WHERE_90]: [bare(1), bare(2)] }, paged: { [WHERE_90]: [[txn(1), txn(2)]] } });
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, { whole: true }, () => NOW);
  assertEquals(result.lines.ok, false);
  assertEquals(db.cursorKeys().includes(FULL), false);
});

Deno.test("the chart of accounts is copied as Xero sent it; an empty answer is refused", async () => {
  const account = { AccountID: "dddddddd-0000-4000-8000-000000000001", Code: "305", Name: "Direct Material Cost", Type: "DIRECTCOSTS", Class: "EXPENSE", Status: "ACTIVE", TaxType: "INPUT" };
  assertEquals(xeroAccountRow(account, ORG, NOW), {
    org_id: ORG,
    xero_account_id: account.AccountID,
    code: "305",
    name: "Direct Material Cost",
    type: "DIRECTCOSTS",
    class: "EXPENSE",
    status: "ACTIVE",
    tax_type: "INPUT",
    synced_at: NOW.toISOString(),
  });
  assertEquals(xeroAccountRow({ Code: "305" }, ORG, NOW), null);
  const written: unknown[] = [];
  const sb = { from: () => ({ upsert: (rows: unknown[]) => (written.push(...rows), Promise.resolve({ error: null })) }) };
  const bank = { AccountID: "dddddddd-0000-4000-8000-000000000002", Name: "Operations", Type: "BANK", Class: "ASSET", Status: "ACTIVE" };
  const got = await syncXeroAccounts(sb, ORG, () => Promise.resolve({ Accounts: [account, bank, account] }), () => NOW);
  assertEquals(got, { ok: true, accounts: 2 });
  assertEquals(written.length, 2);
  await assertRejects(
    () => syncXeroAccounts(sb, ORG, () => Promise.resolve({ Accounts: [] }), () => NOW),
    Error,
    "no accounts",
  );
});
