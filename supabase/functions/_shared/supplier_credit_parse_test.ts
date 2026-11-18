// Pure unit tests for supplier_credit_parse.ts (ticket P3-02.2).
// Run: ~/.deno/bin/deno test --no-check --allow-env --allow-read supabase/functions/_shared/supplier_credit_parse_test.ts

import {
  parseAmounts,
  parseInvoiceNumber,
  parseSupplierCredit,
} from "./supplier_credit_parse.ts";
import {
  parseAmounts as reExportedParseAmounts,
  parseInvoiceNumber as reExportedParseInvoiceNumber,
} from "../xero-sync/materials_email_enrich.ts";

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = typeof actual === "function" ? actual : JSON.stringify(actual);
  const b = typeof expected === "function"
    ? expected
    : JSON.stringify(expected);
  if (a !== b) {
    throw new Error(
      `${msg ? `${msg}: ` : ""}expected ${String(b)}, got ${String(a)}`,
    );
  }
}

Deno.test("parseSupplierCredit: reads full credit note with number, date, amounts and named bill", () => {
  const text = [
    "CREDIT NOTE CN-1001",
    "Supplier: ZZTEST Supplies",
    "Date: 3 October 2026",
    "Original invoice INV-5001",
    "Total inc GST $220.00",
    "GST $20.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(text), {
    credit_number: "CN-1001",
    credit_date: "2026-10-03",
    amount_ex: 200,
    amount_inc: 220,
    names_bill_number: "INV-5001",
  });
});

Deno.test("parseSupplierCredit: tax invoice returns null", () => {
  const text = [
    "TAX INVOICE",
    "Invoice No: INV-5001",
    "Date: 3 October 2026",
    "Subtotal (ex GST) $200.00",
    "GST $20.00",
    "Total inc GST $220.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(text), null);
});

Deno.test("parseSupplierCredit: credit with no total gives null amounts, never 0", () => {
  const text = [
    "CREDIT NOTE",
    "Credit Note No: CN-1002",
    "Date: 3 October 2026",
    "Original invoice: INV-5002",
  ].join("\n");

  assertEquals(parseSupplierCredit(text), {
    credit_number: "CN-1002",
    credit_date: "2026-10-03",
    amount_ex: null,
    amount_inc: null,
    names_bill_number: "INV-5002",
  });

  const zeroTotal = [
    "CREDIT NOTE CN-1003",
    "Date: 3 October 2026",
    "Total inc GST $0.00",
    "GST $0.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(zeroTotal), {
    credit_number: "CN-1003",
    credit_date: "2026-10-03",
    amount_ex: null,
    amount_inc: null,
    names_bill_number: null,
  });
});

Deno.test("parseSupplierCredit: Australian day-month-year date forms and invalid calendar dates", () => {
  const forms = [
    "03/10/2026",
    "3/10/2026",
    "03-10-2026",
    "3 Oct 2026",
    "3 October 2026",
  ];
  for (const d of forms) {
    const res = parseSupplierCredit(
      `CREDIT NOTE CN-1004\nDate: ${d}\nTotal inc GST $110.00`,
    );
    assertEquals(res?.credit_date, "2026-10-03", `date form ${d}`);
  }

  for (
    const invalid of ["31/02/2026", "29/02/2026", "32/10/2026", "03/13/2026"]
  ) {
    const res = parseSupplierCredit(
      `CREDIT NOTE CN-1004\nDate: ${invalid}\nTotal inc GST $110.00`,
    );
    assertEquals(res?.credit_date, null, `invalid date ${invalid}`);
  }

  const noDateWord = parseSupplierCredit(
    "CREDIT NOTE CN-1004\n03/10/2026\nTotal inc GST $110.00",
  );
  assertEquals(noDateWord?.credit_date, null);

  const afterDatedInvoice = parseSupplierCredit(
    "CREDIT NOTE CN-1004\nRe invoice INV-5001 dated 15/09/2026\nDate: 03/10/2026",
  );
  assertEquals(afterDatedInvoice?.credit_date, "2026-10-03");
});

