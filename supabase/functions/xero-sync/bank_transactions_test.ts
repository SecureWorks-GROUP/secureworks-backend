import {
  assertEquals,
  assertRejects,
  // deno-lint-ignore no-import-prefix
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  BANK_TXN_PAGE_SIZE,
  bankTransactionRow,
  bankTransactionsWhere,
  bankTransactionType,
  dayBeforeFinancialYear,
  daysAgo,
  syncBankTransactionLines,
} from "./bank_transactions.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const KEY = `bank_transactions:${ORG}:${TENANT}`;
const FULL = `bank_transactions_full:${ORG}:${TENANT}`;
const NOW = new Date("2026-11-15T02:00:00.000Z");

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
    LineItems: [
      { LineItemID: "l1", Description: "Screws", AccountCode: "310", TaxAmount: 6, LineAmount: 66, Tracking: [] },
      {
        LineItemID: "l2",
        Description: "Fuel",
        AccountCode: "449",
        TaxAmount: 4,
        LineAmount: 44,
        Tracking: [{ Name: "Division", Option: "SW - FENCING" }],
      },
    ],
    ...over,
  };
}

type Upsert = { table: string; rows: Record<string, unknown>[] };

function fakeDb(opts: {
  cursors?: { key: string; cursor_at: string | null }[];
  cursorError?: string;
  failBulk?: boolean;
  failIds?: string[];
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
          if (table === "xero_bank_transactions") {
            if (Array.isArray(payload) && opts.failBulk) {
              return Promise.resolve({ error: { message: "bulk refused" } });
            }
            if (!Array.isArray(payload) && opts.failIds?.includes(String(payload.xero_txn_id))) {
              return Promise.resolve({ error: { message: "row refused" } });
            }
          }
          upserts.push({ table, rows });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const written = () => upserts.filter((u) => u.table === "xero_bank_transactions").flatMap((u) => u.rows);
  const cursorsWritten = () => upserts.filter((u) => u.table === "xero_sync_state").flatMap((u) => u.rows);
  return { sb, upserts, written, cursorsWritten };
}

type Call = { path: string; params: Record<string, string>; headers: Record<string, string> };

function fakeXero(pages: (unknown[] | Error)[], unpaged?: unknown[] | Error) {
  const calls: Call[] = [];
  const get = (path: string, params: Record<string, string>, headers: Record<string, string>) => {
    calls.push({ path, params, headers });
    const answer = params.page ? pages[Number(params.page) - 1] ?? [] : unpaged ?? [];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ BankTransactions: answer });
  };
  return { get, calls };
}

Deno.test("a row keeps every earlier field's meaning and gains the lines", () => {
  const row = bankTransactionRow(txn(1), ORG, NOW)!;
  assertEquals(row.xero_txn_id, id(1));
  assertEquals(row.txn_type, "SPEND");
  assertEquals(row.amount, -110);
  assertEquals(row.sub_total, 100);
  assertEquals(row.total_tax, 10);
  assertEquals(row.txn_date, "2026-10-03");
  assertEquals(row.account_name, "Synthetic Card");
  assertEquals(row.contact_name, "Synthetic Hardware");
  assertEquals(row.contact_id, "cccccccc-0000-4000-8000-000000000001");
  assertEquals(row.is_reconciled, true);
  assertEquals(row.description, "Screws; Fuel");
  assertEquals(row.line_items?.length, 2);
  // Each line says whether its amount includes GST, in Xero's own word.
  assertEquals(row.line_items?.[0].LineAmountTypes, "Inclusive");
  assertEquals(row.line_items?.[1].AccountCode, "449");
});

Deno.test("an answer without lines carries no line_items or description key", () => {
  for (const over of [{ LineItems: undefined }, { LineItems: [] }, { LineItems: "x" }]) {
    const row = bankTransactionRow(txn(1, over), ORG, NOW)!;
    assertEquals("line_items" in row, false);
    assertEquals("description" in row, false);
  }
});

