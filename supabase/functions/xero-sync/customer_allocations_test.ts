// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CUSTOMER_ALLOCATION_REREAD_LIMIT,
  syncCustomerAllocations,
} from "./customer_allocations.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const TENANT = "25866cf3-c1e2-4cb2-95fe-1ed081e44705";
const NOW = new Date("2026-11-03T09:00:00.000Z");
const KEY = `customer_allocations:${ORG}:${TENANT}`;
const FULL_KEY = `customer_allocations_full:${ORG}:${TENANT}`;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

// Shapes as Xero returned them on 3 Nov 2026 (trimmed): CN-1365 allocated to INV-1075
// on 27 Aug, the SW1346 case; overpayment 45f2b184 on INV-1619 (SWP-26320).
const INV_1075 = "9c956dfe-e034-4071-aa90-190d3e7064d0";
const CN_1365 = {
  CreditNoteID: "3e320148-304e-43c0-ac6c-b76b8f52bd9f",
  CreditNoteNumber: "CN-1365",
  Type: "ACCRECCREDIT",
  Status: "PAID",
  RemainingCredit: 0,
  UpdatedDateUTC: "/Date(1787805888083+0000)/",
  Allocations: [{
    AllocationID: "a0000000-0000-4000-8000-000000001365",
    Amount: 559.9,
    Date: "/Date(1787788800000+0000)/",
    Invoice: { InvoiceID: INV_1075, InvoiceNumber: "INV-1075", CreditNotes: [] },
  }],
};
const INV_1619 = "e92a5ada-ca9e-4bc0-9d4a-925367fdd6a0";
const OVERPAYMENT = {
  OverpaymentID: "45f2b184-5b9f-413d-8489-b12777a8cd66",
  Type: "RECEIVE-OVERPAYMENT",
  Status: "PAID",
  UpdatedDateUTC: "/Date(1790734229647+0000)/",
  Allocations: [{
    Amount: 290.84,
    Date: "/Date(1790726400000+0000)/",
    Invoice: { InvoiceID: INV_1619, InvoiceNumber: "INV-1619" },
  }],
};
// Xero's answer for INV-1075 by id (3 Nov 08:48Z, trimmed).
const INV_1075_LIVE = {
  InvoiceID: INV_1075,
  InvoiceNumber: "INV-1075",
  Type: "ACCREC",
  Status: "PAID",
  AmountDue: 0,
  AmountPaid: 7366.28,
  AmountCredited: 559.9,
  CreditNotes: [{
    CreditNoteID: CN_1365.CreditNoteID,
    CreditNoteNumber: "CN-1365",
    AppliedAmount: 559.9,
  }],
  UpdatedDateUTC: "/Date(1787805888057+0000)/",
};

interface Options {
  cursors?: Array<{ key: string; cursor_at: string | null }>;
  pages?: Record<string, unknown[][]>; // path -> pages of records
  copy?: Array<Record<string, unknown>>;
  read?: Record<string, () => Promise<unknown>>;
}

