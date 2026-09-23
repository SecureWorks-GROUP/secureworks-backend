// Money slice MN1: the open-book sweep on the named rows (money.md §9 M1, M5,
// M6, M17, M18, M19) and its failure modes (§7 F1 to F3, F12, F15, F16).
// Xero is a scripted in-memory book; the database is money_test_db.ts.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { XeroSyncProviderError } from "./xero_transport.ts";
import {
  classifyLiveOpen,
  CLOSURE_SINGLE_READS_PER_RUN,
  OPEN_BOOK_ACTOR,
  OPEN_BOOK_RUN_SOURCE,
  openBookCursor,
  type OpenBookMode,
  sweepOpenReceivables,
} from "./open_book_sweep.ts";
import { fakeDb, jsonbTextBytes } from "./money_test_db.ts";
import {
  M1,
  M17,
  M18,
  M19,
  M5,
  M6,
  ORG,
  xeroInvoice,
} from "./money_named_rows.ts";

const NOW = new Date("2026-09-24T02:00:00.000Z");

type Inv = Record<string, any>;

// A scripted Xero: the open book (paged by 100), the IDs= read and the
// single-record read, with every call counted.
function scriptedXero(opts: {
  open: Inv[];
  byId?: Record<string, Inv | null>;
  single?: Record<string, Inv | Error>;
  failPage?: number;
  failPageWith?: Error;
  dayRemaining?: number;
}) {
  const calls: string[] = [];
  return {
    calls,
    xero: {
      listOpenPage: (page: number) => {
        calls.push(`page:${page}`);
        if (opts.failPage === page) {
          return Promise.reject(
            opts.failPageWith ?? new XeroSyncProviderError(500, "/Invoices"),
          );
        }
        return Promise.resolve(opts.open.slice((page - 1) * 100, page * 100));
      },
      readByIds: (ids: string[]) => {
        calls.push(`ids:${ids.length}`);
        return Promise.resolve(
          ids.map((id) => opts.byId?.[id]).filter((x): x is Inv => !!x),
        );
      },
      readOne: (id: string) => {
        calls.push(`one:${id}`);
        const r = opts.single?.[id];
        if (r instanceof Error) return Promise.reject(r);
        if (!r) {
          return Promise.reject(new XeroSyncProviderError(404, "/Invoices"));
        }
        return Promise.resolve({ Invoices: [r] });
      },
      quota: () => ({
        calls: calls.length,
        day_remaining: opts.dayRemaining ?? 1866,
      }),
    },
  };
}

function deps(
  mode: OpenBookMode | "throws",
  xero: any,
  completed: string[] = [],
) {
  return {
    orgId: ORG,
    now: () => NOW,
    completeInvoicedJob: (jobId: string) => {
      completed.push(jobId);
      return Promise.resolve();
    },
    xero,
    readMode: () =>
      mode === "throws"
        ? Promise.reject(new Error("rpc down"))
        : Promise.resolve({
          mode,
          state: mode === "off" ? "missing" : "present",
        }),
  };
}

function cachedRow(fields: Inv): Inv {
  return {
    org_id: ORG,
    invoice_type: "ACCREC",
    job_contact_id: null,
    invoice_obligation_revision_id: null,
    ses_external_token: null,
    reference: null,
    xero_verified_at: null,
    ...fields,
  };
}

