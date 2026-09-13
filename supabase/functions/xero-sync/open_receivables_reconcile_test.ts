import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyOpenReceivableReconcile,
  diffOpenReceivables,
} from "./open_receivables_reconcile.ts";

// Historical 13 Sep 2026 09:52 Perth observation: these invoice *numbers* were
// provider-open and absent from the door. Tests use synthetic IDs, not a live write.
const HISTORICAL_MISSING = [
  "INV-0034",
  "INV-0080",
  "INV-0177",
  "INV-0352",
  "INV-0615",
  "INV-0704",
  "INV-0876",
  "INV-0938",
  "INV-1200",
  "INV-1213",
  "INV-1368",
  "INV-1407",
  "INV-1442",
];

function providerBook() {
  const cached = Array.from({ length: 160 }, (_, i) => ({
    InvoiceID: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    InvoiceNumber: `INV-C${String(i).padStart(4, "0")}`,
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 100 + i,
  }));
  const missing = HISTORICAL_MISSING.map((n, i) => ({
    InvoiceID: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
    InvoiceNumber: n,
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 10 + i,
  }));
  return { cached, missing, all: [...cached, ...missing] };
}

Deno.test("incremental-shaped cache misses 13 provider-open invoices", () => {
  const book = providerBook();
  const cache = book.cached.map((r) => ({
    xero_invoice_id: r.InvoiceID,
    invoice_number: r.InvoiceNumber,
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    amount_due: r.AmountDue,
  }));
  const diff = diffOpenReceivables(book.all, cache);
  assertEquals(diff.provider_count, 173);
  assertEquals(diff.cache_count, 160);
  assertEquals(diff.missing.length, 13);
  assertEquals(diff.extras.length, 0);
  assertEquals(diff.amount_diffs.length, 0);
  assertEquals(diff.missing.map((m) => m.InvoiceNumber), HISTORICAL_MISSING);
});

Deno.test("assessment write=false does not upsert", async () => {
  const book = providerBook();
  const cache = book.cached.map((r) => ({
    xero_invoice_id: r.InvoiceID,
    invoice_number: r.InvoiceNumber,
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    amount_due: r.AmountDue,
  }));
  const upserts: unknown[] = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                gt: async () => ({ data: cache, error: null }),
              }),
            }),
          }),
        }),
        upsert: async (row: unknown) => {
          upserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const out = await applyOpenReceivableReconcile(
    client,
    "00000000-0000-4000-8000-000000000001",
    book.all,
    { write: false },
  );
  assertEquals(out.written, 0);
  assertEquals(upserts.length, 0);
  assertEquals(out.missing.length, 13);
});

Deno.test("write=true upserts only the missing open rows", async () => {
  const book = providerBook();
  const cache = book.cached.map((r) => ({
    xero_invoice_id: r.InvoiceID,
    invoice_number: r.InvoiceNumber,
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    amount_due: r.AmountDue,
  }));
  const upserts: Array<{ invoice_number: string }> = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                gt: async () => ({ data: cache, error: null }),
              }),
            }),
          }),
        }),
        upsert: async (row: { invoice_number: string }) => {
          upserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const out = await applyOpenReceivableReconcile(
    client,
    "00000000-0000-4000-8000-000000000001",
    book.all,
    { write: true },
  );
  assertEquals(out.written, 13);
  assertEquals(upserts.map((u) => u.invoice_number), HISTORICAL_MISSING);
});
