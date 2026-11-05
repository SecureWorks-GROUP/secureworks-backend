// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { captureAcceptanceDepositReceipt, prepareAcceptanceDepositDispatch } from "./acceptance_deposit_receipt.ts";
const id = (n: number) => `77000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1),
  JOB = id(2),
  DOC = id(3),
  REV = id(4),
  PAYER = id(5),
  INVOICE = id(6);
// Synthetic arithmetic only; no catalogue or job prices.
const amount = Math.round(Math.PI * 100) / 100;
async function fixture() {
  const tables: Record<string, any[]> = {
    job_documents: [{
      id: DOC,
      job_id: JOB,
      type: "quote",
      quote_revision_id: REV,
      accepted_at: "2026-11-04T00:00:00Z",
      sent_at: "2026-11-03T00:00:00Z",
      job_contact_id: null,
      run_label: null,
      superseded_at: null,
    }],
    quote_revisions: [{
      id: REV,
      job_id: JOB,
      job_document_id: DOC,
      sent_at: "2026-11-03T00:00:00Z",
      pricing_snapshot_json: {
        raw: {
          pricing_complete: true,
          payment_schedule: {
            version: 1,
            payments: [
              {
                id: "deposit",
                label: "First agreed payment",
                printed_terms: "On acceptance",
                amount_inc_gst: amount,
              },
              {
                id: "later",
                label: "Later payment",
                printed_terms: "Later",
                amount_inc_gst: amount,
              },
            ],
          },
        },
      },
    }],
    quote_invoice_billing_bindings: [{
      quote_revision_id: REV,
      job_id: JOB,
      org_id: ORG,
      xero_contact_id: PAYER,
      state: "eligible",
    }],
    quote_invoice_deposit_receipts: [],
  };
  const reads: string[] = [], inserts: any[] = [];
  const fail = new Set<string>();
  const client = {
    from(table: string) {
      assert(
        table in tables,
        "No mutable jobs, event heuristic or provider writer may be read",
      );
      const filters: [string, unknown][] = [];
      let inserted: any;
      const q: any = {
        select() {
          return q;
        },
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return q;
        },
        insert(row: any) {
          inserted = row;
          return q;
        },
        async maybeSingle() {
          reads.push(table);
          if (fail.has(table)) {
            return {
              error: { code: "unreadable" },
              data: null,
            };
          }
          return {
            error: null,
            data: structuredClone(
              tables[table].find((r) => filters.every(([k, v]) => r[k] === v)) ?? null,
            ),
          };
        },
        then(resolve: (r: any) => unknown) {
          assertEquals(table, "quote_invoice_deposit_receipts");
          inserts.push(structuredClone(inserted));
          if (fail.has("insert")) {
            return Promise.resolve({
              error: { code: "failed" },
            }).then(resolve);
          }
          if (
            tables[table].some((r) =>
              r.provider_invoice_id === inserted.provider_invoice_id ||
              (r.quote_revision_id === inserted.quote_revision_id &&
                r.stage_id === inserted.stage_id)
            )
          ) {
            return Promise.resolve({ error: { code: "23505" } }).then(resolve);
          }
          tables[table].push(structuredClone(inserted));
          if (fail.has("lost_insert_reply")) {
            return Promise.resolve({
              error: { code: "timeout" },
            }).then(resolve);
          }
          if (fail.has("readback")) fail.add(table);
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  const input: any = {
    orgId: ORG,
    jobId: JOB,
    documentId: DOC,
    creationResult: {
      success: true,
      job_id: JOB,
      xero_invoice_id: INVOICE,
      reference: "SYNTHETIC-ACCEPTANCE",
    },
  };
  const invoice: any = {
    InvoiceID: INVOICE,
    Type: "ACCREC",
    Status: "AUTHORISED",
    CurrencyCode: "AUD",
    Contact: { ContactID: PAYER },
    Total: amount,
    Reference: input.creationResult.reference,
  };
  let gets = 0;
  const deps = {
    readInvoice: async (providerId: string) => {
      gets++;
      assertEquals(providerId, INVOICE);
      if (fail.has("provider")) throw Error("unknown");
      return structuredClone(invoice);
    },
  };
  const plan = await prepareAcceptanceDepositDispatch(
    client,
    {
      orgId: ORG,
      jobId: JOB,
      documentId: DOC,
      reference: input.creationResult.reference,
    },
    async () => ({
      Invoices: [],
      pagination: { page: 1, pageSize: 100, pageCount: 0, itemCount: 0 },
    }),
  );
  assertEquals(plan.state, "prepared");
  if (plan.state === "prepared") input.dispatchToken = plan.token;
  return {
    tables,
    client,
    input,
    invoice,
    deps,
    fail,
    reads,
    inserts,
    gets: () => gets,
  };
}
Deno.test("receipt: exact accepted frozen payment and actual create result bind after provider GET, replay never updates", async () => {
  const f = await fixture();
  const first = await captureAcceptanceDepositReceipt(
    f.client,
    f.input,
    f.deps,
  );
  assertEquals(first.state, "captured");
  assertEquals(f.gets(), 1);
  assertEquals(f.inserts.length, 1);
  const row = f.tables.quote_invoice_deposit_receipts[0];
  assertEquals([
    row.accepted_document_id,
    row.quote_revision_id,
    row.xero_contact_id,
    row.stage_id,
    row.amount_cents,
  ], [DOC, REV, PAYER, "deposit", Math.round(amount * 100)]);
  const second = await captureAcceptanceDepositReceipt(
    f.client,
    f.input,
    f.deps,
  );
  assertEquals(second.state, "captured");
  assertEquals("reused" in second && second.reused, true);
  assertEquals(f.inserts.length, 1);
});
Deno.test("receipt: missing/foreign/unaccepted/latest-only/party documents never acquire metadata authority", async () => {
  for (
    const patch of [
      { quote_revision_id: null },
      { job_id: id(30) },
      { accepted_at: null },
      { sent_at: null },
      { sent_at: "2026-11-05T00:00:00Z" },
      { sent_at: "malformed" },
      { superseded_at: "later" },
      { job_contact_id: id(31) },
      { run_label: "REAR" },
    ]
  ) {
    const f = await fixture();
    Object.assign(f.tables.job_documents[0], patch);
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "held",
    );
    assertEquals(f.gets(), 0);
    assertEquals(f.inserts.length, 0);
  }
  for (
    const patch of [{ job_document_id: id(32) }, { sent_at: null }, {
      sent_at: "2026-11-05T00:00:00Z",
    }, { job_id: id(33) }]
  ) {
    const f = await fixture();
    Object.assign(f.tables.quote_revisions[0], patch);
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "held",
    );
    assertEquals(f.gets(), 0);
  }
});
Deno.test("receipt: frozen payer and first printed stage are mandatory; no default percent or mutable price fallback", async () => {
  for (
    const change of [
      (f: any) => f.tables.quote_invoice_billing_bindings[0].state = "held",
      (f: any) => f.tables.quote_invoice_billing_bindings[0].xero_contact_id = null,
      (f: any) => f.tables.quote_revisions[0].pricing_snapshot_json.raw.pricing_complete = false,
      (f: any) =>
        f.tables.quote_revisions[0].pricing_snapshot_json.raw.payment_schedule
          .payments[0].amount_inc_gst = null,
      (f: any) =>
        f.tables.quote_revisions[0].pricing_snapshot_json.raw.payment_schedule
          .payments[0].id = "",
      (f: any) =>
        f.tables.quote_revisions[0].pricing_snapshot_json.raw.payment_schedule
          .payments[1].id = "deposit",
    ]
  ) {
    const f = await fixture();
    change(f);
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "held",
    );
    assertEquals(f.gets(), 0);
    assertEquals(f.inserts.length, 0);
  }
});
Deno.test("receipt: provider id/type/status/currency/payer/reference/gross amount must all match; paid remains valid", async () => {
  for (
    const patch of [
      { InvoiceID: id(20) },
      { Type: "ACCPAY" },
      { Status: "DRAFT" },
      { Status: "VOIDED" },
      { CurrencyCode: "NZD" },
      { Contact: { ContactID: id(21) } },
      { Total: amount + 1 },
      { Total: null },
      { Reference: "another" },
    ]
  ) {
    const f = await fixture();
    Object.assign(f.invoice, patch);
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "held",
    );
    assertEquals(f.inserts.length, 0);
  }
  const f = await fixture();
  f.invoice.Status = "PAID";
  assertEquals(
    (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
    "captured",
  );
});
Deno.test("receipt: unknown provider/read/persistence outcomes hold; retry only reads/inserts metadata, never creates", async () => {
  for (
    const fault of [
      "provider",
      "job_documents",
      "quote_revisions",
      "quote_invoice_billing_bindings",
      "quote_invoice_deposit_receipts",
      "insert",
      "readback",
      "lost_insert_reply",
    ]
  ) {
    const f = await fixture();
    f.fail.add(fault);
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "held",
    );
    f.fail.clear();
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
      "captured",
    );
    assertEquals(f.tables.quote_invoice_deposit_receipts.length, 1);
  }
});
Deno.test("receipt: conflicting provider or source binding is held without overwrite", async () => {
  const f = await fixture();
  await captureAcceptanceDepositReceipt(f.client, f.input, f.deps);
  f.tables.quote_invoice_deposit_receipts[0].quote_revision_id = id(40);
  const before = structuredClone(f.tables.quote_invoice_deposit_receipts);
  assertEquals(
    (await captureAcceptanceDepositReceipt(f.client, f.input, f.deps)).state,
    "held",
  );
  assertEquals(f.tables.quote_invoice_deposit_receipts, before);
  assertEquals(f.inserts.length, 1);
});
Deno.test("receipt: concurrent identical capture converges; body/job pointer cannot replace the create-result identity", async () => {
  const f = await fixture();
  const answers = await Promise.all(
    Array.from(
      { length: 4 },
      () => captureAcceptanceDepositReceipt(f.client, f.input, f.deps),
    ),
  );
  assert(answers.every((r) => r.state === "captured"));
  assertEquals(f.tables.quote_invoice_deposit_receipts.length, 1);
  for (
    const patch of [
      { creationResult: null },
      { creationResult: { xero_invoice_id: INVOICE } },
      { documentId: null },
      { partyId: id(41) },
      { runLabel: "REAR" },
    ]
  ) {
    const bad = await fixture();
    assertEquals(
      (await captureAcceptanceDepositReceipt(bad.client, {
        ...bad.input,
        ...patch,
      }, bad.deps)).state,
      "held",
    );
    assertEquals(bad.gets(), 0);
  }
});

Deno.test("receipt: legacy reused ID, unreadable/incomplete pre-read and forged provenance never bind", async () => {
  const f = await fixture();
  for (
    const page of [
      {
        Invoices: [{ InvoiceID: INVOICE }],
        pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 },
      },
      {
        Invoices: [],
        pagination: { page: 1, pageSize: 100, pageCount: 2, itemCount: 101 },
      },
      { Invoices: [] },
    ]
  ) {
    const plan = await prepareAcceptanceDepositDispatch(f.client, {
      orgId: ORG,
      jobId: JOB,
      documentId: DOC,
      reference: f.input.creationResult.reference,
    }, async () => page);
    assertEquals(plan.state, "held");
  }
  const forged = await captureAcceptanceDepositReceipt(f.client, {
    ...f.input,
    dispatchToken: {},
  }, f.deps);
  assertEquals(forged.state, "held");
  assertEquals(f.gets(), 0);
  assertEquals(f.inserts.length, 0);
  await captureAcceptanceDepositReceipt(f.client, f.input, f.deps);
  const replay = await prepareAcceptanceDepositDispatch(
    f.client,
    {
      orgId: ORG,
      jobId: JOB,
      documentId: DOC,
      reference: f.input.creationResult.reference,
    },
    async () => ({
      Invoices: [{ InvoiceID: INVOICE }],
      pagination: { page: 1, pageSize: 100, pageCount: 1, itemCount: 1 },
    }),
  );
  assertEquals(replay.state, "prepared");
  if (replay.state === "prepared") {
    assertEquals(
      (await captureAcceptanceDepositReceipt(f.client, {
        ...f.input,
        dispatchToken: replay.token,
      }, f.deps)).state,
      "captured",
    );
  }
  assertEquals(f.tables.quote_invoice_deposit_receipts.length, 1);
});