// The named-row book: M1 re-appears, M5 and M19 carry a new payer, M6 a new
// reference; one invoice is already in sync.
function namedBook() {
  const inSync = xeroInvoice({
    InvoiceID: "00000000-0000-4000-8000-00000000a001",
    InvoiceNumber: "INV-1500",
    Status: "AUTHORISED",
    Total: 100,
    AmountDue: 100,
    AmountPaid: 0,
    Contact: { ContactID: "c-in-sync", Name: "Customer A" },
    Reference: "SWF-261500",
  });
  const open = [
    xeroInvoice({
      InvoiceID: M1.id,
      InvoiceNumber: M1.number,
      Contact: { ContactID: M1.cached.xero_contact_id, Name: "Customer M1" },
      ...M1.xero,
    }),
    xeroInvoice({
      InvoiceID: M5.id,
      InvoiceNumber: M5.number,
      Status: "AUTHORISED",
      Total: M5.total,
      AmountDue: M5.total,
      AmountPaid: 0,
      Contact: { ContactID: M5.contact_after, Name: "Customer M5 (now)" },
      Reference: M5.reference,
    }),
    xeroInvoice({
      InvoiceID: M6.id,
      InvoiceNumber: M6.number,
      Status: "AUTHORISED",
      Total: M6.total,
      AmountDue: M6.total,
      AmountPaid: 0,
      Contact: { ContactID: M6.contact, Name: "Customer M6" },
      Reference: M6.reference_after,
    }),
    xeroInvoice({
      InvoiceID: M19.id,
      InvoiceNumber: M19.number,
      Status: "AUTHORISED",
      Total: M19.total,
      AmountDue: M19.total,
      AmountPaid: 0,
      Contact: { ContactID: M19.contact_after, Name: "Customer M19 (now)" },
      Reference: M19.reference,
    }),
    inSync,
  ];
  const cached = [
    cachedRow({
      xero_invoice_id: M1.id,
      invoice_number: M1.number,
      job_id: M1.job_id,
      ...M1.cached,
    }),
    cachedRow({
      xero_invoice_id: M5.id,
      invoice_number: M5.number,
      job_id: M5.job_id,
      status: "AUTHORISED",
      total: M5.total,
      amount_due: M5.total,
      xero_contact_id: M5.contact_before,
      contact_name: "Customer M5 (old)",
      reference: M5.reference,
    }),
    cachedRow({
      xero_invoice_id: M6.id,
      invoice_number: M6.number,
      job_id: M6.job_id,
      status: "AUTHORISED",
      total: M6.total,
      amount_due: M6.total,
      xero_contact_id: M6.contact,
      reference: M6.reference_before,
    }),
    cachedRow({
      xero_invoice_id: M19.id,
      invoice_number: M19.number,
      job_id: M19.job_id,
      status: "AUTHORISED",
      total: M19.total,
      amount_due: M19.total,
      xero_contact_id: M19.contact_before,
      reference: M19.reference,
    }),
    cachedRow({
      xero_invoice_id: inSync.InvoiceID,
      invoice_number: "INV-1500",
      status: "AUTHORISED",
      total: 100,
      amount_due: 100,
      xero_contact_id: "c-in-sync",
      reference: "SWF-261500",
    }),
  ];
  return { open, cached };
}

const byId = (rows: Inv[], id: string) =>
  rows.find((r) => r.xero_invoice_id === id);

Deno.test("classifier: each named drift class, and an in-sync row has none", () => {
  const { open, cached } = namedBook();
  const pair = (id: string): [Inv, any] => [
    open.find((i) => i.InvoiceID === id) as Inv,
    cached.find((r) => r.xero_invoice_id === id),
  ];
  assertEquals(classifyLiveOpen(...pair(M1.id)), ["added_back"]);
  assertEquals(classifyLiveOpen(...pair(M5.id)), ["contact_changed"]);
  assertEquals(classifyLiveOpen(...pair(M6.id)), ["reference_changed"]);
  assertEquals(classifyLiveOpen(...pair(M19.id)), ["contact_changed"]);
  assertEquals(
    classifyLiveOpen(...pair("00000000-0000-4000-8000-00000000a001")),
    [],
  );
  // Not in our copy at all is also "added back"; PAID here is its own class.
  assertEquals(classifyLiveOpen(open[0], null), ["added_back"]);
  assertEquals(
    classifyLiveOpen(open[0], { ...(cached[0] as any), status: "PAID" }),
    ["closed_here_open_there"],
  );
  // Amounts compare to the cent, whatever type the copy returns.
  assertEquals(
    classifyLiveOpen(
      { ...open[4], AmountDue: 99.99 },
      { ...(cached[4] as any), amount_due: "100.00" },
    ),
    ["amount_changed"],
  );
  assertEquals(
    classifyLiveOpen(open[4], { ...(cached[4] as any), total: "100.004" }),
    [],
  );
});

