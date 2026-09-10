// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listStaleXeroInvoices,
  reconcileXeroInvoice,
} from "./xero_invoice_reconciliation.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const INVOICE = "30000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-09T03:00:00.000Z");
const STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "AUTHORISED",
  "PAID",
  "VOIDED",
  "DELETED",
];

function updateClient(error: unknown = null) {
  const patches: Record<string, unknown>[] = [];
  const filters: Array<[string, string]> = [];
  const client = {
    from(table: string) {
      assertEquals(table, "xero_invoices");
      return {
        update(patch: Record<string, unknown>) {
          patches.push(patch);
          const query = {
            eq(field: string, value: string) {
              filters.push([field, value]);
              return query;
            },
            then(resolve: (value: { error: unknown }) => void) {
              resolve({ error });
            },
          };
          return query;
        },
      };
    },
  };
  return { client, patches, filters };
}

function invoice(status: string) {
  return {
    InvoiceID: INVOICE,
    Type: "ACCREC",
    Status: status,
    AmountDue: 60,
    AmountPaid: 40,
  };
}

Deno.test("every accepted status rejects invalid balances before any status or freshness update", async () => {
  const { client, patches } = updateClient();
  for (const status of STATUSES) {
    for (const field of ["AmountDue", "AmountPaid"]) {
      for (const invalid of [undefined, null, "0", NaN, Infinity, -Infinity]) {
        await assertRejects(
          () =>
            reconcileXeroInvoice(client, ORG, INVOICE, () =>
              Promise.resolve({
                Invoices: [{ ...invoice(status), [field]: invalid }],
              }), NOW),
          Error,
          "provider balances are unverified",
        );
      }
    }
  }
  assertEquals(patches, []);
});

Deno.test("every accepted status persists verified balances without inventing a provider update watermark", async () => {
  for (const status of STATUSES) {
    const { client, patches, filters } = updateClient();
    const complete = await reconcileXeroInvoice(
      client,
      ORG,
      INVOICE,
      () =>
        Promise.resolve({
          Invoices: [invoice(status)],
        }),
      NOW,
    );
    assertEquals(complete, true);
    assertEquals(patches, [{
      status,
      amount_due: 60,
      amount_paid: 40,
      synced_at: NOW.toISOString(),
      raw_json: invoice(status),
    }]);
    assertEquals(filters, [["xero_invoice_id", INVOICE], ["org_id", ORG]]);
  }
});

Deno.test("reconciliation preserves a valid provider update date and ignores an invalid date", async () => {
  for (
    const date of [
      "/Date(1788921000000+0000)/",
      "invalid",
      "/Date(999999999999999999999)/",
    ]
  ) {
    const { client, patches } = updateClient();
    await reconcileXeroInvoice(client, ORG, INVOICE, () =>
      Promise.resolve({
        Invoices: [{ ...invoice("AUTHORISED"), UpdatedDateUTC: date }],
      }), NOW);
    assertEquals(
      patches[0].updated_at,
      date.startsWith("/Date(178")
        ? new Date(1788921000000).toISOString()
        : undefined,
    );
  }
});

Deno.test("a failed cache update cannot report completed reconciliation", async () => {
  const { client } = updateClient({ message: "fixture-only database failure" });
  await assertRejects(
    () =>
      reconcileXeroInvoice(client, ORG, INVOICE, () =>
        Promise.resolve({
          Invoices: [invoice("SUBMITTED")],
        }), NOW),
    Error,
    "could not save",
  );
});

function selectionClient(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const query = {
    select(value: string) {
      calls.push(["select", value]);
      return query;
    },
    eq(field: string, value: unknown) {
      calls.push(["eq", field, value]);
      return query;
    },
    in(field: string, value: unknown) {
      calls.push(["in", field, value]);
      return query;
    },
    gt(field: string, value: unknown) {
      calls.push(["gt", field, value]);
      return query;
    },
    lt(field: string, value: unknown) {
      calls.push(["lt", field, value]);
      return query;
    },
    limit(value: number) {
      calls.push(["limit", value]);
      return Promise.resolve(result);
    },
  };
  return {
    client: {
      from(table: string) {
        assertEquals(table, "xero_invoices");
        return query;
      },
    },
    calls,
  };
}

Deno.test("stale selection errors and malformed data cannot become an empty successful batch", async () => {
  for (
    const result of [
      { data: [], error: { message: "fixture-only database failure" } },
      {
        data: [{ xero_invoice_id: INVOICE }],
        error: { message: "partial result" },
      },
      { data: null, error: null },
      { data: {}, error: null },
      { data: [{}], error: null },
      { data: [{ xero_invoice_id: "" }], error: null },
    ]
  ) {
    const { client } = selectionClient(result);
    await assertRejects(
      () => listStaleXeroInvoices(client, ORG, NOW),
      Error,
      "selection failed",
    );
  }
});

Deno.test("successful stale selection retains the tenant-independent org, receivable, status and batch scope", async () => {
  for (const data of [[], [{ xero_invoice_id: INVOICE }]]) {
    const { client, calls } = selectionClient({ data, error: null });
    assertEquals(await listStaleXeroInvoices(client, ORG, NOW), data);
    assertEquals(calls, [
      ["select", "xero_invoice_id"],
      ["eq", "org_id", ORG],
      ["eq", "invoice_type", "ACCREC"],
      ["in", "status", ["AUTHORISED", "SUBMITTED"]],
      ["gt", "amount_due", 0],
      ["lt", "synced_at", "2026-09-09T02:00:00.000Z"],
      ["limit", 50],
    ]);
  }
});

Deno.test("reconciliation refreshes the verified provider copy, due date and lines for every accepted status", async () => {
  for (const status of STATUSES) {
    const { client, patches } = updateClient();
    const record = {
      ...invoice(status),
      DueDateString: "2026-10-01T00:00:00",
      LineItems: [{ Description: "fixture-only", LineAmount: 100 }],
    };
    await reconcileXeroInvoice(
      client,
      ORG,
      INVOICE,
      () => Promise.resolve({ Invoices: [record] }),
      NOW,
    );
    assertEquals(patches[0].raw_json, record);
    assertEquals(patches[0].due_date, record.DueDateString);
    assertEquals(patches[0].line_items, record.LineItems);
  }
});

Deno.test("missing or malformed optional provider fields never erase cached date and lines", async () => {
  for (
    const optional of [{}, { DueDateString: undefined, LineItems: undefined }, {
      DueDateString: "invalid",
      LineItems: {},
    }, { DueDateString: 0, LineItems: null }]
  ) {
    const { client, patches } = updateClient();
    const record = { ...invoice("AUTHORISED"), ...optional };
    await reconcileXeroInvoice(
      client,
      ORG,
      INVOICE,
      () => Promise.resolve({ Invoices: [record] }),
      NOW,
    );
    assertEquals(Object.hasOwn(patches[0], "due_date"), false);
    assertEquals(Object.hasOwn(patches[0], "line_items"), false);
    assertEquals(patches[0].raw_json, record);
  }
});
