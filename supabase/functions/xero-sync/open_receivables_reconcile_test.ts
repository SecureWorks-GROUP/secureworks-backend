import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyOpenReceivableReconcile,
  classifyProviderVsCache,
  providerMoneyPatch,
} from "./open_receivables_reconcile.ts";

// Production SELECT 2026-09-13 02:36:28 UTC: same Xero IDs as provider.
// 12 cached DELETED/0, INV-1442 cached DRAFT/3718. Not never-inserted rows.
const TOMBSTONES = [
  { n: "INV-0034", id: "925f4829-ae21-4df2-b2a6-4f1e5e63edff", status: "DELETED", due: 0, open: 734.48 },
  { n: "INV-0080", id: "0b6a80df-e7a1-47f2-9b9b-aa49cf43b604", status: "DELETED", due: 0, open: 231 },
  { n: "INV-0177", id: "665b7430-6ad3-4833-b719-b295c4a061dc", status: "DELETED", due: 0, open: 352 },
  { n: "INV-0352", id: "31c048ff-8eab-4004-b0e5-9448f4dc5979", status: "DELETED", due: 0, open: 1006.5 },
  { n: "INV-0615", id: "36e4ab6a-07e6-4ff8-b659-d6db4829c0d6", status: "DELETED", due: 0, open: 1736.54 },
  { n: "INV-0704", id: "50e6d47e-7ca7-4526-9c8a-a91684652091", status: "DELETED", due: 0, open: 561 },
  { n: "INV-0876", id: "0b74ba18-0cec-4f82-a568-97bbb537b6a6", status: "DELETED", due: 0, open: 165 },
  { n: "INV-0938", id: "2dac51f3-d247-4c6f-bd40-ec3b7ce535f9", status: "DELETED", due: 0, open: 698.5 },
  { n: "INV-1200", id: "168bb279-a26f-4b6e-93c7-02ef595a26b2", status: "DELETED", due: 0, open: 176 },
  { n: "INV-1213", id: "ed78ba8c-a988-47f4-9a21-7acda2d23580", status: "DELETED", due: 0, open: 275 },
  { n: "INV-1368", id: "73619fbc-6f74-4e00-b69c-bcda1e9190d3", status: "DELETED", due: 0, open: 1001 },
  { n: "INV-1407", id: "789d0c6d-11ae-466f-98be-6769b21bd038", status: "DELETED", due: 0, open: 275 },
  { n: "INV-1442", id: "be82596f-3d03-4ffb-a812-3daa12768c61", status: "DRAFT", due: 3718, open: 3718 },
];

function providerOpen() {
  return TOMBSTONES.map((t) => ({
    InvoiceID: t.id,
    InvoiceNumber: t.n,
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: t.open,
    UpdatedDateUTC: t.n === "INV-1442" ? "2026-09-03T01:44:37Z" : "2025-11-04T02:10:23Z",
  }));
}

function cacheRows() {
  const open = Array.from({ length: 160 }, (_, i) => ({
    xero_invoice_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    invoice_number: `INV-C${String(i).padStart(4, "0")}`,
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    amount_due: 50,
    debt_classification: "genuine_debt",
    debt_brief: "keep-me",
  }));
  const stale = TOMBSTONES.map((t) => ({
    xero_invoice_id: t.id,
    invoice_number: t.n,
    invoice_type: "ACCREC",
    status: t.status,
    amount_due: t.due,
    debt_classification: "blocked_by_us",
    debt_brief: "manual-note",
  }));
  return { open, stale, all: [...open, ...stale] };
}

Deno.test("door filter hides existing DELETED/DRAFT rows with the same Xero IDs", () => {
  const { all } = cacheRows();
  const diff = classifyProviderVsCache(providerOpen(), all);
  assertEquals(diff.stale_status.length, 13);
  assertEquals(diff.absent.length, 0);
  assertEquals(diff.stale_status.filter((s) => s.cache.status === "DELETED").length, 12);
  assertEquals(diff.stale_status.filter((s) => s.cache.status === "DRAFT").length, 1);
  assertEquals(diff.provider_cutoff, "2026-09-03T01:44:37.000Z");
  assertEquals(diff.provider_due, 10930.02);
});

Deno.test("write=false does not mutate", async () => {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  const { stale } = cacheRows();
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: stale, error: null }),
          }),
        }),
        update: async (row: unknown) => {
          updates.push(row);
          return { error: null };
        },
        insert: async (row: unknown) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const out = await applyOpenReceivableReconcile(
    client,
    "00000000-0000-0000-0000-000000000001",
    providerOpen(),
    { write: false },
  );
  assertEquals(out.updated, 0);
  assertEquals(out.inserted, 0);
  assertEquals(updates.length, 0);
  assertEquals(inserts.length, 0);
});

Deno.test("write=true UPDATES existing tombstones and does not insert or touch classifications", async () => {
  const store = cacheRows().stale.map((r) => ({ ...r }));
  const updates: Array<Record<string, unknown>> = [];
  const inserts: unknown[] = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: store, error: null }),
          }),
        }),
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          return {
            eq: () => ({
              eq: (_col: string, id: string) => {
                const hit = store.find((r) => r.xero_invoice_id === id);
                if (hit) Object.assign(hit, row);
                return Promise.resolve({ error: null });
              },
            }),
          };
        },
        insert: async (row: unknown) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const out = await applyOpenReceivableReconcile(
    client,
    "00000000-0000-0000-0000-000000000001",
    providerOpen(),
    { write: true },
  );
  assertEquals(out.updated, 13);
  assertEquals(out.inserted, 0);
  assertEquals(inserts.length, 0);
  assertEquals(updates.length, 13);
  for (const u of updates) {
    assertEquals("debt_classification" in u, false);
    assertEquals("debt_brief" in u, false);
    assertEquals(u.status, "AUTHORISED");
  }
  for (const row of store) {
    assertEquals(row.debt_classification, "blocked_by_us");
    assertEquals(row.debt_brief, "manual-note");
    assertEquals(row.status, "AUTHORISED");
  }
  assertEquals(store.find((r) => r.invoice_number === "INV-1442")?.amount_due, 3718);
  assertEquals(store.find((r) => r.invoice_number === "INV-0034")?.amount_due, 734.48);
});

Deno.test("money patch is status and balances only", () => {
  const p = providerMoneyPatch({
    InvoiceID: "x",
    InvoiceNumber: "INV-1442",
    Status: "AUTHORISED",
    AmountDue: 3718,
    AmountPaid: 0,
  });
  assertEquals(Object.keys(p).sort(), ["amount_due", "amount_paid", "status", "synced_at"]);
});

Deno.test("a genuinely absent provider ID still inserts; the 13 are not that case", async () => {
  const inserts: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({ data: [], error: null }),
          }),
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const out = await applyOpenReceivableReconcile(
    client,
    "00000000-0000-0000-0000-000000000001",
    [{
      InvoiceID: "bbbbbbbb-0000-4000-8000-000000000099",
      InvoiceNumber: "INV-ABSENT",
      Type: "ACCREC",
      Status: "AUTHORISED",
      AmountDue: 10,
    }],
    { write: true },
  );
  assertEquals(out.absent.length, 1);
  assertEquals(out.stale_status.length, 0);
  assertEquals(out.inserted, 1);
  assertEquals(out.updated, 0);
  assertEquals(inserts.length, 1);
});