Deno.test("M1 observe: INV-0034 is listed as added back, our copy is not written, the receipt names it", async () => {
  const { open, cached } = namedBook();
  const db = fakeDb({ tables: { xero_invoices: cached } });
  const { xero, calls } = scriptedXero({ open });
  const before = structuredClone(db.table("xero_invoices"));
  const s = await sweepOpenReceivables(db.client, deps("observe", xero));
  assertEquals(s.status, "succeeded");
  assertEquals(s.counts.added_back, 1);
  assertEquals(s.counts.contact_changed, 2);
  assertEquals(s.counts.reference_changed, 1);
  assertEquals(s.counts.in_sync, 1);
  assertEquals(s.counts.applied, 0);
  assertEquals(s.ids.added_back, [M1.id]);
  // Observe writes nothing to xero_invoices.
  assertEquals(db.table("xero_invoices"), before);
  assert(!db.log.some((l) => l.table === "xero_invoices" && l.op !== "select"));
  assertEquals(calls, ["page:1"]);
  // One receipt: running, then succeeded, ids only.
  const [run] = [...db.runs.values()];
  assertEquals(run.source, OPEN_BOOK_RUN_SOURCE);
  assertEquals(run.calls.map((c) => c.status), ["running", "succeeded"]);
  assertEquals((run.cursor as any).actor, OPEN_BOOK_ACTOR);
  assertEquals((run.cursor as any).mode, "observe");
  assertEquals((run.cursor as any).ids.added_back, [M1.id]);
  assertEquals(run.counts.day_remaining, 1866);
  assertEquals(run.counts.xero_calls, 1);
  const receipt = JSON.stringify(run.calls);
  for (const secret of ["Customer", "734.48", M6.reference_after]) {
    assert(!receipt.includes(secret), `receipt carries ${secret}`);
  }
});

Deno.test("M1, M5, M6, M19 apply: one sweep corrects status, balance, payer and reference; links stay", async () => {
  const { open, cached } = namedBook();
  const db = fakeDb({ tables: { xero_invoices: cached } });
  const { xero } = scriptedXero({ open });
  const s = await sweepOpenReceivables(db.client, deps("apply", xero));
  assertEquals(s.status, "succeeded");
  assertEquals(s.counts.applied, 5);
  const rows = db.table("xero_invoices");
  // M1: back in the open book, owed $734.48, still on its job.
  const m1 = byId(rows, M1.id)!;
  assertEquals(
    [m1.status, m1.amount_due, m1.job_id],
    ["AUTHORISED", 734.48, M1.job_id],
  );
  // M5 and M19: the payer is the live Xero contact.
  assertEquals(byId(rows, M5.id)!.xero_contact_id, M5.contact_after);
  assertEquals(byId(rows, M5.id)!.contact_name, "Customer M5 (now)");
  assertEquals(byId(rows, M19.id)!.xero_contact_id, M19.contact_after);
  // M6: the reference is Xero's, and the job link is not dropped or moved.
  assertEquals(byId(rows, M6.id)!.reference, M6.reference_after);
  assertEquals(byId(rows, M6.id)!.job_id, M6.job_id);
  // Every live open row is now verified at this run.
  for (const id of [M1.id, M5.id, M6.id, M19.id]) {
    assertEquals(byId(rows, id)!.xero_verified_at, NOW.toISOString());
  }
  // A second sweep over the same book finds nothing to correct.
  const again = await sweepOpenReceivables(
    db.client,
    deps("apply", scriptedXero({ open }).xero),
  );
  assertEquals(again.counts.in_sync, 5);
  assertEquals(
    again.counts.added_back + again.counts.contact_changed +
      again.counts.reference_changed,
    0,
  );
});

Deno.test("M17: a deposit invoice closed only by the closure read stamps deposit_at once and completes the job once", async () => {
  const deposit = cachedRow({
    xero_invoice_id: M17.id,
    invoice_number: M17.number,
    job_id: M17.job_id,
    status: "AUTHORISED",
    total: 1650,
    amount_due: 1650,
  });
  const paid = xeroInvoice({
    InvoiceID: M17.id,
    InvoiceNumber: M17.number,
    Status: "PAID",
    Total: 1650,
    AmountDue: 0,
    AmountPaid: 1650,
    FullyPaidOnDate: M17.paid_on,
    UpdatedDateUTC: M17.paid_on,
  });
  const db = fakeDb({
    tables: {
      xero_invoices: [deposit],
      jobs: [{
        id: M17.job_id,
        org_id: ORG,
        job_number: "SWF-269017",
        status: "invoiced",
        deposit_at: null,
        deposit_invoice_id: M17.id,
      }],
    },
  });
  const completed: string[] = [];
  // The incremental loop missed the payment: Xero's open book no longer lists
  // it, and the IDs= read returns it PAID.
  const { xero, calls } = scriptedXero({ open: [], byId: { [M17.id]: paid } });
  const s = await sweepOpenReceivables(
    db.client,
    deps("apply", xero, completed),
  );
  assertEquals(calls, ["page:1", "ids:1"]);
  assertEquals(s.counts.open_here_not_in_xero, 1);
  assertEquals(s.counts.closed_by_ids_read, 1);
  assertEquals(s.counts.deposit_stamps, 1);
  assertEquals(s.counts.jobs_completed, 1);
  const job = db.table("jobs")[0];
  assertEquals(job.deposit_at, "2026-09-23T00:00:00.000Z");
  assertEquals(completed, [M17.job_id]);
  assertEquals(byId(db.table("xero_invoices"), M17.id)!.status, "PAID");
  const events = db.table("business_events").map((e) => e.event_type);
  assertEquals(events.filter((e) => e === "job.deposit_stamped").length, 1);
  assertEquals(
    events.filter((e) => e === "invoice.payment_received").length,
    1,
  );

  // The next run: the invoice is no longer open here, so nothing is re-read,
  // and the stamp and completion are not repeated.
  const second = await sweepOpenReceivables(
    db.client,
    deps(
      "apply",
      scriptedXero({ open: [], byId: { [M17.id]: paid } }).xero,
      completed,
    ),
  );
  assertEquals(second.counts.open_here_not_in_xero, 0);
  assertEquals(second.counts.deposit_stamps, 0);
  assertEquals(completed, [M17.job_id]);
});

