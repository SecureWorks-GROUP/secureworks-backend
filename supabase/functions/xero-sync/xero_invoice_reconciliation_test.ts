// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DRAFT_RECONCILE_KEY,
  DRAFT_RECONCILE_LIMIT,
  listStaleXeroInvoices,
  OPEN_RECONCILE_LIMIT,
  reconcileStaleXeroInvoices,
  reconcileXeroInvoice,
} from "./xero_invoice_reconciliation.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

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
      reconcile_attempted_at: NOW.toISOString(),
      reconcile_last_error: null,
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

type SelectionResult = { data: unknown; error: unknown };

const DRAFT = "40000000-0000-4000-8000-000000000004";
// Far enough back that both the hourly and the daily windows are open.
const DUE_CURSOR = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
const FRESH_CURSOR = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

interface StaleClientOptions {
  open?: SelectionResult;
  drafts?: SelectionResult;
  // undefined means no cursor row at all, so the sweep has never run.
  cursorAt?: string | null;
  cursorError?: unknown;
  updateError?: unknown;
  // Per-invoice provider reads, keyed by invoice id.
  read?: Record<string, () => Promise<unknown>>;
}

function staleClient(options: StaleClientOptions = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ patch: Record<string, unknown>; filters: string[] }> =
    [];
  let selects = 0;

  const selectQuery = (result: SelectionResult) => {
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
      order(field: string, opts: unknown) {
        calls.push(["order", field, opts]);
        return query;
      },
      limit(value: number) {
        calls.push(["limit", value]);
        return Promise.resolve(result);
      },
    };
    return query;
  };

  const client = {
    from(table: string) {
      if (table === "xero_sync_state") {
        return {
          select(value: string) {
            calls.push(["state.select", value]);
            const query = {
              eq(field: string, value: unknown) {
                calls.push(["state.eq", field, value]);
                return query;
              },
              maybeSingle() {
                calls.push(["state.maybeSingle"]);
                return Promise.resolve({
                  data: options.cursorAt === undefined
                    ? null
                    : { cursor_at: options.cursorAt },
                  error: options.cursorError ?? null,
                });
              },
            };
            return query;
          },
          upsert(row: Record<string, unknown>, opts: unknown) {
            calls.push(["state.upsert", opts]);
            upserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      assertEquals(table, "xero_invoices");
      return {
        select(value: string) {
          selects++;
          const result = selects === 1
            ? options.open ?? { data: [], error: null }
            : options.drafts ?? { data: [], error: null };
          return selectQuery(result).select(value);
        },
        update(patch: Record<string, unknown>) {
          const filters: string[] = [];
          const record = { patch, filters };
          const query = {
            eq(_field: string, value: string) {
              filters.push(value);
              return query;
            },
            then(resolve: (value: { error: unknown }) => void) {
              updates.push(record);
              resolve({ error: options.updateError ?? null });
            },
          };
          return query;
        },
      };
    },
  };

  const readInvoice = (invoiceId: string) => {
    const reader = options.read?.[invoiceId];
    if (!reader) {
      return Promise.resolve({
        Invoices: [{
          InvoiceID: invoiceId,
          Type: "ACCREC",
          Status: "AUTHORISED",
          AmountDue: 60,
          AmountPaid: 40,
        }],
      });
    }
    return reader();
  };

  return { client, calls, upserts, updates, readInvoice };
}

const ids = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    xero_invoice_id: `${prefix}-${index}`,
  }));

const OPEN_CALLS: Array<[string, ...unknown[]]> = [
  ["select", "xero_invoice_id"],
  ["eq", "org_id", ORG],
  ["eq", "invoice_type", "ACCREC"],
  ["in", "status", ["AUTHORISED", "SUBMITTED"]],
  ["gt", "amount_due", 0],
  ["lt", "synced_at", "2026-09-09T02:00:00.000Z"],
  ["limit", OPEN_RECONCILE_LIMIT],
];

const GATE_CALLS: Array<[string, ...unknown[]]> = [
  ["state.select", "cursor_at"],
  ["state.eq", "key", DRAFT_RECONCILE_KEY],
  ["state.maybeSingle"],
];

