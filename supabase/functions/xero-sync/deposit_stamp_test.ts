import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyDepositStamp,
  depositStampDecision,
  depositStampRelevant,
  xeroDateToIsoTimestamp,
} from "./deposit_stamp.ts";

const INV = "11111111-2222-3333-4444-555555555555";
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
  // Xero ids are case-stable but compare defensively.
  assertEquals(
    depositStampDecision(paidInvoice(), job({ deposit_invoice_id: INV.toUpperCase() }))?.action,
    "stamp",
  );
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

function fakeClient(jobRow: Record<string, unknown> | null, opts: { lookupError?: boolean } = {}) {
  const writes: Write[] = [];
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const filters: unknown[] = [];
    let pending: { op: string; values: Record<string, unknown> } | null = null;
    const self = () => chain;
    for (const k of ["eq", "is", "not", "select", "limit", "order"]) {
      chain[k] = (...args: unknown[]) => {
        filters.push([k, ...args]);
        return self();
      };
    }
    chain.maybeSingle = () =>
      Promise.resolve(
        opts.lookupError
          ? { data: null, error: { message: "boom" } }
          : { data: jobRow, error: null },
      );
    chain.update = (values: Record<string, unknown>) => {
      pending = { op: "update", values };
      const p: Record<string, unknown> = {};
      for (const k of ["eq", "is"]) {
        p[k] = (...args: unknown[]) => {
          filters.push([k, ...args]);
          return p;
        };
      }
      // deno-lint-ignore no-explicit-any
      (p as any).then = (res: (v: unknown) => unknown) => {
        writes.push({ table, op: "update", values, filters: [...filters] });
        return Promise.resolve(res({ error: null }));
      };
      return p;
    };
    chain.insert = (values: Record<string, unknown>) => {
      pending = { op: "insert", values };
      writes.push({ table, op: "insert", values, filters: [...filters] });
      return Promise.resolve({ error: null });
    };
    void pending;
    return chain;
  };
  return { client: { from: (t: string) => builder(t) }, writes };
}

Deno.test("applyDepositStamp writes deposit_at guarded on null, logs the event, leaves status alone", async () => {
  const { client, writes } = fakeClient(job());
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

  const evt = writes.find((w) => w.table === "business_events");
  assertEquals(evt?.values.event_type, "job.deposit_stamped");
  assertEquals((evt?.values.payload as Record<string, unknown>).timestamp_source, "fully_paid_on");
});

Deno.test("applyDepositStamp on a voided invoice writes only a business event", async () => {
  const { client, writes } = fakeClient(job({ deposit_at: "2026-08-01T00:00:00.000Z" }));
  const out = await applyDepositStamp(client, "org", paidInvoice({ Status: "VOIDED" }));
  assertEquals(out?.action, "contradiction_logged");
  assertEquals(writes.filter((w) => w.table === "jobs" && w.op === "update").length, 0);
  assertEquals(writes[0].values.event_type, "job.deposit_stamp_contradicted");
});

Deno.test("applyDepositStamp: irrelevant invoice, missing job and failed lookup all write nothing", async () => {
  const a = fakeClient(job());
  assertEquals(await applyDepositStamp(a.client, "org", paidInvoice({ Status: "AUTHORISED" })), null);
  assertEquals(a.writes.length, 0);

  const b = fakeClient(null);
  assertEquals(await applyDepositStamp(b.client, "org", paidInvoice()), null);
  assertEquals(b.writes.length, 0);

  const c = fakeClient(job(), { lookupError: true });
  assertEquals(await applyDepositStamp(c.client, "org", paidInvoice()), null);
  assertEquals(c.writes.length, 0);
});