function fixture(options: Options = {}) {
  const gets: Array<{ path: string; params: Record<string, string>; headers: Record<string, string> }> = [];
  const reads: string[] = [];
  const updates: Array<{ patch: Record<string, unknown>; filters: unknown[] }> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const copyQueries: unknown[][] = [];
  const client = {
    from(table: string) {
      if (table === "xero_sync_state") {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: options.cursors ?? [], error: null }),
          }),
          upsert(rows: Record<string, unknown>[]) {
            upserts.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      assertEquals(table, "xero_invoices");
      return {
        select(_cols: string) {
          const filters: unknown[] = [];
          const q: any = {
            eq(f: string, v: unknown) {
              filters.push([f, v]);
              return q;
            },
            in(f: string, ids: string[]) {
              filters.push([f, ids]);
              copyQueries.push(filters);
              return Promise.resolve({
                data: (options.copy ?? []).filter((r) =>
                  ids.includes(String(r.xero_invoice_id))
                ),
                error: null,
              });
            },
          };
          return q;
        },
        update(patch: Record<string, unknown>) {
          const record = { patch, filters: [] as unknown[] };
          const q: any = {
            eq(f: string, v: unknown) {
              record.filters.push([f, v]);
              return q;
            },
            then(resolve: (v: { error: null }) => void) {
              updates.push(record);
              resolve({ error: null });
            },
          };
          return q;
        },
      };
    },
  };
  const get = (path: string, params: Record<string, string>, headers: Record<string, string>) => {
    gets.push({ path, params, headers });
    const collection = path.slice(1);
    const page = Number(params.page);
    const rows = options.pages?.[path]?.[page - 1] ?? [];
    return Promise.resolve({ [collection]: rows });
  };
  const readInvoice = (id: string) => {
    reads.push(id);
    const r = options.read?.[id];
    if (r) return r();
    return Promise.resolve({
      Invoices: [{ InvoiceID: id, Type: "ACCREC", Status: "PAID", AmountDue: 0, AmountPaid: 10 }],
    });
  };
  const run = (force = false) =>
    syncCustomerAllocations(client, ORG, TENANT, get, readInvoice, () => NOW, undefined, force);
  return { run, gets, reads, updates, upserts, copyQueries };
}

const copyRow = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  xero_invoice_id: id,
  invoice_number: number,
  reconcile_attempted_at: null,
  credit_notes: [],
  overpayments: [],
  prepayments: [],
  ...extra,
});

Deno.test("a credit note Xero allocated that our copy's record does not list re-reads that invoice by id (SW1346, INV-1075)", async () => {
  const f = fixture({
    pages: { "/CreditNotes": [[CN_1365]] },
    copy: [copyRow(INV_1075, "INV-1075")],
    read: { [INV_1075]: () => Promise.resolve({ Invoices: [INV_1075_LIVE] }) },
  });
  const result: any = await f.run();
  assertEquals(f.reads, [INV_1075]);
  assertEquals(result.reread, 1);
  assertEquals(result.invoices[0].differences, ["credit_note CN-1365: Xero 559.90, copy 0.00"]);
  // Our copy now holds Xero's record, credit note included, and the cursor moves.
  assertEquals(f.updates[0].patch.raw_json, INV_1075_LIVE);
  assertEquals(f.updates[0].filters, [["xero_invoice_id", INV_1075], ["org_id", ORG]]);
  assertEquals(result.cursor_moved, true);
  assertEquals(f.upserts.map((u) => u.key), [KEY, FULL_KEY]);
  // Only this org's sales invoices are compared.
  assertEquals(f.copyQueries[0].slice(0, 2), [["org_id", ORG], ["invoice_type", "ACCREC"]]);
});

Deno.test("allocations our copy already lists to the cent cost no invoice read", async () => {
  const f = fixture({
    pages: { "/CreditNotes": [[CN_1365]], "/Overpayments": [[OVERPAYMENT]] },
    copy: [
      copyRow(INV_1075, "INV-1075", {
        credit_notes: [{ CreditNoteID: CN_1365.CreditNoteID.toUpperCase(), AppliedAmount: 559.9 }],
      }),
      copyRow(INV_1619, "INV-1619", {
        overpayments: [{ OverpaymentID: OVERPAYMENT.OverpaymentID, AppliedAmount: 290.84 }],
      }),
    ],
  });
  const result: any = await f.run();
  assertEquals(f.reads, []);
  assertEquals(result.differing, 0);
  assertEquals(result.allocations, 2);
  assertEquals(result.sources, { credit_note: 1, overpayment: 1, prepayment: 0 });
});

