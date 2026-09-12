import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyDepositStamp,
  depositStampDecision,
  depositStampRelevant,
  xeroDateToIsoTimestamp,
} from "./deposit_stamp.ts";

const INV = "a1b2c3d4-2222-3333-4444-55555566cdef";
const paidInvoice = (extra: Record<string, unknown> = {}) => ({
  Type: "ACCREC",
  InvoiceID: INV,
  InvoiceNumber: "INV-2001",
  Status: "PAID",
  AmountDue: 0,
  AmountPaid: 1650,
  FullyPaidOnDate: "/Date(1757289600000+0000)/",
  ...extra,
});
const job = (extra: Partial<Record<string, unknown>> = {}) => ({
  id: "job-uuid",
  job_number: "SWF-261334",
  deposit_at: null,
  deposit_invoice_id: INV,
  ...extra,
});

Deno.test("xeroDateToIsoTimestamp handles /Date()/, ISO, plain date and junk", () => {
  assertEquals(xeroDateToIsoTimestamp("/Date(1757289600000+0000)/"), "2025-09-08T00:00:00.000Z");
  assertEquals(xeroDateToIsoTimestamp("2026-09-01T04:05:06"), "2026-09-01T04:05:06.000Z");
  assertEquals(xeroDateToIsoTimestamp("2026-09-01"), "2026-09-01T00:00:00.000Z");
  assertEquals(xeroDateToIsoTimestamp(null), null);
  assertEquals(xeroDateToIsoTimestamp(""), null);
  assertEquals(xeroDateToIsoTimestamp("nope"), null);
});

Deno.test("relevance pre-filter: ACCREC PAID / VOIDED / DELETED only", () => {
  assertEquals(depositStampRelevant(paidInvoice()), true);
  assertEquals(depositStampRelevant(paidInvoice({ Status: "VOIDED" })), true);
  assertEquals(depositStampRelevant(paidInvoice({ Status: "DELETED" })), true);
  assertEquals(depositStampRelevant(paidInvoice({ Status: "AUTHORISED" })), false);
  assertEquals(depositStampRelevant(paidInvoice({ Type: "ACCPAY" })), false);
  assertEquals(depositStampRelevant({ Type: "ACCREC", Status: "PAID" }), false);
  assertEquals(depositStampRelevant(null), false);
});

Deno.test("a PAID deposit invoice stamps deposit_at from FullyPaidOnDate", () => {
  assertEquals(depositStampDecision(paidInvoice(), job()), {
    action: "stamp",
    deposit_at: "2025-09-08T00:00:00.000Z",
    source: "fully_paid_on",
  });
});

Deno.test("no FullyPaidOnDate falls back to UpdatedDateUTC, then to sync time", () => {
  assertEquals(
    depositStampDecision(
      paidInvoice({ FullyPaidOnDate: null, UpdatedDateUTC: "/Date(1757376000000+0000)/" }),
      job(),
    ),
    { action: "stamp", deposit_at: "2025-09-09T00:00:00.000Z", source: "updated_date" },
  );
  assertEquals(
    depositStampDecision(
      paidInvoice({ FullyPaidOnDate: null, UpdatedDateUTC: null }),
      job(),
      new Date("2026-09-11T02:00:00.000Z"),
    ),
    { action: "stamp", deposit_at: "2026-09-11T02:00:00.000Z", source: "sync_time" },
  );
});

Deno.test("idempotent: an already stamped job is never re-stamped", () => {
  assertEquals(
    depositStampDecision(paidInvoice(), job({ deposit_at: "2026-08-01T00:00:00.000Z" })),
    null,
  );
});

Deno.test("only the job's OWN deposit invoice stamps it", () => {
  assertEquals(depositStampDecision(paidInvoice(), job({ deposit_invoice_id: "other-id" })), null);
  assertEquals(depositStampDecision(paidInvoice(), job({ deposit_invoice_id: null })), null);
  // Matching is exact, the same as the `.eq` lookup that found the job.
  assertEquals(depositStampDecision(paidInvoice(), job({ deposit_invoice_id: INV.toUpperCase() })), null);
  assertEquals(depositStampDecision(paidInvoice(), job({ deposit_invoice_id: ` ${INV} ` }))?.action, "stamp");
});

