// Pure unit tests for supplier_credit_parse.ts (ticket P3-02.2).
// Run: ~/.deno/bin/deno test --no-check --allow-env --allow-read supabase/functions/_shared/supplier_credit_parse_test.ts

import {
  parseAmounts,
  parseCreditAmounts,
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
    "Total GST $20.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(text), {
    credit_number: "CN-1001",
    credit_date: "2026-10-03",
    amount_ex: 200,
    amount_gst: 20,
    amount_inc: 220,
    names_bill_number: "INV-5001",
    needs_review: false,
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
    amount_gst: null,
    amount_inc: null,
    names_bill_number: "INV-5002",
    needs_review: false,
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
    amount_gst: null,
    amount_inc: null,
    names_bill_number: null,
    needs_review: false,
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

Deno.test("parseSupplierCredit: picks credit/amount-credited total over earlier bare or invoice total", () => {
  const creditLabelled = [
    "CREDIT NOTE CN-2001",
    "Supplier: ZZTEST Supplies",
    "Date: 10/10/2026",
    "Original invoice INV-6001",
    "Total $550.00",
    "Credited items:",
    "Subtotal (ex GST) $100.00",
    "Total GST $10.00",
    "Credit Total $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(creditLabelled), {
    credit_number: "CN-2001",
    credit_date: "2026-10-10",
    amount_ex: 100,
    amount_gst: 10,
    amount_inc: 110,
    names_bill_number: "INV-6001",
    needs_review: false,
  });

  const amountCreditedLabelled = [
    "CREDIT NOTE CN-2002",
    "Date: 10/10/2026",
    "Original invoice INV-6002",
    "Subtotal (ex GST) $500.00",
    "Total GST $50.00",
    "Total (inc GST) $550.00",
    "Amount Credited (inc GST) $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(amountCreditedLabelled), {
    credit_number: "CN-2002",
    credit_date: "2026-10-10",
    amount_ex: null,
    amount_gst: null,
    amount_inc: 110,
    names_bill_number: "INV-6002",
    needs_review: false,
  });
});

Deno.test("parseSupplierCredit: without credit-labelled total, picks last bare total and ignores invoice-only total", () => {
  const twoBareTotals = [
    "CREDIT NOTE CN-2003",
    "Date: 10/10/2026",
    "Original invoice INV-6003",
    "Subtotal (ex GST) $500.00",
    "Total GST $50.00",
    "Total $550.00",
    "Returned stock:",
    "Subtotal (ex GST) $100.00",
    "Total GST $10.00",
    "Total $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(twoBareTotals), {
    credit_number: "CN-2003",
    credit_date: "2026-10-10",
    amount_ex: 100,
    amount_gst: 10,
    amount_inc: 110,
    names_bill_number: "INV-6003",
    needs_review: false,
  });

  const invoiceTotalOnly = [
    "CREDIT NOTE CN-2004",
    "Date: 10/10/2026",
    "Original invoice INV-6004",
    "Original Invoice Total $550.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(invoiceTotalOnly), {
    credit_number: "CN-2004",
    credit_date: "2026-10-10",
    amount_ex: null,
    amount_gst: null,
    amount_inc: null,
    names_bill_number: "INV-6004",
    needs_review: false,
  });
});

Deno.test("parseSupplierCredit: refuses when two credit total candidates differ", () => {
  const differingCreditTotals = [
    "CREDIT NOTE CN-2005",
    "Date: 10/10/2026",
    "Original invoice INV-6005",
    "Credit Total $110.00",
    "Amount Credited $95.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(differingCreditTotals), {
    credit_number: "CN-2005",
    credit_date: "2026-10-10",
    amount_ex: null,
    amount_gst: null,
    amount_inc: null,
    names_bill_number: "INV-6005",
    needs_review: true,
  });
  assertEquals(parseAmounts(differingCreditTotals), {
    exGst: null,
    incGst: null,
  });

  const agreeingCreditTotals = [
    "CREDIT NOTE CN-2006",
    "Date: 10/10/2026",
    "Credit Total $110.00",
    "Amount Credited $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(agreeingCreditTotals)?.amount_inc, 110);
  assertEquals(parseSupplierCredit(agreeingCreditTotals)?.needs_review, false);
});

