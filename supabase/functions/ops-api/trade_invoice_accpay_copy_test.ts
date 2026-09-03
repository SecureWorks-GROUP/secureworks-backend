// deno-lint-ignore-file no-import-prefix

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function sliceCase(action: string, nextAction: string): string {
  const start = INDEX.lastIndexOf(`case '${action}':`);
  assert(start >= 0, `${action} case missing`);
  const end = INDEX.indexOf(`case '${nextAction}':`, start);
  assert(end > start, `${action} case not followed by ${nextAction}`);
  return INDEX.slice(start, end);
}

Deno.test("new trade ACCPAY bills never stamp POSSIBLE DUPLICATE or machine net-earnings wording", () => {
  const generate = sliceCase("generate_trade_invoice", "my_invoices");
  assert(
    !generate.includes("POSSIBLE DUPLICATE - verify prior trade invoice before approving"),
    "Xero extra-line descriptions must not carry POSSIBLE DUPLICATE",
  );
  assert(
    !INDEX.includes("Net earnings after"),
    "generator must not prefix labour with Net earnings after",
  );
  assert(
    generate.includes("tradeName"),
    "generate_trade_invoice must stamp the trade name on the Xero bill",
  );
  assert(
    generate.includes("pdf_base64"),
    "generate_trade_invoice must attach the trade PDF in the same request as the draft bill",
  );
  assert(
    generate.includes("pdf_attached"),
    "generate_trade_invoice must report whether the PDF landed on the draft",
  );
});

Deno.test("Books supplier-bill doors exist and stay DRAFT", () => {
  for (
    const action of [
      "list_supplier_bills",
      "get_supplier_bill",
      "create_supplier_bill",
      "update_supplier_bill",
      "attach_supplier_bill_pdf",
      "create_supplier_credit_note",
    ]
  ) {
    assert(
      INDEX.includes(`case '${action}':`),
      `missing Books door ${action}`,
    );
  }
  assertEquals(INDEX.includes("case 'approve_supplier_bill':"), false);
  assertEquals(INDEX.includes("case 'pay_supplier_bill':"), false);
  assertEquals(INDEX.includes("case 'void_supplier_bill':"), false);
});
