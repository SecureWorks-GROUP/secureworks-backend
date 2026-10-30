import {
  assertEquals,
  assertRejects,
  assertThrows,
  // deno-lint-ignore no-import-prefix
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseSupplierCreditNote,
  SUPPLIER_CREDIT_NOTES_FLAG,
  syncSupplierCreditNotes,
  xeroDay,
} from "./supplier_credit_notes.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const KEY = `supplier_credit_notes:${ORG}:${TENANT}`;
const FULL = `supplier_credit_notes_full:${ORG}:${TENANT}`;
const NOW = new Date("2026-10-30T02:00:00.000Z");
const CN1 = "cccccccc-0000-4000-8000-000000000001";
const CN2 = "cccccccc-0000-4000-8000-000000000002";
const BILL = "bbbbbbbb-0000-4000-8000-000000000001";

// Shaped like Xero's /CreditNotes list entries; synthetic values only.
const NOTE = {
  CreditNoteID: CN1,
  CreditNoteNumber: "CN-0001",
  Type: "ACCPAYCREDIT",
  Contact: { ContactID: "dddddddd-0000-4000-8000-000000000001", Name: "Synthetic Supplies" },
  Reference: "Returned posts",
  DateString: "2026-10-01T00:00:00",
  Date: "/Date(1759276800000+0000)/",
  Status: "AUTHORISED",
  LineAmountTypes: "Exclusive",
  CurrencyCode: "AUD",
  SubTotal: 100,
  TotalTax: 10,
  Total: 110,
  RemainingCredit: 55,
  UpdatedDateUTC: "/Date(1759363200000+0000)/",
  Allocations: [{
    AllocationID: "eeeeeeee-0000-4000-8000-000000000001",
    Amount: 55,
    DateString: "2026-10-02T00:00:00",
    Invoice: { InvoiceID: BILL, InvoiceNumber: "BILL-1" },
  }],
};

Deno.test("credit note parse: Xero's fields, its allocations, nothing invented", () => {
  const { note, allocations } = parseSupplierCreditNote(structuredClone(NOTE));
  assertEquals(
    [note.xero_credit_note_id, note.credit_note_type, note.credit_note_number, note.status],
    [CN1, "ACCPAYCREDIT", "CN-0001", "AUTHORISED"],
  );
  assertEquals([note.sub_total, note.total_tax, note.total, note.remaining_credit], [100, 10, 110, 55]);
  assertEquals([note.credit_note_date, note.contact_name, note.fully_paid_on], ["2026-10-01", "Synthetic Supplies", null]);
  assertEquals(note.xero_updated_at, "2025-10-02T00:00:00.000Z");
  assertEquals(allocations, [{
    allocation_id: "eeeeeeee-0000-4000-8000-000000000001",
    xero_invoice_id: BILL,
    invoice_number: "BILL-1",
    amount: 55,
    allocation_date: "2026-10-02",
    is_deleted: false,
    raw_json: NOTE.Allocations[0],
  }]);
});

Deno.test("credit note parse: a missing amount or status stays null, never 0", () => {
  const raw: Record<string, unknown> = structuredClone(NOTE);
  delete raw.Total;
  delete raw.RemainingCredit;
  delete raw.Status;
  raw.SubTotal = "100";
  raw.Allocations = [{ Invoice: { InvoiceID: BILL }, IsDeleted: true }];
  const { note, allocations } = parseSupplierCreditNote(raw);
  assertEquals([note.total, note.remaining_credit, note.status, note.sub_total], [null, null, null, null]);
  assertEquals(allocations?.map((a) => [a.amount, a.is_deleted, a.allocation_date]), [[null, true, null]]);
});

Deno.test("credit note parse: no Allocations list is unknown (null), an empty list is none", () => {
  const raw: Record<string, unknown> = structuredClone(NOTE);
  delete raw.Allocations;
  assertEquals(parseSupplierCreditNote(raw).allocations, null);
  raw.Allocations = [];
  assertEquals(parseSupplierCreditNote(raw).allocations, []);
});

