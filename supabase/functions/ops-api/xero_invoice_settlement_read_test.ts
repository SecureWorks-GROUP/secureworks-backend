// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  projectXeroSettlementEvidence,
  type SettlementEvidence,
} from "../_shared/xero_settlement_evidence.ts";
import {
  invoiceSettlementRead,
  readInvoiceSettlement,
} from "./xero_invoice_settlement_read.ts";
import { settlementFakeClient } from "./xero_settlement_test_fake.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const INV = "33333333-3333-4333-8333-333333333333";
const SIBLING = "44444444-4444-4444-8444-444444444444";
const PAY_A = "55555555-5555-4555-8555-555555555555";
const PAY_B = "66666666-6666-4666-8666-666666666666";
const BATCH = "77777777-7777-4777-8777-777777777777";
const BANK = { AccountID: "88888888-8888-4888-8888-888888888888" };
const AT = new Date().toISOString();

function payment(id: string, over: Record<string, unknown> = {}) {
  return projectXeroSettlementEvidence(
    {
      PaymentID: id,
      PaymentType: "ACCRECPAYMENT",
      Invoice: { InvoiceID: INV, Type: "ACCREC", CurrencyCode: "AUD" },
      Date: "/Date(1760400000000+0000)/",
      Amount: 100,
      Account: BANK,
      IsReconciled: true,
      Status: "AUTHORISED",
      ...over,
    },
    "payment",
    ORG,
    TENANT,
    AT,
  );
}
function batch(over: Record<string, unknown> = {}) {
  return projectXeroSettlementEvidence(
    {
      BatchPaymentID: BATCH,
      Type: "RECBATCH",
      TotalAmount: 300,
      Account: BANK,
      IsReconciled: true,
      Status: "AUTHORISED",
      Payments: [
        { PaymentID: PAY_A, Invoice: { InvoiceID: INV }, Amount: 100 },
        {
          PaymentID: "99999999-9999-4999-8999-999999999999",
          Invoice: { InvoiceID: SIBLING },
          Amount: 200,
        },
      ],
      ...over,
    },
    "batch_payment",
    ORG,
    TENANT,
    AT,
  );
}
const invoice = (amount_paid: number | null, ids: string[]) => ({
  xero_invoice_id: INV,
  amount_paid,
  currency_code: "AUD",
  payments: ids.map((PaymentID) => ({ PaymentID })),
});
const proof = (
  inv: ReturnType<typeof invoice>,
  ev: SettlementEvidence[],
  err?: string,
) => invoiceSettlementRead(inv, ev, err ?? null).bank_proof;

Deno.test("settlement read: reconciled payments read true, an unreconciled one reads false", () => {
  assertEquals(proof(invoice(100, [PAY_A]), [payment(PAY_A)]).reconciled, true);
  const mixed = proof(invoice(200, [PAY_A, PAY_B]), [
    payment(PAY_A),
    payment(PAY_B, { IsReconciled: false }),
  ]);
  assertEquals([mixed.reconciled, mixed.unknown_reasons], [false, []]);
});

Deno.test("settlement read: batched payment needs its batch, and a missing or conflicting batch is unknown", () => {
  const p = payment(PAY_A, { BatchPaymentID: BATCH });
  const known = invoiceSettlementRead(invoice(100, [PAY_A]), [p, batch()]);
  assertEquals(known.bank_proof.reconciled, true);
  assertEquals(known.observed_payment_amount, 100);
  assertEquals(known.batches.map((b) => b.total_amount), [300]);

  const missing = proof(invoice(100, [PAY_A]), [p]);
  assertEquals([missing.reconciled, missing.unknown_reason], [
    null,
    "batch_evidence_missing",
  ]);
  const flag = proof(invoice(100, [PAY_A]), [
    p,
    batch({ IsReconciled: false }),
  ]);
  assertEquals([flag.reconciled, flag.unknown_reason], [
    null,
    "batch_reconciliation_conflict",
  ]);
  const allocation = proof(invoice(100, [PAY_A]), [
    p,
    batch({
      Payments: [{ PaymentID: PAY_A, Invoice: { InvoiceID: INV }, Amount: 90 }],
    }),
  ]);
  assertEquals(allocation.unknown_reason, "batch_allocation_conflict");
});

Deno.test("settlement read: a paid amount that payments do not add up to is unknown", () => {
  const r = proof(invoice(150, [PAY_A]), [payment(PAY_A)]);
  assertEquals([r.reconciled, r.unknown_reasons], [null, [
    "payment_total_differs_from_invoice_paid",
  ]]);
});