Deno.test("an overpayment, a prepayment, a changed amount and a deleted allocation each re-read their invoice", async () => {
  const PRE_INV = "70000000-0000-4000-8000-000000000007";
  const DEL_INV = "80000000-0000-4000-8000-000000000008";
  const prepayment = {
    PrepaymentID: "60000000-0000-4000-8000-000000000006",
    Type: "RECEIVE-PREPAYMENT",
    UpdatedDateUTC: "/Date(1793000000000+0000)/",
    Allocations: [{ Amount: 500, Invoice: { InvoiceID: PRE_INV, InvoiceNumber: "INV-2000" } }],
  };
  const removed = {
    ...CN_1365,
    CreditNoteID: "90000000-0000-4000-8000-000000000009",
    CreditNoteNumber: "CN-9999",
    Allocations: [{ Amount: 100, IsDeleted: true, Invoice: { InvoiceID: DEL_INV } }],
  };
  const f = fixture({
    pages: {
      "/CreditNotes": [[removed]],
      "/Overpayments": [[OVERPAYMENT]],
      "/Prepayments": [[prepayment]],
    },
    copy: [
      // Overpayment listed with a different amount than Xero allocated.
      copyRow(INV_1619, "INV-1619", {
        overpayments: [{ OverpaymentID: OVERPAYMENT.OverpaymentID, AppliedAmount: 100 }],
      }),
      copyRow(PRE_INV, "INV-2000"),
      // The copy still lists a credit Xero has since taken off.
      copyRow(DEL_INV, "INV-3000", {
        credit_notes: [{ CreditNoteID: removed.CreditNoteID, AppliedAmount: 100 }],
      }),
    ],
  });
  const result: any = await f.run();
  assertEquals(new Set(f.reads), new Set([INV_1619, PRE_INV, DEL_INV]));
  assertEquals(result.reread, 3);
  const why = Object.fromEntries(result.invoices.map((i: any) => [i.invoice_number, i.differences[0]]));
  assertEquals(why["INV-3000"], "credit_note CN-9999: Xero 0.00, copy 100.00");
  assertEquals(why["INV-1619"], `overpayment ${OVERPAYMENT.OverpaymentID}: Xero 290.84, copy 100.00`);
});

Deno.test("an invoice re-read after its source last changed waits a day; one our copy never saw is only counted", async () => {
  const copied = (attempted: string | null) =>
    fixture({
      pages: { "/CreditNotes": [[CN_1365]] },
      // CN-1365 last changed 27 Aug 04:44:48Z.
      copy: [copyRow(INV_1075, "INV-1075", { reconcile_attempted_at: attempted })],
    });
  const waiting = copied(ago(2 * HOUR));
  const held: any = await waiting.run();
  assertEquals(waiting.reads, []);
  assertEquals([held.differing, held.waiting], [1, 1]);
  // A day later it is read again.
  const later = copied(ago(25 * HOUR));
  await later.run();
  assertEquals(later.reads, [INV_1075]);
  // Read before the source changed: read now.
  const before = copied("2026-08-27T04:00:00.000Z");
  await before.run();
  assertEquals(before.reads, [INV_1075]);

  const unseen = fixture({ pages: { "/CreditNotes": [[CN_1365]] }, copy: [] });
  const r: any = await unseen.run();
  assertEquals(unseen.reads, []);
  assertEquals(r.not_in_copy, 1);
  assertEquals(unseen.updates, []);
});

Deno.test("the check runs at most once an hour, reads everything once a day, and asks only for changes in between", async () => {
  const fresh = [
    { key: KEY, cursor_at: ago(30 * 60 * 1000) },
    { key: FULL_KEY, cursor_at: ago(5 * HOUR) },
  ];
  const gated = fixture({ cursors: fresh });
  const skipped: any = await gated.run();
  assertEquals(skipped.ran, false);
  assertEquals(gated.gets, []);
  // On demand it runs, incrementally, from 15 minutes before the last check.
  const forced = fixture({ cursors: fresh });
  await forced.run(true);
  assertEquals(forced.gets.map((g) => g.path), ["/CreditNotes", "/Overpayments", "/Prepayments"]);
  assertEquals(forced.gets[0].headers, { "If-Modified-Since": ago(45 * 60 * 1000) });
  assertEquals(forced.gets[1].params.where, 'Type=="RECEIVE-OVERPAYMENT"');
  assertEquals(forced.upserts.map((u) => u.key), [KEY]);
  // A day after the last full read, everything is read with no window.
  const full = fixture({
    cursors: [{ key: KEY, cursor_at: ago(30 * 60 * 1000) }, { key: FULL_KEY, cursor_at: ago(25 * HOUR) }],
  });
  const all: any = await full.run();
  assertEquals(all.full_reread, true);
  assertEquals(full.gets.every((g) => Object.keys(g.headers).length === 0), true);
});

