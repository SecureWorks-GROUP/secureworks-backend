// The deposit invoice's lines (createDepositInvoice), so that Xero's total is the deposit to the cent (Scope Engine
// finish line B2, 3 Nov 2026: the deposit invoice equals the accepted revision's deposit to the cent).
//
// The deposit is an inc-GST figure: the accepted revision's deposit.total_deposit_inc_gst, or a party's share. As an
// ex-GST line (round(inc / 1.1)) with Xero adding 10% GST to it, about 1 in 11 inc-GST amounts cannot be reached by
// any ex-GST cent amount plus its rounded GST, so the invoice came out a cent off. The lines go inc GST instead
// (LineAmountTypes Inclusive): Xero works the GST out inside them, and the total is the deposit exactly. Council fees
// added beside the deposit go the same way, so they add exactly too.

export type DepositInvoiceLine = { description: string; quantity: 1; unit_price: number; account_code: string };
export type DepositInvoiceLines = { line_amount_types: "Inclusive"; line_items: DepositInvoiceLine[] };

const cents = (x: number): number => Math.round(x * 100) / 100;

export function depositInvoiceLines(o: {
  depositIncGst: number;
  description: string;
  accountCode: string;
  extras?: ReadonlyArray<{ description?: string | null; amount_inc_gst?: number | null }>;
}): DepositInvoiceLines {
  const line_items: DepositInvoiceLine[] = [
    { description: o.description, quantity: 1, unit_price: cents(o.depositIncGst), account_code: o.accountCode },
  ];
  for (const extra of o.extras ?? []) {
    const amount = Number(extra?.amount_inc_gst ?? 0);
    if (amount > 0 && extra?.description) {
      line_items.push({ description: extra.description, quantity: 1, unit_price: cents(amount), account_code: o.accountCode });
    }
  }
  return { line_amount_types: "Inclusive", line_items };
}