const DRAFT_CALLS: Array<[string, ...unknown[]]> = [
  ["select", "xero_invoice_id"],
  ["eq", "org_id", ORG],
  ["eq", "invoice_type", "ACCREC"],
  ["eq", "status", "DRAFT"],
  ["lt", "synced_at", "2026-09-08T03:00:00.000Z"],
  ["order", "reconcile_attempted_at", { ascending: true, nullsFirst: true }],
  ["order", "synced_at", { ascending: true }],
  ["limit", DRAFT_RECONCILE_LIMIT],
];

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
    const { client } = staleClient({ open: result, cursorAt: DUE_CURSOR });
    await assertRejects(
      () => listStaleXeroInvoices(client, ORG, NOW),
      Error,
      "selection failed",
    );
    // A healthy open-receivable query never hides a failed draft query.
    const second = staleClient({
      open: { data: [], error: null },
      drafts: result,
      cursorAt: DUE_CURSOR,
    });
    await assertRejects(
      () => listStaleXeroInvoices(second.client, ORG, NOW),
      Error,
      "selection failed",
    );
  }
});

Deno.test("successful stale selection retains the tenant-independent org, receivable, status and batch scope, and adds cached drafts once the daily cursor is due", async () => {
  for (
    const [open, drafts, expected] of [
      [[], [], []],
      [[{ xero_invoice_id: INVOICE }], [], [{ xero_invoice_id: INVOICE }]],
      [[], [{ xero_invoice_id: DRAFT }], [{ xero_invoice_id: DRAFT }]],
      // The same identity in both selections is verified once.
      [[{ xero_invoice_id: INVOICE }], [{ xero_invoice_id: INVOICE }, {
        xero_invoice_id: DRAFT,
      }], [{ xero_invoice_id: INVOICE }, { xero_invoice_id: DRAFT }]],
    ] as Array<
      [
        Array<{ xero_invoice_id: string }>,
        Array<{ xero_invoice_id: string }>,
        Array<{ xero_invoice_id: string }>,
      ]
    >
  ) {
    const { client, calls } = staleClient({
      open: { data: open, error: null },
      drafts: { data: drafts, error: null },
      cursorAt: DUE_CURSOR,
    });
    const selection = await listStaleXeroInvoices(client, ORG, NOW);
    assertEquals(selection.invoices, expected);
    assertEquals(selection.draftsDue, true);
    assertEquals(selection.draftGateSkipped, null);
    assertEquals(calls, [...OPEN_CALLS, ...GATE_CALLS, ...DRAFT_CALLS]);
  }
});

// ── Blocker 1: quota. sync_invoices runs every 15 minutes, so an ungated
//    draft sweep of 25 rows costs up to 2,400 extra Xero calls a day. ──

Deno.test("the draft sweep is skipped inside 24 hours and issues no draft query at all", async () => {
  for (
    const cursor of [
      FRESH_CURSOR,
      NOW.toISOString(),
      new Date(NOW.getTime() - 24 * 60 * 60 * 1000 + 1000).toISOString(),
    ]
  ) {
    const { client, calls } = staleClient({
      open: { data: [{ xero_invoice_id: INVOICE }], error: null },
      drafts: { data: [{ xero_invoice_id: DRAFT }], error: null },
      cursorAt: cursor,
    });
    const selection = await listStaleXeroInvoices(client, ORG, NOW);
    assertEquals(selection.invoices, [{ xero_invoice_id: INVOICE }]);
    assertEquals(selection.draftsDue, false);
    assertEquals(selection.drafts, 0);
    assertEquals(selection.draftGateSkipped, null);
    // No second xero_invoices query means no draft GETs and no quota spent.
    assertEquals(calls, [...OPEN_CALLS, ...GATE_CALLS]);
  }
});

Deno.test("the draft sweep runs once the cursor is a day old, and on a first run with no cursor", async () => {
  for (const cursor of [DUE_CURSOR, undefined, null]) {
    const { client, calls } = staleClient({
      open: { data: [], error: null },
      drafts: { data: [{ xero_invoice_id: DRAFT }], error: null },
      cursorAt: cursor,
    });
    const selection = await listStaleXeroInvoices(client, ORG, NOW);
    assertEquals(selection.draftsDue, true);
    assertEquals(selection.invoices, [{ xero_invoice_id: DRAFT }]);
    assertEquals(calls, [...OPEN_CALLS, ...GATE_CALLS, ...DRAFT_CALLS]);
  }
});

Deno.test("an unreadable draft cursor skips the sweep rather than guessing that a day passed", async () => {
  for (
    const options of [
      { cursorError: { message: "fixture-only database failure" } },
      { cursorAt: "not-a-timestamp" },
    ]
  ) {
    const { client, calls } = staleClient({
      open: { data: [], error: null },
      drafts: { data: [{ xero_invoice_id: DRAFT }], error: null },
      ...options,
    });
    const selection = await listStaleXeroInvoices(client, ORG, NOW);
    assertEquals(selection.draftsDue, false);
    assertEquals(selection.invoices, []);
    assertEquals(
      selection.draftGateSkipped,
      "draft reconcile cursor is unreadable",
    );
    assertEquals(calls, [...OPEN_CALLS, ...GATE_CALLS]);
  }
});