Deno.test("types, signs, missing identity and the date fallbacks", () => {
  assertEquals(bankTransactionType("RECEIVE-PREPAYMENT"), "RECEIVE");
  assertEquals(bankTransactionType("SPEND-TRANSFER"), "TRANSFER");
  assertEquals(bankTransactionType("SPEND-OVERPAYMENT"), "SPEND");
  assertEquals(bankTransactionRow(txn(1, { Type: "RECEIVE" }), ORG, NOW)!.amount, 110);
  assertEquals(bankTransactionRow(txn(1, { Total: 0, SubTotal: 40 }), ORG, NOW)!.amount, -40);
  assertEquals(bankTransactionRow(txn(1, { BankTransactionID: undefined }), ORG, NOW), null);
  assertEquals(bankTransactionRow(txn(1, { DateString: undefined }), ORG, NOW)!.txn_date, "2026-10-03");
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
  assertEquals(bankTransactionsWhere("2026-08-17"), "Date>DateTime(2026,08,17)&&IsReconciled==true");
});

Deno.test("first run reads back to 1 July, page by page, and sets both cursors", async () => {
  const page1 = Array.from({ length: BANK_TXN_PAGE_SIZE }, (_, i) => txn(i + 1));
  const page2 = [txn(BANK_TXN_PAGE_SIZE), txn(BANK_TXN_PAGE_SIZE + 1), txn(BANK_TXN_PAGE_SIZE + 2, {
    LineItems: [],
  })];
  const db = fakeDb();
  const xero = fakeXero([page1, page2]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.mode, "backfill");
  assertEquals(result.pages, 2);
  // The repeated id on page 2 is written once.
  assertEquals(result.transactions_synced, BANK_TXN_PAGE_SIZE + 2);
  assertEquals(result.with_lines, BANK_TXN_PAGE_SIZE + 1);
  assertEquals(result.skipped, 0);
  assertEquals(xero.calls.length, 2);
  assertEquals(xero.calls[0].params, {
    where: "Date>DateTime(2026,06,30)&&IsReconciled==true",
    order: "Date DESC",
    page: "1",
    pageSize: "100",
  });
  assertEquals(xero.calls[0].headers, {});
  // A row with no lines is written apart, with no line_items column to blank the stored one.
  const bare = db.upserts.filter((u) => u.table === "xero_bank_transactions").at(-1)!;
  assertEquals(bare.rows.length, 1);
  assertEquals("line_items" in bare.rows[0], false);
  assertEquals(db.cursorsWritten().map((c) => c.key), [KEY, FULL]);
  assertEquals(db.cursorsWritten()[0].cursor_at, NOW.toISOString());
});

