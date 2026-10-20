// What our Xero copy (xero_invoices) may say after a void or delete through ops-api
// void_invoice.
//
// Our copy may only call an invoice VOIDED or DELETED when Xero itself says so. The old
// code wrote the status it had ASKED for whenever Xero's answer did not name one, so a
// reply without the invoice in it still marked the copy deleted with nothing owing. That
// is the same kind of guess that left five open invoices marked DELETED in our copy
// (INV-0034, INV-0177, INV-0352, INV-0704, INV-0938; found 20 Oct 2026).
//
// Returns the patch for our copy, or null when Xero's answer does not confirm the void or
// delete for this exact invoice. On null the copy is left alone; the next invoice sync
// and the hourly mirror check (xero-sync/xero_mirror_check.ts) copy whatever Xero says.

export interface VoidMirrorPatch {
  status: "VOIDED" | "DELETED";
  amount_due: number;
  // deno-lint-ignore no-explicit-any
  raw_json: any;
}

export function voidMirrorPatch(
  // deno-lint-ignore no-explicit-any
  xeroResponse: any,
  xeroInvoiceId: string,
): VoidMirrorPatch | null {
  const inv = xeroResponse?.Invoices?.[0];
  if (!inv || typeof inv !== "object") return null;
  if (
    String(inv.InvoiceID ?? "").toLowerCase() !==
      String(xeroInvoiceId).toLowerCase()
  ) return null;
  const status = String(inv.Status ?? "").toUpperCase();
  if (status !== "VOIDED" && status !== "DELETED") return null;
  // Nothing is owed on a voided or deleted invoice. raw_json keeps Xero's own record, so
  // the copy's status and its stored Xero record agree.
  return { status, amount_due: 0, raw_json: inv };
}