Deno.test("credit note parse: a bad identity, another type or an unreadable list refuses", () => {
  assertThrows(() => parseSupplierCreditNote({ ...NOTE, CreditNoteID: "not-an-id" }), Error, "identity");
  assertThrows(() => parseSupplierCreditNote({ ...NOTE, Type: "ACCRECCREDIT" }), Error, "not ACCPAYCREDIT");
  assertThrows(() => parseSupplierCreditNote({ ...NOTE, Allocations: "x" }), Error, "unreadable");
  assertThrows(() => parseSupplierCreditNote({ ...NOTE, Allocations: [1] }), Error, "unreadable allocation");
});

Deno.test("credit note parse: an allocation's bill id must be a Xero id", () => {
  const { allocations } = parseSupplierCreditNote({ ...NOTE, Allocations: [{ Amount: 5, Invoice: { InvoiceID: "nope" } }] });
  assertEquals(allocations?.[0].xero_invoice_id, null);
});

Deno.test("xeroDay: DateString's own day, /Date()/ as UTC, anything else null", () => {
  assertEquals(xeroDay("2026-10-01T00:00:00"), "2026-10-01");
  assertEquals(xeroDay("2026-10-01"), "2026-10-01");
  assertEquals(xeroDay("/Date(1759276800000+0000)/"), "2025-10-01");
  assertEquals([xeroDay("01/10/2026"), xeroDay(""), xeroDay(5), xeroDay("2026-13-45")], [null, null, null, null]);
});

type Row = Record<string, unknown>;
type Call = { path: string; params: Record<string, string>; headers: Record<string, string> };

