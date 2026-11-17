import type { TradeInvoiceMoney } from "./trade_invoice_money.ts";

export type PayViewOptions = {
  reimbursementsEx: number;
  taxSetAsidePercent: number | null;
  repayment: { label: string; amount: number; balance_left: number } | null;
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
    repayment: opts.repayment,
    into_bank: money.trade_payable,
    tax_set_aside: opts.taxSetAsidePercent == null ? null : {
      percent: opts.taxSetAsidePercent,
      amount: round2(paid * opts.taxSetAsidePercent / 100),
    },
    gst_set_aside: money.gst_amount,
  };
}

export type PayView = NonNullable<ReturnType<typeof buildPayView>>;

// Only rules already carried by this caller's returned invoices are read.
// The rule primary key and trade_repayment_balance's existing bounded rule
// lookup supply the current balance. No other person's figures are returned.
export async function readPayViewRepayments(client: any, invoices: any[]) {
  const ids = [
    ...new Set<string>(
      invoices.filter((invoice) =>
        invoice.super_basis === "inclusive_12_112_v1" &&
        invoice.recurring_deduction_id &&
        Number(invoice.recurring_deduction_amount) > 0
      ).map((invoice) => String(invoice.recurring_deduction_id)),
    ),
  ];
  const result = new Map<string, number>();
  if (!ids.length) return result;
  const rules = await client.from("trade_recurring_deductions").select(
    "id, kind",
  )
    .in("id", ids);
  if (rules.error) throw new Error("Could not read invoice repayments");
  for (const rule of rules.data || []) {
    if (rule.kind !== "repayment") continue;
    const balance = await client.rpc("trade_repayment_balance", {
      p_id: rule.id,
    });
    if (
      balance.error || balance.data == null ||
      !Number.isFinite(Number(balance.data))
    ) {
      throw new Error("Could not read invoice repayment balance");
    }
    result.set(String(rule.id), Number(balance.data));
  }
  return result;
}

export function payViewRepayment(
  invoice: Record<string, any>,
  balances: Map<string, number>,
) {
  const balance = balances.get(String(invoice.recurring_deduction_id));
  return balance === undefined ? null : {
    label: String(invoice.recurring_deduction_label),
    amount: Number(invoice.recurring_deduction_amount),
    balance_left: balance,
  };
}