Deno.test("parseSupplierCredit: 10-character text and credit words only past 1,500 characters return null", () => {
  assertEquals(parseSupplierCredit("CREDIT NOT"), null);
  assertEquals(parseSupplierCredit("1234567890"), null);
  assertEquals(parseSupplierCredit(""), null);

  const lateCredit = `${"X".repeat(1505)} CREDIT NOTE CN-1005 Date: 03/10/2026`;
  assertEquals(parseSupplierCredit(lateCredit), null);

  const withinWindow = `${
    "X".repeat(1400)
  } CREDIT NOTE CN-1005\nDate: 03/10/2026`;
  assertEquals(parseSupplierCredit(withinWindow)?.credit_number, "CN-1005");
});

Deno.test("parseSupplierCredit: credit headings, credit number labels and missing credit number", () => {
  const cases: Array<[string, string]> = [
    ["Adjustment Note\nAdjustment Note No: ADJ-201", "ADJ-201"],
    ["Credit Memo\nDocument No. DOC-301", "DOC-301"],
    ["Credit Note\nCredit Note No. CN-401", "CN-401"],
    ["Credit Note\nCredit Note Number: #CN-501", "CN-501"],
    ["Credit Note\nCredit No #CR-601", "CR-601"],
  ];
  for (const [text, expected] of cases) {
    assertEquals(parseSupplierCredit(text)?.credit_number, expected, text);
  }

  assertEquals(
    parseSupplierCredit(
      "CREDIT NOTE\nZZTEST Supplies\nDate: 03/10/2026\nTotal $110.00",
    ),
    null,
  );
});

Deno.test("parseSupplierCredit: bill reference labels and positive amounts from negative credit totals", () => {
  const billLabels = [
    "Original invoice INV-5001",
    "Against invoice: INV-5001",
    "Invoice no. INV-5001",
    "Invoice number #INV-5001",
    "Re invoice INV-5001",
    "Applies to: INV-5001",
  ];
  for (const line of billLabels) {
    const res = parseSupplierCredit(`CREDIT NOTE CN-1006\n${line}`);
    assertEquals(res?.names_bill_number, "INV-5001", line);
  }

  const negative = parseSupplierCredit(
    "CREDIT NOTE CN-1006\nSubtotal (ex GST) -$200.00\nTotal (inc GST) ($220.00)",
  );
  assertEquals(negative?.amount_ex, 200);
  assertEquals(negative?.amount_inc, 220);
  assertEquals(negative?.names_bill_number, null);
});

Deno.test("parseSupplierCredit: does not treat statements, remittances or file names as credits", () => {
  const statement = [
    "STATEMENT OF ACCOUNT",
    "Date: 31/10/2026",
    "03/10/2026 Credit Note No: CN-1001 -$220.00",
    "Total Due $500.00",
  ].join("\n");
  assertEquals(parseSupplierCredit(statement), null);

  const remittance = [
    "REMITTANCE ADVICE",
    "Date: 31/10/2026",
    "Document No: CN-1001 Credit Note -$220.00",
  ].join("\n");
  assertEquals(parseSupplierCredit(remittance), null);

  assertEquals(parseSupplierCredit("credit_note_CN-1001.pdf"), null);
  assertEquals(parseSupplierCredit("Credit Note CN-1001.pdf"), null);
});

Deno.test("materials_email_enrich re-exports shared parseInvoiceNumber and parseAmounts", () => {
  assertEquals(reExportedParseInvoiceNumber, parseInvoiceNumber);
  assertEquals(reExportedParseAmounts, parseAmounts);
  assertEquals(parseInvoiceNumber("Tax Invoice 80012345"), "80012345");
  assertEquals(
    parseAmounts(
      "Subtotal (ex GST) $1,000.00\nGST $100.00\nTotal Due $1,100.00",
    ),
    { exGst: 1000, incGst: 1100 },
  );
});