Deno.test("M18: an invoice deleted in Xero while open here is settled by the per-id read within one run", async () => {
  const db = fakeDb({
    tables: {
      xero_invoices: [cachedRow({
        xero_invoice_id: M18.id,
        invoice_number: M18.number,
        status: "SUBMITTED",
        total: 220,
        amount_due: 220,
      })],
    },
  });
  const deleted = xeroInvoice({
    InvoiceID: M18.id,
    InvoiceNumber: M18.number,
    Status: "DELETED",
    Total: 220,
    AmountDue: 0,
    AmountPaid: 0,
  });
  // The IDs= list read omits the deleted invoice; the single read returns it.
  const { xero, calls } = scriptedXero({
    open: [],
    byId: {},
    single: { [M18.id]: deleted },
  });
  const s = await sweepOpenReceivables(db.client, deps("apply", xero));
  assertEquals(calls, ["page:1", "ids:1", `one:${M18.id}`]);
  assertEquals(s.counts.closed_by_single_read, 1);
  assertEquals(s.counts.closure_unverified, 0);
  const row = db.table("xero_invoices")[0];
  assertEquals([row.status, row.amount_due], ["DELETED", 0]);
  assertEquals(row.xero_verified_at, NOW.toISOString());

  // Observe reads the same way and writes nothing.
  const db2 = fakeDb({
    tables: {
      xero_invoices: [cachedRow({
        xero_invoice_id: M18.id,
        status: "SUBMITTED",
        amount_due: 220,
      })],
    },
  });
  const o = await sweepOpenReceivables(
    db2.client,
    deps(
      "observe",
      scriptedXero({ open: [], single: { [M18.id]: deleted } }).xero,
    ),
  );
  assertEquals(o.counts.closed_by_single_read, 1);
  assertEquals(db2.table("xero_invoices")[0].status, "SUBMITTED");
});

Deno.test("closure: at most ten single reads a run; the rest and unreadable ones are closure_unverified", async () => {
  const ids = Array.from(
    { length: 12 },
    (_, i) => `00000000-0000-4000-8000-0000000c${String(i).padStart(4, "0")}`,
  );
  const db = fakeDb({
    tables: {
      xero_invoices: ids.map((id) =>
        cachedRow({
          xero_invoice_id: id,
          status: "AUTHORISED",
          total: 10,
          amount_due: 10,
        })
      ),
    },
  });
  const single: Record<string, Inv | Error> = {};
  for (const id of ids.slice(0, 9)) {
    single[id] = xeroInvoice({
      InvoiceID: id,
      Status: "VOIDED",
      Total: 10,
      AmountDue: 0,
      AmountPaid: 0,
    });
  }
  // The tenth read fails; the eleventh and twelfth are never attempted.
  const { xero, calls } = scriptedXero({ open: [], single });
  const s = await sweepOpenReceivables(db.client, deps("apply", xero));
  assertEquals(
    calls.filter((c) => c.startsWith("one:")).length,
    CLOSURE_SINGLE_READS_PER_RUN,
  );
  assertEquals(s.counts.closed_by_single_read, 9);
  assertEquals(s.counts.closure_unverified, 3);
  // Unsettled closures do not fail the sweep; they have their own alarm.
  assertEquals(s.status, "succeeded");
  assertEquals(
    db.table("xero_invoices").filter((r) => r.status === "AUTHORISED").length,
    3,
  );
});

