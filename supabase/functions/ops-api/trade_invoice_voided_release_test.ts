import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertUnpaidVoidedSupplierBill,
  releaseVoidedTradeInvoice,
  VoidedTradeInvoiceReleaseError,
} from "./trade_invoice_voided_release.ts";

const BILL = "10000000-0000-4000-8000-000000000001";
const INVOICE = "20000000-0000-4000-8000-000000000001";
const ORG = "30000000-0000-4000-8000-000000000001";
type Row = Record<string, any>;
const provider = (): Row => ({
  InvoiceID: BILL,
  Type: "ACCPAY",
  Status: "VOIDED",
  AmountPaid: 0,
});

class Office {
  invoice: Row = {
    id: INVOICE,
    org_id: ORG,
    user_id: "worker",
    status: "pushed_to_xero",
    xero_bill_id: BILL,
    amount_paid: 0,
    paid_at: null,
    override_details: { kept: "history" },
    query_note: "Original note",
  };
  lines: Row[] = [{ id: "line", line_type: "labour", group_share_id: null }];
  writes = 0;
  reads = 0;
  providerReads = 0;
  providerBill = provider();
  failRead = false;
  beforeCommit = () => {};
  client() {
    return {
      from: (table: string) => {
        const filters: ((r: Row) => boolean)[] = [];
        let patch: Row | null = null;
        const q = {
          select: () => q,
          eq: (key: string, value: unknown) => {
            filters.push((r) =>
              key === "override_details"
                ? JSON.stringify(r[key]) === value
                : r[key] === value
            );
            return q;
          },
          is: (key: string, value: unknown) => {
            filters.push((r) => r[key] === value);
            return q;
          },
          update: (value: Row) => {
            patch = value;
            return q;
          },
          maybeSingle: () => q,
          then: (resolve: (r: unknown) => unknown) => {
            this.reads++;
            if (this.failRead) {
              return Promise.resolve({
                data: null,
                error: { message: "unreadable" },
              }).then(resolve);
            }
            if (table === "trade_invoice_lines") {
              return Promise.resolve({ data: this.lines, error: null }).then(
                resolve,
              );
            }
            if (patch) this.beforeCommit();
            const matched = filters.every((f) => f(this.invoice));
            if (matched && patch) {
              this.writes++;
              Object.assign(this.invoice, patch);
            }
            return Promise.resolve({
              data: matched ? { ...this.invoice } : null,
              error: null,
            }).then(resolve);
          },
        };
        return q;
      },
    };
  }
  run(body: Row = {}, allowed = true, orgId = ORG) {
    return releaseVoidedTradeInvoice(
      this.client(),
      {
        invoice_id: INVOICE,
        expected_xero_bill_id: BILL,
        reason: "Owner correction",
        confirm: true,
        ...body,
      },
      { allowed, orgId, actor: "user:office" },
      {
        getToken: () =>
          Promise.resolve({ accessToken: "test", tenantId: "tenant" }),
        xeroGet: () => {
          this.providerReads++;
          return Promise.resolve({ Invoices: [this.providerBill] });
        },
      },
    );
  }
}

Deno.test("void release retains original claims and external identity, releases once, and records proof atomically", async () => {
  const db = new Office();
  const before = JSON.stringify(db.lines);
  const result = await db.run();
  assertEquals(result.status, "ops-reject");
  assertEquals(db.writes, 1);
  assertEquals(db.invoice.xero_bill_id, BILL);
  assertEquals(JSON.stringify(db.lines), before);
  assertEquals(db.invoice.override_details.kept, "history");
  assertEquals(
    db.invoice.override_details.voided_release.prior_query_note,
    "Original note",
  );
  assertEquals(db.invoice.override_details.voided_release.actor, "user:office");
  assertEquals((await db.run()).already_released, true);
  assertEquals(db.writes, 1);
  assertEquals(
    db.providerReads,
    2,
    "even replay reads the provider, never trusts a mirror",
  );
});