Deno.test("settlement read: a deleted payment stays visible but adds no paid cash", () => {
  const read = invoiceSettlementRead(invoice(100, [PAY_A, PAY_B]), [
    payment(PAY_A),
    payment(PAY_B, { Status: "DELETED", IsReconciled: false }),
  ]);
  assertEquals(read.observed_payment_amount, 100);
  assertEquals(read.payments.map((p) => p.status), ["AUTHORISED", "DELETED"]);
  assertEquals(read.bank_proof.reconciled, true);
});

Deno.test("settlement read: an embedded payment with no stored evidence and a read fault are unknown", () => {
  const missing = proof(invoice(100, [PAY_A, PAY_B]), [payment(PAY_A)]);
  assertEquals(missing.unknown_reason, "embedded_payment_evidence_missing");
  const fault = proof(
    invoice(100, [PAY_A]),
    [payment(PAY_A)],
    "payment_evidence_read_failed",
  );
  assertEquals([fault.reconciled, fault.unknown_reason], [
    null,
    "payment_evidence_read_failed",
  ]);
});

function store(invoiceType = "ACCREC") {
  return {
    xero_invoices: [{
      org_id: ORG,
      invoice_type: invoiceType,
      ...invoice(100, [PAY_A]),
    }],
    xero_tokens: [{ org_id: ORG, tenant_id: TENANT }],
    xero_settlement_evidence: [
      payment(PAY_A, { BatchPaymentID: BATCH }),
      batch(),
    ] as unknown as Record<string, unknown>[],
  };
}

Deno.test("readInvoiceSettlement: reads stored payment and batch evidence for the org's tenant", async () => {
  const { client } = settlementFakeClient(store());
  const read = await readInvoiceSettlement(client, ORG, INV.toUpperCase());
  assertEquals(read?.bank_proof.reconciled, true);
  assertEquals(read?.batches.length, 1);
});

Deno.test("readInvoiceSettlement: an unknown or purchase invoice is not found, not a fault", async () => {
  assertEquals(
    await readInvoiceSettlement(
      settlementFakeClient(store("ACCPAY")).client,
      ORG,
      INV,
    ),
    null,
  );
  assertEquals(
    await readInvoiceSettlement(
      settlementFakeClient(store()).client,
      ORG,
      SIBLING,
    ),
    null,
  );
});

Deno.test("readInvoiceSettlement: an unreadable evidence table reads unknown, never an all-clear", async () => {
  const { client } = settlementFakeClient(store(), {
    select: new Set(["xero_settlement_evidence"]),
  });
  const read = await readInvoiceSettlement(client, ORG, INV);
  assertEquals([
    read?.bank_proof.reconciled,
    read?.bank_proof.unknown_reasons.includes("payment_evidence_read_failed"),
  ], [null, true]);
});

Deno.test("payment date is the provider's own date, whatever the local timezone", () => {
  assertEquals(
    payment(PAY_A, { DateString: "2026-10-14T00:00:00" }).payment_date,
    "2026-10-14",
  );
  assertEquals(payment(PAY_A).payment_date, "2025-10-14");
});

Deno.test("settlement read: active payment and batch observations expire after 26 hours", () => {
  const now = Date.parse(AT);
  const boundary = new Date(now - 26 * 60 * 60 * 1000).toISOString();
  const stale = new Date(Date.parse(boundary) - 1).toISOString();
  for (const reconciled of [true, false]) {
    const p = {
      ...payment(PAY_A, { BatchPaymentID: BATCH, IsReconciled: reconciled }),
      captured_at: boundary,
    };
    const b = { ...batch({ IsReconciled: reconciled }), captured_at: boundary };
    assertEquals(
      invoiceSettlementRead(invoice(100, [PAY_A]), [p, b], null, now)
        .bank_proof.reconciled,
      reconciled,
    );
    for (
      const rows of [
        [{ ...p, captured_at: stale }, b],
        [p, { ...b, captured_at: stale }],
      ]
    ) {
      const result = invoiceSettlementRead(
        invoice(100, [PAY_A]),
        rows,
        null,
        now,
      );
      assertEquals(result.bank_proof.reconciled, null);
      assertEquals(result.bank_proof.unknown_reasons, [
        "settlement_evidence_stale",
      ]);
    }
  }
});

Deno.test("settlement read: stale deleted payments and unrelated batches do not expire active proof", () => {
  const stale = "2026-01-02T00:00:00.000Z";
  const result = invoiceSettlementRead(
    invoice(100, [PAY_A, PAY_B]),
    [
      payment(PAY_A),
      { ...payment(PAY_B, { Status: "DELETED" }), captured_at: stale },
      { ...batch(), captured_at: stale },
    ],
    null,
    Date.parse(AT),
  );
  assertEquals(result.bank_proof.reconciled, true);
  assertEquals(result.bank_proof.unknown_reasons, []);
});
