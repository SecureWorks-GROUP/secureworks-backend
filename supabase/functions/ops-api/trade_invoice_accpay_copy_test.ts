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
  assert(
    generate.includes("attachTradeInvoicePdfsThenMarkReconciled"),
    "generate_trade_invoice must attach PDFs before marking pushed_to_xero",
  );
  assertEquals(
    generate.includes("await markTradeInvoiceXeroSplitReconciled"),
    false,
    "generate must not mark pushed_to_xero before attach",
  );
});

Deno.test("trade PDF attach is not swallowed and retry attaches onto existing xero_bill_id", () => {
  assertEquals(INDEX.includes("PDF attach failed (non-blocking)"), false);
  const pushStart = INDEX.lastIndexOf("case 'push_trade_invoice_to_xero':");
  const push = INDEX.slice(
    pushStart,
    INDEX.indexOf("case 'list_trade_invoice_lines':", pushStart),
  );
  assert(
    push.includes("if (inv.xero_bill_id)"),
    "retry still reconcilies an existing Xero bill",
  );
  const existingReturn = push.indexOf("reconciled_existing: true");
  const attachOnExisting = push.indexOf("attachTradeInvoicePdfsThenMarkReconciled");
  assert(attachOnExisting >= 0 && existingReturn > attachOnExisting, "existing-bill retry must attach before returning");
  assert(push.includes("pdf_attached"), "retry reports pdf_attached truthfully");
  assert(
    push.includes("canEnterPushTradeInvoiceToXero"),
    "push must accept pushed_to_xero when xero_bill_id is already set",
  );
  const createPost = push.indexOf("xeroPost('/Invoices'");
  const reuseLock = push.indexOf("mustReuseExistingXeroBillForPdfRetry");
  assert(reuseLock >= 0 && createPost > reuseLock, "pushed_to_xero retry must not mint a second ACCPAY");
});

Deno.test("PDF attach happens before pushed_to_xero so a failed attach is retryable onto the same bill", () => {
  const helper = INDEX.slice(
    INDEX.indexOf("async function attachTradeInvoicePdfsThenMarkReconciled"),
    INDEX.indexOf("function tradeInvoiceGstOn"),
  );
  const attachCall = helper.indexOf("attachTradeInvoiceBillPdfs");
  const markCall = helper.indexOf("markTradeInvoiceXeroSplitReconciled");
  assert(attachCall >= 0 && markCall > attachCall, "bytes that exist must attach before status becomes pushed_to_xero");

  const wo = sliceCase("submit_work_order_invoice", "save_trade_invoice_draft");
  assert(
    wo.includes("attachTradeInvoicePdfsThenMarkReconciled"),
    "work-order submit must attach before marking pushed_to_xero",
  );
  assertEquals(
    wo.includes("await markTradeInvoiceXeroSplitReconciled"),
    false,
    "work-order submit must not mark pushed_to_xero before attach",
  );

  const submitFn = INDEX.slice(
    INDEX.indexOf("async function submitTradeInvoice"),
    INDEX.indexOf("async function setTradeRate"),
  );
  assert(
    submitFn.includes("attachTradeInvoicePdfsThenMarkReconciled"),
    "submit_trade_invoice must attach before marking pushed_to_xero",
  );
  assertEquals(
    submitFn.includes("await markTradeInvoiceXeroSplitReconciled"),
    false,
    "submit_trade_invoice must not mark pushed_to_xero before attach",
  );

  assertEquals(
    INDEX.split("await markTradeInvoiceXeroSplitReconciled").length - 1,
    1,
    "only the attach-then-mark helper may set pushed_to_xero",
  );
  assertEquals(
    INDEX.split("await attachTradeInvoiceBillPdfs").length - 1,
    1,
    "only the attach-then-mark helper may PUT trade PDFs",
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

Deno.test("audit and client PDFs use distinct Xero attachment names so PUT cannot overwrite the audit file", () => {
  const helper = INDEX.slice(
    INDEX.indexOf("async function attachTradeInvoiceBillPdfs"),
    INDEX.indexOf("function tradeInvoiceGstOn"),
  );
  assert(
    helper.includes("distinctXeroPdfFilenames"),
    "trade attach must derive audit and client names that cannot collide",
  );
  assert(
    helper.includes("names.audit"),
    "audit PDF must attach under the audit filename",
  );
  assert(
    helper.includes("names.client"),
    "client pdf_base64 must attach under a different filename than the audit PDF",
  );
  assertEquals(
    helper.includes("filename: input.filename"),
    false,
    "client attach must not reuse the invoice-number filename that would replace the audit PDF",
  );
});