Deno.test("a due sweep takes at most five drafts however many are stale", async () => {
  const { client, calls } = staleClient({
    open: { data: [], error: null },
    drafts: { data: ids(25, "draft"), error: null },
    cursorAt: DUE_CURSOR,
  });
  const selection = await listStaleXeroInvoices(client, ORG, NOW);
  assertEquals(DRAFT_RECONCILE_LIMIT, 5);
  assertEquals(selection.drafts, 5);
  assertEquals(selection.invoices.length, 5);
  assertEquals(
    selection.invoices.map((row) => row.xero_invoice_id),
    ["draft-0", "draft-1", "draft-2", "draft-3", "draft-4"],
  );
  // The database is asked for five, and the merge caps at five regardless.
  assertEquals(calls.at(-1), ["limit", DRAFT_RECONCILE_LIMIT]);
});

Deno.test("a full page of stale open receivables cannot starve the reserved draft slots", async () => {
  const { client } = staleClient({
    open: { data: ids(OPEN_RECONCILE_LIMIT, "open"), error: null },
    drafts: { data: ids(DRAFT_RECONCILE_LIMIT, "draft"), error: null },
    cursorAt: DUE_CURSOR,
  });
  const selection = await listStaleXeroInvoices(client, ORG, NOW);
  assertEquals(
    selection.invoices.length,
    OPEN_RECONCILE_LIMIT + DRAFT_RECONCILE_LIMIT,
  );
  assertEquals(selection.drafts, DRAFT_RECONCILE_LIMIT);
  assertEquals(
    selection.invoices.slice(OPEN_RECONCILE_LIMIT).map((r) => r.xero_invoice_id),
    ["draft-0", "draft-1", "draft-2", "draft-3", "draft-4"],
  );
});

// ── Blocker 2: head-of-line. The same row is first in every selection, so
//    breaking on it froze reconciliation for every row behind it. ──

Deno.test("one unverifiable identity does not stop the rest of the batch", async () => {
  const { client, readInvoice, updates } = staleClient({
    open: {
      data: [{ xero_invoice_id: "open-0" }, { xero_invoice_id: "open-1" }, {
        xero_invoice_id: "open-2",
      }],
      error: null,
    },
    cursorAt: FRESH_CURSOR,
    read: {
      "open-0": () =>
        Promise.reject(new XeroSyncProviderError(404, "/Invoices/open-0")),
    },
  });
  const summary = await reconcileStaleXeroInvoices(
    client,
    ORG,
    readInvoice,
    NOW,
  );
  assertEquals(summary.attempted, 3);
  assertEquals(summary.reconciled, 2);
  assertEquals(summary.failed, 1);
  assertEquals(summary.last_error?.invoice_id, "open-0");
  // The failed row records the attempt and the reason, and never claims a
  // verified balance or a fresh synced_at.
  const failed = updates.find((u) => u.filters[0] === "open-0");
  assertEquals(failed?.patch.reconcile_attempted_at, NOW.toISOString());
  assertEquals(
    String(failed?.patch.reconcile_last_error).includes("HTTP 404"),
    true,
  );
  assertEquals(Object.hasOwn(failed!.patch, "synced_at"), false);
  assertEquals(Object.hasOwn(failed!.patch, "amount_due"), false);
  // The two healthy rows still reached a verified update.
  assertEquals(
    updates.filter((u) => u.patch.status === "AUTHORISED").map((u) =>
      u.filters[0]
    ),
    ["open-1", "open-2"],
  );
});

Deno.test("a first row that fails every run stops heading the batch through the attempt stamp", async () => {
  // Two consecutive runs: the same broken draft is selected first, fails, and
  // records an attempt. Ordering by reconcile_attempted_at is what demotes it.
  const { client, readInvoice, updates } = staleClient({
    open: { data: [], error: null },
    drafts: {
      data: [{ xero_invoice_id: "draft-broken" }, {
        xero_invoice_id: "draft-ok",
      }],
      error: null,
    },
    cursorAt: DUE_CURSOR,
    read: {
      "draft-broken": () =>
        Promise.reject(
          new XeroSyncProviderError(404, "/Invoices/draft-broken"),
        ),
    },
  });
  const summary = await reconcileStaleXeroInvoices(
    client,
    ORG,
    readInvoice,
    NOW,
  );
  assertEquals(summary.failed, 1);
  assertEquals(summary.reconciled, 1);
  assertEquals(updates[0].filters[0], "draft-broken");
  assertEquals(updates[0].patch.reconcile_attempted_at, NOW.toISOString());
});

