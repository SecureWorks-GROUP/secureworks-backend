import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { correctXeroLineCoding } from "./xero_line_corrections.ts";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const COLLECTION: Record<string, [string, string]> = {
  invoice: ["Invoices", "InvoiceID"],
  credit_note: ["CreditNotes", "CreditNoteID"],
  bank_transaction: ["BankTransactions", "BankTransactionID"],
};
const ACCOUNTS = [
  { AccountID: id(31), Code: "305", Class: "EXPENSE", Type: "DIRECTCOSTS", Status: "ACTIVE" },
  { AccountID: id(32), Code: "306", Class: "EXPENSE", Type: "DIRECTCOSTS", Status: "ACTIVE" },
  { AccountID: id(33), Code: "433", Class: "EXPENSE", Type: "OVERHEADS", Status: "ACTIVE" },
  { AccountID: id(34), Code: "200", Class: "REVENUE", Type: "SALES", Status: "ACTIVE" },
  { AccountID: id(35), Code: "999", Class: "EXPENSE", Type: "OVERHEADS", Status: "ARCHIVED" },
  { AccountID: id(36), Code: "820", Class: "EXPENSE", Type: "EXPENSE", Status: "ACTIVE", SystemAccount: "GST" },
  { AccountID: id(37), Code: "090", Class: "ASSET", Type: "BANK", Status: "ACTIVE" },
];

function fixture(kind = "invoice", type = "ACCPAY", status = "PAID") {
  const [collection, idField] = COLLECTION[kind];
  let record: any = {
    [idField]: id(1),
    Type: type,
    Status: status,
    LineAmountTypes: "Inclusive",
    Total: 110,
    SubTotal: 100,
    TotalTax: 10,
    Contact: { ContactID: id(8) },
    LineItems: [{
      LineItemID: id(2),
      Description: "Materials",
      Quantity: 1,
      UnitAmount: 110,
      LineAmount: 110,
      TaxAmount: 10,
      TaxType: "INPUT",
      AccountCode: "305",
      AccountID: id(31),
      Tracking: [],
    }, {
      LineItemID: id(3),
      Description: "Freight",
      Quantity: 1,
      UnitAmount: 0,
      LineAmount: 0,
      AccountCode: "305",
      Tracking: [],
    }],
  };
  if (kind === "bank_transaction") {
    record.BankAccount = { AccountID: id(20), Code: "090" };
    record.IsReconciled = true;
  } else {
    record.Payments = [{ PaymentID: id(9), Amount: 110 }];
  }
  let writes = 0;
  let captured: any;
  let mode: "ok" | "timeout" | "refuse" | "unreconcile" | "warn" = "ok";
  const deps = {
    authorized: true,
    getToken: async () => ({ accessToken: "test", tenantId: id(10) }),
    xeroGet: async (path: string) => {
      if (path === "/TrackingCategories") {
        return {
          TrackingCategories: [{
            TrackingCategoryID: id(4),
            Name: "Business Unit",
            Status: "ACTIVE",
            Options: [{ TrackingOptionID: id(5), Name: "SW - PATIOS", Status: "ACTIVE" }],
          }],
        };
      }
      if (path === "/Accounts") return { Accounts: structuredClone(ACCOUNTS) };
      return { [collection]: [structuredClone(record)] };
    },
    xeroPost: async (_p: string, _a: string, _t: string, body: any) => {
      writes++;
      captured = body;
      if (mode === "timeout") throw Error("timeout");
      if (mode === "refuse") {
        throw Error("Xero validation error: This transaction cannot be edited");
      }
      // Xero returns AccountID for the account each line now carries.
      record.LineItems = body[collection][0].LineItems.map((l: any, i: number) =>
        i === 0
          ? { ...l, AccountID: ACCOUNTS.find((a) => a.Code === l.AccountCode)?.AccountID }
          : { ...l }
      );
      if (mode === "unreconcile") record.IsReconciled = false;
      const returned: any = structuredClone(record);
      if (mode === "warn") {
        returned.StatusAttributeString = "WARNING";
        returned.Warnings = [{ Message: "Some fields cannot be changed" }];
      }
      return { [collection]: [returned] };
    },
  };
  const body: any = {
    mode: "preview",
    tenant_id: id(10),
    record: {
      kind,
      id: id(1),
      changes: [{
        line_item_id: id(2),
        tracking_category_id: id(4),
        tracking_option_id: id(5),
      }],
    },
  };
  return {
    deps,
    body,
    get record() {
      return record;
    },
    get writes() {
      return writes;
    },
    get captured() {
      return captured;
    },
    set mode(m: typeof mode) {
      mode = m;
    },
  };
}

async function applyInput(f: ReturnType<typeof fixture>) {
  const preview = await correctXeroLineCoding(null, f.body, f.deps);
  assertEquals(preview.result.state, "preview");
  return {
    ...f.body,
    mode: "apply",
    confirm: true,
    record: {
      ...f.body.record,
      expected_snapshot_hash: preview.result.expected_snapshot_hash,
    },
  };
}

