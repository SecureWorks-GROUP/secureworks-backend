import type { TradeInvoiceMoney } from "./trade_invoice_money.ts";

export type PayViewOptions = {
  reimbursementsEx: number;
  taxSetAsidePercent: number | null;
  repayment: { label: string; amount: number; balance_left?: number } | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function buildPayView(money: TradeInvoiceMoney, opts: PayViewOptions) {
  if (money.super_basis !== "inclusive_12_112_v1") return null;
  const total = money.super_base_ex ?? money.gross_earned;
  const paid = round2(total - money.super_amount);
  if (
    !Number.isFinite(total + money.super_amount + paid) ||
    Math.round((money.super_amount + paid) * 100) !== Math.round(total * 100)
  ) {
    throw new Error("Pay view does not reconcile to the cent");
  }
  return {
    basis: "inclusive_12_112_v1" as const,
    total_inc_super: total,
    paid_to_super: money.super_amount,
    paid_to_you: paid,
    reimbursements: opts.reimbursementsEx,
    gst: money.gst_amount,
    repayment: opts.repayment ?? (money.recurring_deduction ? {
      label: money.recurring_deduction.label,
      amount: money.recurring_deduction.amount,
    } : null),
    into_bank: money.trade_payable,
    tax_set_aside: opts.taxSetAsidePercent == null ? null : {
      percent: opts.taxSetAsidePercent,
      amount: round2(paid * opts.taxSetAsidePercent / 100),
    },
    gst_set_aside: money.gst_amount,
  };
}

export type PayView = NonNullable<ReturnType<typeof buildPayView>>;

// Saved invoices carry the amount taken on that invoice, not an as-at
// repayment balance. Today's rule balance is not historical evidence, so
// omit balance_left and do not read the rule or balance service here.
export function payViewRepayment(invoice: Record<string, any>) {
  const label = String(invoice.recurring_deduction_label ?? "").trim();
  const amount = Number(invoice.recurring_deduction_amount);
  return label && Number.isFinite(amount) && amount > 0 ? {
    label,
    amount,
  } : null;
}