Deno.test("an untrusted provider answer refuses the whole check before any read or cursor move", async () => {
  for (
    const bad of [
      { ...CN_1365, Type: "ACCPAYCREDIT" },
      { ...CN_1365, CreditNoteID: "not-an-id" },
      { ...CN_1365, Allocations: {} },
      { ...CN_1365, Allocations: [null] },
    ]
  ) {
    const f = fixture({ pages: { "/CreditNotes": [[bad]] }, copy: [copyRow(INV_1075, "INV-1075")] });
    await assertRejects(() => f.run());
    assertEquals([f.reads, f.upserts], [[], []]);
  }
  // A full page continues to the next; the same identity twice means the list moved.
  const page = Array.from({ length: 100 }, (_, i) => ({
    ...CN_1365,
    CreditNoteID: `3e320148-304e-43c0-ac6c-${String(i).padStart(12, "0")}`,
    Allocations: [],
  }));
  const twice = fixture({ pages: { "/CreditNotes": [page, [page[0]]] } });
  await assertRejects(() => twice.run(), Error, "duplicate identity");
  assertEquals(twice.gets.map((g) => g.params.page), ["1", "2"]);
  assertEquals(twice.upserts, []);
});

Deno.test("more differing invoices than one run reads keeps the cursor, and a cooldown stops the check", async () => {
  const many = Array.from({ length: CUSTOMER_ALLOCATION_REREAD_LIMIT + 5 }, (_, i) => {
    const id = `5${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
    return { id, note: { ...CN_1365, CreditNoteID: `4${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`,
      Allocations: [{ Amount: 1, Invoice: { InvoiceID: id } }] } };
  });
  const capped = fixture({
    pages: { "/CreditNotes": [many.map((m) => m.note)] },
    copy: many.map((m) => copyRow(m.id, m.id)),
  });
  const r: any = await capped.run();
  assertEquals([r.reread, r.deferred, r.cursor_moved], [CUSTOMER_ALLOCATION_REREAD_LIMIT, 5, false]);
  assertEquals(capped.upserts, []);

  // One unreadable invoice is recorded and skipped; the rest still run.
  const isolated = fixture({
    pages: { "/CreditNotes": [[CN_1365]], "/Overpayments": [[OVERPAYMENT]] },
    copy: [copyRow(INV_1075, "INV-1075"), copyRow(INV_1619, "INV-1619")],
    read: { [INV_1619]: () => Promise.reject(new XeroSyncProviderError(404, `/Invoices/${INV_1619}`)) },
  });
  const one: any = await isolated.run();
  assertEquals([one.reread, one.failed, one.cursor_moved], [1, 1, true]);
  const stamp = isolated.updates.find((u) => (u.filters[0] as unknown[])[1] === INV_1619);
  assertEquals(stamp?.patch.reconcile_attempted_at, NOW.toISOString());
  assertEquals(Object.hasOwn(stamp!.patch, "raw_json"), false);

  const cooled = fixture({
    pages: { "/CreditNotes": [[CN_1365]] },
    copy: [copyRow(INV_1075, "INV-1075")],
    read: { [INV_1075]: () => Promise.reject(new XeroCooldownError("fixture-only cooldown", 429, "xero_cooldown")) },
  });
  await assertRejects(() => cooled.run(), XeroCooldownError);
  assertEquals(cooled.upserts, []);
});