Deno.test("preview writes nothing; discovery takes empty changes; preview refuses confirm or hash", async () => {
  const f = fixture();
  const discovery = await correctXeroLineCoding(
    null,
    { ...f.body, record: { ...f.body.record, changes: [] } },
    f.deps,
  );
  assertEquals(discovery.ok, true);
  assertEquals(discovery.result.before.LineItems.length, 2);
  const preview = await correctXeroLineCoding(null, f.body, f.deps);
  assertEquals(preview.result.summary[0].to.business_unit, "SW - PATIOS");
  assertEquals(f.writes, 0);
  await assertRejects(() =>
    correctXeroLineCoding(null, { ...f.body, confirm: true }, f.deps)
  );
  await assertRejects(() =>
    correctXeroLineCoding(
      null,
      { ...f.body, record: { ...f.body.record, expected_snapshot_hash: "a".repeat(64) } },
      f.deps,
    )
  );
});

Deno.test("reconciled bank spend: tracking changes, reconciliation and money survive", async () => {
  const f = fixture("bank_transaction", "SPEND", "AUTHORISED");
  const result = await correctXeroLineCoding(null, await applyInput(f), f.deps);
  assertEquals(result.result.state, "verified");
  assertEquals(result.ok, true);
  assertEquals(f.writes, 1);
  const sent = f.captured.BankTransactions[0];
  assertEquals(sent.BankTransactionID, id(1));
  assertEquals(sent.BankAccount, { AccountID: id(20) });
  assertEquals(sent.Contact, { ContactID: id(8) });
  assertEquals(sent.IsReconciled, undefined);
  assertEquals(sent.Status, undefined);
  assertEquals(sent.LineItems.length, 2);
  assertEquals(f.record.IsReconciled, true);
  assertEquals(f.record.LineItems[0].Tracking[0].Option, "SW - PATIOS");
  assertEquals(result.result.readback_verification.preserved, true);
});

Deno.test("receive money and credit notes are supported kinds", async () => {
  for (
    const [kind, type, status] of [
      ["bank_transaction", "RECEIVE", "AUTHORISED"],
      ["credit_note", "ACCPAYCREDIT", "PAID"],
      ["credit_note", "ACCRECCREDIT", "AUTHORISED"],
      ["invoice", "ACCREC", "PAID"],
    ]
  ) {
    const f = fixture(kind, type, status);
    const result = await correctXeroLineCoding(null, await applyInput(f), f.deps);
    assertEquals(result.result.state, "verified", `${kind} ${type}`);
    assertEquals(f.writes, 1);
  }
});

Deno.test("account recode moves a bill line within the same class and keeps tax and money", async () => {
  const f = fixture();
  f.body.record.changes = [{ line_item_id: id(2), account_code: "433" }];
  const result = await correctXeroLineCoding(null, await applyInput(f), f.deps);
  assertEquals(result.result.state, "verified");
  const line = f.captured.Invoices[0].LineItems[0];
  assertEquals(line.AccountCode, "433");
  assertEquals(line.AccountID, undefined);
  assertEquals(line.TaxType, "INPUT");
  assertEquals(line.TaxAmount, 10);
  assertEquals(line.LineAmount, 110);
  assertEquals(f.record.Payments[0].Amount, 110);
  assertEquals(result.result.summary[0].from.account_code, "305");
  assertEquals(result.result.summary[0].to.account_code, "433");
});

Deno.test("one change can carry both a tracking pair and an account code", async () => {
  const f = fixture("bank_transaction", "SPEND", "AUTHORISED");
  f.body.record.changes = [{
    line_item_id: id(2),
    tracking_category_id: id(4),
    tracking_option_id: id(5),
    account_code: "306",
  }];
  const result = await correctXeroLineCoding(null, await applyInput(f), f.deps);
  assertEquals(result.result.state, "verified");
  assertEquals(f.record.LineItems[0].AccountCode, "306");
  assertEquals(f.record.LineItems[0].Tracking[0].Option, "SW - PATIOS");
});

Deno.test("recode refuses other classes, archived, system and bank accounts, with zero writes", async () => {
  for (const code of ["200", "999", "820", "090", "404"]) {
    const f = fixture();
    f.body.record.changes = [{ line_item_id: id(2), account_code: code }];
    const preview = await correctXeroLineCoding(null, f.body, f.deps);
    assertEquals(preview.result.state, "rejected", code);
    assertEquals(preview.result.code, "ACCOUNT_RECODE_INVALID", code);
    assertEquals(f.writes, 0);
  }
});

Deno.test("an unreconciled readback fails verification", async () => {
  const f = fixture("bank_transaction", "SPEND", "AUTHORISED");
  const body = await applyInput(f);
  f.mode = "unreconcile";
  const result = await correctXeroLineCoding(null, body, f.deps);
  assertEquals(result.ok, false);
  assertEquals(result.result.state, "verification_failed");
  assert(
    result.result.verification_reasons.includes("READBACK_PRESERVATION_MISMATCH"),
  );
});