Deno.test("a run inside the day asks only for changes, over the wide window", async () => {
  const db = fakeDb({
    cursors: [
      { key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" },
      { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" },
    ],
  });
  const xero = fakeXero([[txn(7)]]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.mode, "incremental");
  assertEquals(result.modified_since, "2026-11-15T01:30:00.000Z");
  assertEquals(xero.calls[0].headers, { "If-Modified-Since": "2026-11-15T01:30:00.000Z" });
  assertEquals(xero.calls[0].params.where, "Date>DateTime(2026,06,30)&&IsReconciled==true");
  assertEquals(result.transactions_synced, 1);
  // Only the incremental cursor moves.
  assertEquals(db.cursorsWritten().map((c) => c.key), [KEY]);
});

Deno.test("once a day the last 90 days are read whole", async () => {
  const db = fakeDb({
    cursors: [
      { key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" },
      { key: FULL, cursor_at: "2026-11-14T01:59:00.000Z" },
    ],
  });
  const xero = fakeXero([[txn(7)]]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.mode, "full");
  assertEquals(xero.calls[0].headers, {});
  assertEquals(xero.calls[0].params.where, "Date>DateTime(2026,08,17)&&IsReconciled==true");
  assertEquals(db.cursorsWritten().map((c) => c.key), [KEY, FULL]);
});

Deno.test("an incremental run with no usable cursor reads the 90 days whole", async () => {
  const db = fakeDb({ cursors: [{ key: FULL, cursor_at: "2026-11-15T00:00:00.000Z" }] });
  const xero = fakeXero([[]]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.mode, "full");
  assertEquals(xero.calls[0].headers, {});
  assertEquals(db.cursorsWritten().map((c) => c.key), [KEY, FULL]);
});

Deno.test("304 to an incremental read means nothing changed, and the cursor moves", async () => {
  const db = fakeDb({
    cursors: [
      { key: KEY, cursor_at: "2026-11-15T01:45:00.000Z" },
      { key: FULL, cursor_at: "2026-11-14T22:45:00.000Z" },
    ],
  });
  const notModified = Object.assign(new Error("Xero /BankTransactions returned HTTP 304"), { status: 304 });
  const xero = fakeXero([notModified]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.transactions_synced, 0);
  assertEquals(db.written().length, 0);
  assertEquals(db.cursorsWritten().map((c) => c.key), [KEY]);
});

Deno.test("a refused paged read falls back to the old unpaged read and moves no cursor", async () => {
  const db = fakeDb();
  const xero = fakeXero([new Error("Xero /BankTransactions returned HTTP 400")], [
    txn(1, { LineItems: undefined }),
    txn(2, { LineItems: undefined }),
  ]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.mode, "unpaged_fallback");
  assertEquals(result.fallback_reason, "Xero /BankTransactions returned HTTP 400");
  assertEquals(result.transactions_synced, 2);
  assertEquals(result.with_lines, 0);
  assertEquals(xero.calls[1].params, {
    where: "Date>DateTime(2026,08,17)&&IsReconciled==true",
    order: "Date DESC",
  });
  assertEquals(db.written().every((r) => !("line_items" in r)), true);
  assertEquals(db.cursorsWritten().length, 0);
});

Deno.test("a rate limit stops the run and is not swallowed by the fallback", async () => {
  const db = fakeDb();
  const cooldown = Object.create(XeroCooldownError.prototype) as Error;
  const xero = fakeXero([cooldown]);
  await assertRejects(() => syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW));
  assertEquals(xero.calls.length, 1);
  assertEquals(db.cursorsWritten().length, 0);
});

Deno.test("a failure on a later page keeps what was written and moves no cursor", async () => {
  const page1 = Array.from({ length: BANK_TXN_PAGE_SIZE }, (_, i) => txn(i + 1));
  const db = fakeDb();
  const xero = fakeXero([page1, new Error("Xero /BankTransactions returned HTTP 500")]);
  await assertRejects(
    () => syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW),
    Error,
    "HTTP 500",
  );
  assertEquals(db.written().length, BANK_TXN_PAGE_SIZE);
  assertEquals(db.cursorsWritten().length, 0);
});

Deno.test("one row the database refuses is counted and the rest are written", async () => {
  const db = fakeDb({ failBulk: true, failIds: [id(2)] });
  const xero = fakeXero([[txn(1), txn(2), txn(3)]]);
  const result = await syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW);
  assertEquals(result.transactions_synced, 2);
  assertEquals(result.skipped, 1);
  assertEquals(result.first_error, "row refused");
  assertEquals(db.written().map((r) => r.xero_txn_id), [id(1), id(3)]);
});

Deno.test("an unreadable cursor refuses the run before any Xero call", async () => {
  const db = fakeDb({ cursorError: "permission denied" });
  const xero = fakeXero([[txn(1)]]);
  await assertRejects(
    () => syncBankTransactionLines(db.sb, ORG, TENANT, xero.get, () => NOW),
    Error,
    "cursor read failed",
  );
  assertEquals(xero.calls.length, 0);
});
