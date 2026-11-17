import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSupplierCredit } from "./supplier_credit_parse.ts";

Deno.test("credit document: reads the printed number, Australian date, tax and bill", () => {
  assertEquals(parseSupplierCredit(`CREDIT NOTE CN-1001
Date: 3 October 2026
Original invoice INV-5001
Total inc GST $220.00
GST $20.00`), {
    credit_number: "CN-1001", credit_date: "2026-10-03",
    amount_ex: 200, amount_inc: 220, names_bill_number: "INV-5001",
  });
});

Deno.test("credit document: absent figures stay unknown and explicit zero stays zero", () => {
  assertEquals(parseSupplierCredit("Credit note no: CN-1002 Date: 03/10/2026"), {
    credit_number: "CN-1002", credit_date: "2026-10-03",
    amount_ex: null, amount_inc: null, names_bill_number: null,
  });
  assertEquals(parseSupplierCredit("Credit note no: CN-1002 Total Due $0.00")?.amount_inc, 0);
});

Deno.test("credit document: refuses non-credits, late headings and missing credit numbers", () => {
  for (const text of ["Tax invoice INV-5001 Total Due $220.00", "Statement INV-5001",
    "Remittance advice INV-5001", "ten chars!", "Credit note Date: 3 Oct 2026",
    "x".repeat(1500) + "Credit note no: CN-1001"]) {
    assertEquals(parseSupplierCredit(text), null);
  }
});

Deno.test("credit document: accepts labelled variants and positive credit magnitudes", () => {
  for (const label of ["Credit note no.", "Credit note number:", "Credit no #",
    "Adjustment note no:", "Document no:"]) {
    const result = parseSupplierCredit(`CREDIT MEMO\n${label} CN-1003
Date: 03-10-2026 Against invoice: INV-5003
Subtotal (ex GST) -$200.00 Total (inc GST) ($220.00)`);
    assertEquals(result, { credit_number: "CN-1003", credit_date: "2026-10-03",
      amount_ex: 200, amount_inc: 220, names_bill_number: "INV-5003" });
  }
});

Deno.test("credit document: validates calendar dates and reads the first date only", () => {
  for (const date of ["31/02/2026", "29/02/2026", "03/13/2026"]) {
    assertEquals(parseSupplierCredit(`Credit note no: CN-1004 Date: ${date}`)?.credit_date, null);
  }
  for (const date of ["3 Oct 2026", "3 October 2026", "03/10/2026"]) {
    assertEquals(parseSupplierCredit(`Credit note no: CN-1004 Date: ${date}`)?.credit_date, "2026-10-03");
  }
  assertEquals(parseSupplierCredit("Credit note no: CN-1004 Date: invalid Date: 3 Oct 2026")?.credit_date, null);
});