Deno.test("Xero's standard warning with a clean readback is a verified write", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.mode = "warn";
  const result = await correctXeroLineCoding(null, body, f.deps);
  assertEquals(result.ok, true);
  assertEquals(result.result.state, "verified_with_provider_warning");
});

Deno.test("a 4xx refusal with an unchanged record is refused_unchanged; a timeout stays unknown", async () => {
  const refused = fixture("bank_transaction", "SPEND", "AUTHORISED");
  const body = await applyInput(refused);
  refused.mode = "refuse";
  const r = await correctXeroLineCoding(null, body, refused.deps);
  assertEquals(r.result.state, "refused_unchanged");
  assertEquals(r.result.code, "PROVIDER_REFUSED");
  assertEquals(refused.writes, 1);
  const lost = fixture();
  const lostBody = await applyInput(lost);
  lost.mode = "timeout";
  const u = await correctXeroLineCoding(null, lostBody, lost.deps);
  assertEquals(u.result.state, "unknown");
  assertEquals(lost.writes, 1);
});

Deno.test("stale snapshot prevents the write", async () => {
  const f = fixture();
  const body = await applyInput(f);
  f.record.Total = 111;
  const r = await correctXeroLineCoding(null, body, f.deps);
  assertEquals(r.result.code, "SNAPSHOT_CONFLICT");
  assertEquals(f.writes, 0);
});

Deno.test("wrong record types and states are refused", async () => {
  for (
    const [kind, type, status] of [
      ["invoice", "ACCPAY", "DRAFT"],
      ["invoice", "ACCPAY", "VOIDED"],
      ["bank_transaction", "SPEND-TRANSFER", "AUTHORISED"],
      ["bank_transaction", "SPEND-OVERPAYMENT", "AUTHORISED"],
      ["bank_transaction", "SPEND", "DELETED"],
      ["credit_note", "ACCPAY", "PAID"],
    ]
  ) {
    const f = fixture(kind, type, status);
    const r = await correctXeroLineCoding(null, f.body, f.deps);
    assertEquals(r.result.state, "rejected", `${kind} ${type} ${status}`);
  }
});

Deno.test("bank transactions without a reconciliation flag or bank account are refused", async () => {
  const f = fixture("bank_transaction", "SPEND", "AUTHORISED");
  delete f.record.IsReconciled;
  assertEquals((await correctXeroLineCoding(null, f.body, f.deps)).result.state, "rejected");
  const g = fixture("bank_transaction", "SPEND", "AUTHORISED");
  delete g.record.BankAccount;
  assertEquals((await correctXeroLineCoding(null, g.body, g.deps)).result.state, "rejected");
});

Deno.test("invoice address blocks and rounding adjustments are refused before any write", async () => {
  const f = fixture("invoice", "ACCREC", "PAID");
  f.record.InvoiceAddresses = [{ InvoiceAddressType: "TO", AddressLine1: "1 Main St" }];
  const r = await correctXeroLineCoding(null, f.body, f.deps);
  assertEquals(r.result.code, "INVOICE_ADDRESS_UNSUPPORTED");
  const g = fixture();
  g.record.RoundingAmount = 0.01;
  assertEquals((await correctXeroLineCoding(null, g.body, g.deps)).result.code, "ROUNDING_UNSUPPORTED");
  assertEquals(f.writes + g.writes, 0);
});

Deno.test("malformed changes are refused before any Xero call", async () => {
  const bad = [
    [{ line_item_id: id(2), tracking_category_id: id(4) }],
    [{ line_item_id: id(2) }],
    [{ line_item_id: id(2), account_code: "30 5" }],
    [{ line_item_id: id(2), account_code: "305", tax_type: "NONE" }],
    [{ line_item_id: id(2), account_code: "305" }, { line_item_id: id(2), account_code: "306" }],
    [{ line_item_id: "row-1", account_code: "305" }],
  ];
  for (const changes of bad) {
    const f = fixture();
    let calls = 0;
    const deps = { ...f.deps, getToken: async () => { calls++; return { accessToken: "t", tenantId: id(10) }; } };
    await assertRejects(() =>
      correctXeroLineCoding(null, { ...f.body, record: { ...f.body.record, changes } }, deps)
    );
    assertEquals(calls, 0);
  }
});

Deno.test("authorization, tenant, kind and request shape are enforced", async () => {
  const f = fixture();
  await assertRejects(() =>
    correctXeroLineCoding(null, f.body, { ...f.deps, authorized: false })
  );
  await assertRejects(() =>
    correctXeroLineCoding(null, { ...f.body, tenant_id: id(11) }, f.deps)
  );
  await assertRejects(() =>
    correctXeroLineCoding(null, { ...f.body, record: { ...f.body.record, kind: "payment" } }, f.deps)
  );
  await assertRejects(() =>
    correctXeroLineCoding(null, { ...f.body, bills: [] }, f.deps)
  );
  await assertRejects(() =>
    correctXeroLineCoding(null, { ...f.body, mode: "apply", confirm: true }, f.deps)
  );
});