Deno.test("a PAID payload that still reports money due does not stamp", () => {
  assertEquals(depositStampDecision(paidInvoice({ AmountDue: 550 }), job()), null);
  // A missing AmountDue is not evidence of a debt; Xero PAID stands.
  assertEquals(depositStampDecision(paidInvoice({ AmountDue: undefined }), job())?.action, "stamp");
});

Deno.test("unpaid, part-paid and non-ACCREC invoices do nothing", () => {
  assertEquals(depositStampDecision(paidInvoice({ Status: "AUTHORISED", AmountDue: 550 }), job()), null);
  assertEquals(depositStampDecision(paidInvoice({ Status: "DRAFT" }), job()), null);
  assertEquals(depositStampDecision(paidInvoice({ Type: "ACCPAY" }), job()), null);
});

Deno.test("a voided deposit invoice logs a contradiction and never clears the stamp", () => {
  const d = depositStampDecision(
    paidInvoice({ Status: "VOIDED" }),
    job({ deposit_at: "2026-08-01T00:00:00.000Z" }),
  );
  assertEquals(d?.action, "log_contradiction");
  assertEquals((d as { invoice_status: string }).invoice_status, "VOIDED");
  // Voided with nothing stamped is simply a no-op.
  assertEquals(depositStampDecision(paidInvoice({ Status: "VOIDED" }), job()), null);
});

// ── applyDepositStamp against a recording fake client ──

interface Write { table: string; op: string; values: Record<string, unknown>; filters: unknown[] }

interface FakeOptions {
  jobRow?: Record<string, unknown> | null;
  lookupError?: boolean;
  updateRows?: Array<Record<string, unknown>>;
  contradictionLogged?: boolean;
  contradictionLookupError?: boolean;
  captureEnabled?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const writes: Write[] = [];
  const jobRow = opts.jobRow === undefined ? job() : opts.jobRow;
  const from = (table: string) => {
    const filters: unknown[] = [];
    let mode: "read" | "update" = "read";
    let values: Record<string, unknown> = {};
    // deno-lint-ignore no-explicit-any
    const api: any = {};
    for (const k of ["select", "eq", "is", "limit", "not", "order"]) {
      api[k] = (...args: unknown[]) => {
        filters.push([k, ...args]);
        return api;
      };
    }
    api.maybeSingle = () =>
      Promise.resolve(
        opts.lookupError
          ? { data: null, error: { message: "job lookup exploded" } }
          : { data: jobRow, error: null },
      );
    api.update = (v: Record<string, unknown>) => {
      mode = "update";
      values = v;
      return api;
    };
    api.insert = (v: Record<string, unknown>) => {
      writes.push({ table, op: "insert", values: v, filters: [...filters] });
      return Promise.resolve({ error: null });
    };
    api.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "update") {
        writes.push({ table, op: "update", values, filters: [...filters] });
        return Promise.resolve(
          resolve({ data: opts.updateRows ?? [{ id: "job-uuid" }], error: null }),
        );
      }
      if (table === "business_events") {
        return Promise.resolve(resolve({
          data: opts.contradictionLogged ? [{ id: "existing-event" }] : [],
          error: opts.contradictionLookupError ? { message: "event lookup exploded" } : null,
        }));
      }
      return Promise.resolve(resolve({ data: [], error: null }));
    };
    return api;
  };
  return {
    client: {
      from,
      rpc: () => Promise.resolve({ data: opts.captureEnabled ?? true, error: null }),
    },
    writes,
  };
}

Deno.test("applyDepositStamp writes deposit_at guarded on null, logs the event, leaves status alone", async () => {
  const { client, writes } = fakeClient();
  const out = await applyDepositStamp(client, "org", paidInvoice(), new Date("2026-09-11T02:00:00.000Z"));
  assertEquals(out?.action, "stamped");
  assertEquals(out?.deposit_at, "2025-09-08T00:00:00.000Z");

  const upd = writes.find((w) => w.table === "jobs" && w.op === "update");
  assertEquals(upd?.values.deposit_at, "2025-09-08T00:00:00.000Z");
  assertEquals("status" in (upd?.values ?? {}), false);
  // The null guard makes a concurrent second stamp a no-op at the database.
  assertEquals(
    (upd?.filters ?? []).some((f) => Array.isArray(f) && f[0] === "is" && f[1] === "deposit_at"),
    true,
  );
  // The write is read back, so a zero-row update cannot be logged as a stamp.
  assertEquals(
    (upd?.filters ?? []).some((f) => Array.isArray(f) && f[0] === "select"),
    true,
  );

  const evt = writes.find((w) => w.table === "business_events");
  assertEquals(evt?.values.event_type, "job.deposit_stamped");
  assertEquals(evt?.values.event_at, "2025-09-08T00:00:00.000Z");
  assertEquals(evt?.values.match_method, "direct_job_id");
  assertEquals((evt?.values.payload as Record<string, unknown>).timestamp_source, "fully_paid_on");
});