Deno.test("F1: a failed page closes nothing, applies the rows it saw and records partial", async () => {
  const cached = Array.from({ length: 150 }, (_, i) =>
    cachedRow({
      xero_invoice_id: `00000000-0000-4000-8000-000000p${
        String(i).padStart(5, "0")
      }`,
      status: "AUTHORISED",
      total: 5,
      amount_due: 5,
    }));
  const open = cached.slice(0, 100).map((r) =>
    xeroInvoice({
      InvoiceID: r.xero_invoice_id,
      Status: "AUTHORISED",
      Total: 5,
      AmountDue: 4,
      AmountPaid: 1,
    })
  );
  // Page 1 is full (100) so page 2 is asked for, and fails.
  const db = fakeDb({ tables: { xero_invoices: cached } });
  const { xero, calls } = scriptedXero({ open, failPage: 2 });
  const s = await sweepOpenReceivables(db.client, deps("apply", xero));
  assertEquals(calls, ["page:1", "page:2"]);
  assertEquals(s.status, "partial");
  assertEquals(s.error_code, "open_book_page_failed_http_500");
  assertEquals(s.complete, false);
  assertEquals(s.counts.applied, 100);
  assertEquals(s.counts.open_here_not_in_xero, 0);
  // The 50 rows Xero never got to list were neither closed nor re-read.
  assertEquals(
    db.table("xero_invoices").filter((r) => r.amount_due === 5).length,
    50,
  );
});

Deno.test("F12: a cooldown is recorded as failed on the receipt, then raised", async () => {
  const db = fakeDb({ tables: { xero_invoices: [] } });
  const cooldown = new XeroCooldownError("cooling down", 429, "xero_cooldown");
  const { xero } = scriptedXero({
    open: [],
    failPage: 1,
    failPageWith: cooldown,
  });
  await assertRejects(
    () => sweepOpenReceivables(db.client, deps("observe", xero)),
    XeroCooldownError,
  );
  const [run] = [...db.runs.values()];
  assertEquals([run.status, run.error_code], ["failed", "xero_cooldown"]);
});

Deno.test("F16: off, and an unreadable mode, read nothing and write nothing", async () => {
  for (const mode of ["off", "throws"] as const) {
    const db = fakeDb({
      tables: {
        xero_invoices: [
          cachedRow({ xero_invoice_id: "x", status: "AUTHORISED" }),
        ],
      },
    });
    const { xero, calls } = scriptedXero({ open: [] });
    const s = await sweepOpenReceivables(db.client, deps(mode, xero));
    assertEquals([s.mode, s.ran, s.status], ["off", false, "skipped"]);
    assertEquals(calls, []);
    assertEquals(db.runs.size, 0);
    assertEquals(db.log.length, 0);
    if (mode === "throws") assertEquals(s.flag_state, "unreadable");
  }
});

Deno.test("a failed copy read stops before any write or closure", async () => {
  const { open, cached } = namedBook();
  const db = fakeDb({
    tables: { xero_invoices: cached },
    failRead: new Set(["xero_invoices"]),
  });
  const s = await sweepOpenReceivables(
    db.client,
    deps("apply", scriptedXero({ open }).xero),
  );
  assertEquals([s.status, s.error_code], ["partial", "cached_open_unreadable"]);
  assertEquals(s.counts.applied, 0);
});

Deno.test("a row write failure is counted and makes the run partial", async () => {
  const { open, cached } = namedBook();
  const db = fakeDb({
    tables: { xero_invoices: cached },
    failWrite: new Set(["xero_invoices"]),
  });
  const s = await sweepOpenReceivables(
    db.client,
    deps("apply", scriptedXero({ open }).xero),
  );
  assertEquals(s.counts.apply_errors, 5);
  assertEquals([s.status, s.error_code], ["partial", "apply_errors"]);
});

Deno.test("the receipt cursor always fits the 4096-byte column check", () => {
  const ids: Record<string, string[]> = {};
  for (
    const k of [
      "added_back",
      "closed_here_open_there",
      "amount_changed",
      "status_changed",
      "contact_changed",
      "reference_changed",
      "open_here_not_in_xero",
      "closed_by_ids_read",
      "still_open_in_xero",
      "closed_by_single_read",
      "closure_unverified",
      "apply_errors",
    ]
  ) {
    ids[k] = Array.from({ length: 60 }, () => crypto.randomUUID());
  }
  const cursor = openBookCursor("apply", "present", ids);
  assert(
    jsonbTextBytes(cursor) <= 4096,
    `cursor ${jsonbTextBytes(cursor)} bytes`,
  );
  assertEquals((cursor as any).ids_truncated, true);
  assertEquals((cursor as any).actor, OPEN_BOOK_ACTOR);
});