Deno.test("an unverified provider identity is isolated but a cache write failure still stops the batch", async () => {
  // Identity and balance guards are per-invoice facts: skip that row.
  const isolated = staleClient({
    open: {
      data: [{ xero_invoice_id: "open-0" }, { xero_invoice_id: "open-1" }],
      error: null,
    },
    cursorAt: FRESH_CURSOR,
    read: {
      "open-0": () => Promise.resolve({ Invoices: [] }),
    },
  });
  const skipped = await reconcileStaleXeroInvoices(
    isolated.client,
    ORG,
    isolated.readInvoice,
    NOW,
  );
  assertEquals(skipped.attempted, 2);
  assertEquals(skipped.reconciled, 1);
  assertEquals(skipped.failed, 1);

  // A database that cannot save is a run-wide fact: stop spending quota.
  const broken = staleClient({
    open: {
      data: [{ xero_invoice_id: "open-0" }, { xero_invoice_id: "open-1" }],
      error: null,
    },
    cursorAt: FRESH_CURSOR,
    updateError: { message: "fixture-only database failure" },
  });
  const stopped = await reconcileStaleXeroInvoices(
    broken.client,
    ORG,
    broken.readInvoice,
    NOW,
  );
  assertEquals(stopped.attempted, 1);
  assertEquals(stopped.reconciled, 0);
  assertEquals(stopped.failed, 1);
});

Deno.test("a cooldown stops the batch and is raised to the caller", async () => {
  const { client, readInvoice } = staleClient({
    open: {
      data: [{ xero_invoice_id: "open-0" }, { xero_invoice_id: "open-1" }],
      error: null,
    },
    cursorAt: FRESH_CURSOR,
    read: {
      "open-0": () =>
        Promise.reject(
          new XeroCooldownError("fixture-only cooldown", 429, "xero_cooldown"),
        ),
    },
  });
  await assertRejects(
    () => reconcileStaleXeroInvoices(client, ORG, readInvoice, NOW),
    XeroCooldownError,
  );
});

Deno.test("the daily cursor advances only on a run that actually swept drafts", async () => {
  const swept = staleClient({
    open: { data: [], error: null },
    drafts: { data: [{ xero_invoice_id: DRAFT }], error: null },
    cursorAt: DUE_CURSOR,
  });
  const ran = await reconcileStaleXeroInvoices(
    swept.client,
    ORG,
    swept.readInvoice,
    NOW,
  );
  assertEquals(ran.draft_sweep_ran, true);
  assertEquals(ran.drafts_selected, 1);
  assertEquals(swept.upserts.length, 1);
  assertEquals(swept.upserts[0].key, DRAFT_RECONCILE_KEY);
  assertEquals(swept.upserts[0].cursor_at, NOW.toISOString());

  const skipped = staleClient({
    open: { data: [], error: null },
    drafts: { data: [{ xero_invoice_id: DRAFT }], error: null },
    cursorAt: FRESH_CURSOR,
  });
  const held = await reconcileStaleXeroInvoices(
    skipped.client,
    ORG,
    skipped.readInvoice,
    NOW,
  );
  assertEquals(held.draft_sweep_ran, false);
  // Nothing was swept, so the 24-hour clock must not restart.
  assertEquals(skipped.upserts, []);
});

Deno.test("a cached draft that Xero has deleted reconciles to DELETED with a zero balance", async () => {
  const DRAFT = "40000000-0000-4000-8000-000000000004";
  const patches: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      assertEquals(table, "xero_invoices");
      return {
        update(patch: Record<string, unknown>) {
          patches.push(patch);
          return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        },
      };
    },
  };
  const ok = await reconcileXeroInvoice(client, ORG, DRAFT, () =>
    Promise.resolve({ Invoices: [{ InvoiceID: DRAFT, Type: "ACCREC", Status: "DELETED", AmountDue: 0, AmountPaid: 0, UpdatedDateUTC: "/Date(1756901000000+0000)/" }] }), NOW);
  assertEquals(ok, true);
  assertEquals(patches[0].status, "DELETED");
  assertEquals(patches[0].amount_due, 0);
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