Deno.test("void release refuses unverified, paid, credited, missing and group bills without changing claims", async () => {
  for (
    const bill of [
      { ...provider(), Status: "AUTHORISED" },
      { ...provider(), Status: "PAID" },
      { ...provider(), Status: "DRAFT" },
      { ...provider(), Type: "ACCREC" },
      { ...provider(), InvoiceID: "other" },
      { ...provider(), AmountPaid: 1 },
      { ...provider(), AmountPaid: null },
      { ...provider(), AmountCredited: 1 },
      { ...provider(), Payments: [{ BatchPaymentID: "batch" }] },
      { ...provider(), CreditNotes: [{}] },
      { ...provider(), Overpayments: [{}] },
      { ...provider(), Prepayments: [{}] },
      { ...provider(), BatchPaymentID: "batch" },
      { ...provider(), Payments: {} },
    ]
  ) {
    const db = new Office();
    db.providerBill = bill;
    await assertRejects(() => db.run(), VoidedTradeInvoiceReleaseError);
    assertEquals(db.writes, 0);
  }
  for (
    const change of [
      "local-paid",
      "group",
      "unreadable",
      "wrong-org",
      "identity",
      "no-confirm",
    ]
  ) {
    const db = new Office();
    if (change === "local-paid") db.invoice.amount_paid = 1;
    if (change === "group") db.lines[0].group_share_id = "share";
    if (change === "unreadable") db.failRead = true;
    if (change === "identity") db.invoice.xero_bill_id = "other";
    await assertRejects(
      () =>
        db.run(
          change === "no-confirm" ? { confirm: false } : {},
          true,
          change === "wrong-org" ? "other" : ORG,
        ),
      VoidedTradeInvoiceReleaseError,
    );
    assertEquals(db.writes, 0);
    assertEquals(db.providerReads, 0);
  }
});

Deno.test("void release denies a trade or routine caller before reading records", async () => {
  const db = new Office();
  await assertRejects(() => db.run({}, false), VoidedTradeInvoiceReleaseError);
  assertEquals(db.reads, 0);
  assertEquals(db.providerReads, 0);
  assertEquals(db.writes, 0);
});

Deno.test("a payment or review racing the release prevents the local write", async () => {
  for (const change of ["payment", "note", "history", "bill"]) {
    const db = new Office();
    db.beforeCommit = () => {
      if (change === "payment") {
        db.invoice.status = "paid";
        db.invoice.amount_paid = 1;
      }
      if (change === "note") db.invoice.query_note = "Office updated review";
      if (change === "history") {
        db.invoice.override_details = { other: "review" };
      }
      if (change === "bill") db.invoice.xero_bill_id = "new-bill";
    };
    await assertRejects(
      () => db.run(),
      VoidedTradeInvoiceReleaseError,
      "changed during release",
    );
    assertEquals(db.writes, 0);
  }
});

Deno.test("missing provider AmountPaid cannot be interpreted as zero", () => {
  const bill = provider();
  delete bill.AmountPaid;
  assertThrows(
    () => assertUnpaidVoidedSupplierBill(bill, BILL),
    VoidedTradeInvoiceReleaseError,
  );
});

Deno.test("a deleted bill with nothing paid releases like a voided one and says deleted", async () => {
  const db = new Office();
  db.providerBill = { ...provider(), Status: "DELETED" };
  const result = await db.run();
  assertEquals(result.status, "ops-reject");
  assertEquals(result.xero_bill_status, "DELETED");
  assertEquals(db.invoice.xero_bill_status, "DELETED");
  assertEquals(db.invoice.xero_bill_id, BILL);
  assertEquals(db.invoice.override_details.voided_release.automatic, false);
  assertEquals(db.invoice.query_note.startsWith("Xero bill deleted with nothing paid."), true);
});

Deno.test("an approved invoice holding a deleted bill can be released", async () => {
  const db = new Office();
  db.invoice.status = "approved";
  db.providerBill = { ...provider(), Status: "DELETED" };
  const result = await db.run();
  assertEquals(result.status, "ops-reject");
  assertEquals(db.invoice.override_details.voided_release.prior_status, "approved");
});