Deno.test("parseSupplierCredit: uses only document-level GST total, leaving ex and GST null on bare or line GST", () => {
  const lineGstWithoutTotalGst = [
    "CREDIT NOTE CN-2007",
    "Supplier: ZZTEST Supplies",
    "Date: 10/10/2026",
    "Original invoice INV-6007",
    "Line 1 post kit  Ex $100.00  GST $10.00  Line $110.00",
    "Line 2 rail kit  Ex $100.00  GST $10.00  Line $110.00",
    "Credit Total (inc GST) $220.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(lineGstWithoutTotalGst), {
    credit_number: "CN-2007",
    credit_date: "2026-10-10",
    amount_ex: null,
    amount_gst: null,
    amount_inc: 220,
    names_bill_number: "INV-6007",
    needs_review: false,
  });

  const exOnlyWithLineGst = [
    "CREDIT NOTE CN-2008",
    "Date: 10/10/2026",
    "Line 1 GST $10.00",
    "Subtotal (ex GST) $200.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(exOnlyWithLineGst), {
    credit_number: "CN-2008",
    credit_date: "2026-10-10",
    amount_ex: 200,
    amount_gst: null,
    amount_inc: null,
    names_bill_number: null,
    needs_review: false,
  });

  const withDocumentGstTotal = [
    "CREDIT NOTE CN-2009",
    "Date: 10/10/2026",
    "Line 1 GST $10.00",
    "GST Total $20.00",
    "Credit Total (inc GST) $220.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(withDocumentGstTotal), {
    credit_number: "CN-2009",
    credit_date: "2026-10-10",
    amount_ex: 200,
    amount_gst: 20,
    amount_inc: 220,
    names_bill_number: null,
    needs_review: false,
  });
});

Deno.test("parseSupplierCredit: checks ex plus GST against inc within one cent and flags needs_review on mismatch", () => {
  const mismatch = [
    "CREDIT NOTE CN-2010",
    "Supplier: ZZTEST Supplies",
    "Date: 10/10/2026",
    "Original invoice INV-6010",
    "Subtotal (ex GST) $200.00",
    "Total GST $20.00",
    "Credit Total (inc GST) $250.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(mismatch), {
    credit_number: "CN-2010",
    credit_date: "2026-10-10",
    amount_ex: null,
    amount_gst: null,
    amount_inc: null,
    names_bill_number: "INV-6010",
    needs_review: true,
  });
  assertEquals(parseAmounts(mismatch), { exGst: null, incGst: null });

  const twoCentMismatch = [
    "CREDIT NOTE CN-2011",
    "Date: 10/10/2026",
    "Subtotal (ex GST) $100.00",
    "Total GST $10.02",
    "Credit Total (inc GST) $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(twoCentMismatch)?.needs_review, true);
  assertEquals(parseSupplierCredit(twoCentMismatch)?.amount_ex, null);
  assertEquals(parseSupplierCredit(twoCentMismatch)?.amount_gst, null);
  assertEquals(parseSupplierCredit(twoCentMismatch)?.amount_inc, null);

  const oneCentRounding = [
    "CREDIT NOTE CN-2012",
    "Date: 10/10/2026",
    "Subtotal (ex GST) $100.00",
    "Total GST $10.01",
    "Credit Total (inc GST) $110.00",
  ].join("\n");

  assertEquals(parseSupplierCredit(oneCentRounding), {
    credit_number: "CN-2012",
    credit_date: "2026-10-10",
    amount_ex: 100,
    amount_gst: 10.01,
    amount_inc: 110,
    names_bill_number: null,
    needs_review: false,
  });

  const exExceedsInc = parseCreditAmounts(
    "Subtotal (ex GST) $250.00\nCredit Total (inc GST) $220.00",
  );
  assertEquals(exExceedsInc, {
    exGst: null,
    gst: null,
    incGst: null,
    needsReview: true,
  });
});