Deno.test("capture-off still stamps deposit_at without writing business_events", async () => {
  const { client, writes } = fakeClient({ captureEnabled: false });
  const out = await applyDepositStamp(client, "org", paidInvoice(), new Date("2026-09-11T02:00:00.000Z"));
  assertEquals(out?.action, "stamped");
  assertEquals(
    writes.some((w) => w.table === "jobs" && w.op === "update" && w.values.deposit_at === "2025-09-08T00:00:00.000Z"),
    true,
  );
  assertEquals(writes.filter((w) => w.table === "business_events").length, 0);
});

Deno.test("a concurrent run that stamped first leaves us with no write and no event", async () => {
  const { client, writes } = fakeClient({ updateRows: [] });
  assertEquals(await applyDepositStamp(client, "org", paidInvoice()), null);
  assertEquals(writes.filter((w) => w.table === "business_events").length, 0);
});

Deno.test("applyDepositStamp on a voided invoice writes only a business event", async () => {
  const { client, writes } = fakeClient({ jobRow: job({ deposit_at: "2026-08-01T00:00:00.000Z" }) });
  const out = await applyDepositStamp(client, "org", paidInvoice({ Status: "VOIDED" }));
  assertEquals(out?.action, "contradiction_logged");
  assertEquals(writes.filter((w) => w.table === "jobs" && w.op === "update").length, 0);
  assertEquals(writes[0].values.event_type, "job.deposit_stamp_contradicted");
});

Deno.test("a contradiction already logged for this invoice is not logged again", async () => {
  const { client, writes } = fakeClient({
    jobRow: job({ deposit_at: "2026-08-01T00:00:00.000Z" }),
    contradictionLogged: true,
  });
  assertEquals(await applyDepositStamp(client, "org", paidInvoice({ Status: "VOIDED" })), null);
  assertEquals(writes.length, 0);
});

Deno.test("a failed contradiction lookup logs nothing rather than duplicating", async () => {
  const { client, writes } = fakeClient({
    jobRow: job({ deposit_at: "2026-08-01T00:00:00.000Z" }),
    contradictionLookupError: true,
  });
  assertEquals(await applyDepositStamp(client, "org", paidInvoice({ Status: "VOIDED" })), null);
  assertEquals(writes.length, 0);
});

Deno.test("applyDepositStamp: irrelevant invoice, missing job and failed lookup all write nothing", async () => {
  const a = fakeClient();
  assertEquals(await applyDepositStamp(a.client, "org", paidInvoice({ Status: "AUTHORISED" })), null);
  assertEquals(a.writes.length, 0);

  const b = fakeClient({ jobRow: null });
  assertEquals(await applyDepositStamp(b.client, "org", paidInvoice()), null);
  assertEquals(b.writes.length, 0);

  const c = fakeClient({ lookupError: true });
  assertEquals(await applyDepositStamp(c.client, "org", paidInvoice()), null);
  assertEquals(c.writes.length, 0);
});

Deno.test("deposit capture never presents operational fallback as payment source time", async () => {
  const { client, writes } = fakeClient();
  const now = new Date("2026-09-11T02:00:00.000Z");
  const inv = { ...paidInvoice(), FullyPaidOnDate: null, UpdatedDateUTC: null };
  await applyDepositStamp(client, "org", inv, now);
  assertEquals(writes.find((w) => w.table === "jobs")?.values.deposit_at, now.toISOString());
  const evt = writes.find((w) => w.table === "business_events");
  assertEquals(evt?.values.event_at, null);
  assertEquals(evt?.values.occurred_at, now.toISOString());
});