function fake(opts: { flag?: boolean | "error"; state?: Row[]; rpc?: (args: Row) => { data: unknown; error: unknown } } = {}) {
  const state: Row[] = structuredClone(opts.state ?? []);
  const rpcs: Row[] = [];
  const client = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const rows = (): Row[] => {
        if (table === "feature_flags") {
          if (opts.flag === "error") return [];
          return opts.flag === undefined ? [] : [{ flag_name: SUPPLIER_CREDIT_NOTES_FLAG, enabled: opts.flag }];
        }
        return state.filter((r) => filters.every((f) => f(r)));
      };
      const result = () =>
        table === "feature_flags" && opts.flag === "error"
          ? { data: null, error: { message: "flag read failed" } }
          : { data: rows(), error: null };
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
        limit: () => Promise.resolve(result()),
        then: (res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
        upsert: (input: Row[]) => {
          for (const row of input) {
            const at = state.findIndex((r) => r.key === row.key);
            if (at >= 0) state[at] = { ...state[at], ...row };
            else state.push({ ...row });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return b;
    },
    rpc(fn: string, args: Row) {
      rpcs.push({ fn, ...args });
      return Promise.resolve(opts.rpc ? opts.rpc(args) : { data: "written", error: null });
    },
  };
  return { client, state, rpcs };
}

function provider(pages: unknown[]) {
  const calls: Call[] = [];
  const get = (path: string, params: Record<string, string>, headers: Record<string, string>) => {
    calls.push({ path, params, headers });
    return Promise.resolve(pages[calls.length - 1] ?? { CreditNotes: [] });
  };
  return { calls, get };
}

Deno.test("credit note sync: off, missing or unreadable flag reads nothing from Xero", async () => {
  for (const flag of [false, undefined, "error"] as const) {
    const f = fake({ flag });
    const p = provider([{ CreditNotes: [NOTE] }]);
    assertEquals(await syncSupplierCreditNotes(f.client, ORG, TENANT, p.get, () => NOW), { ran: false, reason: "flag_off" });
    assertEquals([p.calls.length, f.rpcs.length, f.state.length], [0, 0, 0]);
  }
});

Deno.test("credit note sync: first run reads everything, asks for ACCPAYCREDIT only, writes each note once", async () => {
  const f = fake({ flag: true });
  const p = provider([{ CreditNotes: [NOTE, { ...NOTE, CreditNoteID: CN2, Allocations: undefined }] }]);
  const r = await syncSupplierCreditNotes(f.client, ORG, TENANT, p.get, () => NOW);
  assertEquals(p.calls, [{
    path: "/CreditNotes",
    params: { where: 'Type=="ACCPAYCREDIT"', page: "1", pageSize: "100", order: "CreditNoteID ASC" },
    headers: {},
  }]);
  assertEquals(f.rpcs.map((c) => [c.fn, c.p_org_id, (c.p_note as Row).xero_credit_note_id, c.p_allocations === null]), [
    ["xero_supplier_credit_note_copy", ORG, CN1, false],
    ["xero_supplier_credit_note_copy", ORG, CN2, true],
  ]);
  assertEquals(r.ran && [r.notes, r.allocations, r.written, r.stale, r.full_reread], [2, 1, 2, 0, true]);
  assertEquals(f.state.map((s) => [s.key, s.cursor_at]).sort(), [[FULL, NOW.toISOString()], [KEY, NOW.toISOString()]].sort());
});

Deno.test("credit note sync: a recent full read goes incremental with the overlap", async () => {
  const lastFull = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const f = fake({ flag: true, state: [{ key: KEY, cursor_at: lastFull }, { key: FULL, cursor_at: lastFull }] });
  const p = provider([{ CreditNotes: [] }]);
  const r = await syncSupplierCreditNotes(f.client, ORG, TENANT, p.get, () => NOW);
  assertEquals(p.calls[0].headers, { "If-Modified-Since": new Date(Date.parse(lastFull) - 15 * 60 * 1000).toISOString() });
  assertEquals(r.ran && r.full_reread, false);
  assertEquals(f.state.find((s) => s.key === FULL)?.cursor_at, lastFull);
});

Deno.test("credit note sync: a full page reads the next; a short page ends it", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ ...NOTE, CreditNoteID: `cccccccc-0000-4000-8000-${String(i + 10).padStart(12, "0")}` }));
  const f = fake({ flag: true });
  const p = provider([{ CreditNotes: full }, { CreditNotes: [NOTE] }]);
  const r = await syncSupplierCreditNotes(f.client, ORG, TENANT, p.get, () => NOW);
  assertEquals(p.calls.map((c) => c.params.page), ["1", "2"]);
  assertEquals(r.ran && [r.notes, r.pages], [101, 2]);
});

Deno.test("credit note sync: an unreadable answer, a duplicate or a bad note writes nothing and keeps the cursor", async () => {
  for (const pages of [
    [{ Nope: [] }],
    [{ CreditNotes: [NOTE, NOTE] }],
    [{ CreditNotes: [NOTE, { ...NOTE, CreditNoteID: CN2, Type: "ACCREC" }] }],
  ]) {
    const f = fake({ flag: true });
    await assertRejects(() => syncSupplierCreditNotes(f.client, ORG, TENANT, provider(pages).get, () => NOW));
    assertEquals([f.rpcs.length, f.state.length], [0, 0]);
  }
});

Deno.test("credit note sync: a refused or odd write stops the run before the cursor moves", async () => {
  for (const answer of [{ data: null, error: { message: "refused" } }, { data: "maybe", error: null }]) {
    const f = fake({ flag: true, rpc: () => answer });
    await assertRejects(() => syncSupplierCreditNotes(f.client, ORG, TENANT, provider([{ CreditNotes: [NOTE] }]).get, () => NOW));
    assertEquals(f.state.length, 0);
  }
});

Deno.test("credit note sync: a stale answer is counted, not an error", async () => {
  const f = fake({ flag: true, rpc: () => ({ data: "stale", error: null }) });
  const r = await syncSupplierCreditNotes(f.client, ORG, TENANT, provider([{ CreditNotes: [NOTE] }]).get, () => NOW);
  assertEquals(r.ran && [r.written, r.stale], [0, 1]);
});
