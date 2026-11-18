// deno-lint-ignore-file no-explicit-any
// Named pay figures are approver-only (director ruling 18 Nov 2026, 08:14 (4)).
//
// Every ops-api action listed here returns named pay figures: a trade's name
// beside what they were paid, their hourly rate or their labour cost. Only a
// signed-in person on trade_pay_settings.pay_run_approver_user_ids may read
// one. The handler runs this check once, after the front door and before the
// action's dispatch, so no pay, rate, person or job row is read for anyone
// else. The server key, the routine key and the agent read key are refused:
// they carry no person to check. A failed or empty approver read refuses.
// Refusals are 403, never 401: trade.html logs out on any 401.
//
// Repayments and pay settings keep their own approver checks
// (trade_repayments.ts, trade_pay_settings.ts).

export const PAY_FIGURES_APPROVER_ACTIONS: ReadonlySet<string> = new Set([
  "trade_pay_run_check",
  "list_trade_invoices",
  "labour_reconciliation",
  "list_trade_invoice_lines",
  "list_new_trade_invoices",
  "trade_labour_budget",
]);

export type PayFiguresRefusal = {
  status: 403;
  code: "pay_figures_not_approver" | "pay_figures_approver_unreadable";
  error: string;
};

const NOT_APPROVER: PayFiguresRefusal = {
  status: 403,
  code: "pay_figures_not_approver",
  error: "Only the pay run approvers can see trade pay figures.",
};
const UNREADABLE: PayFiguresRefusal = {
  status: 403,
  code: "pay_figures_approver_unreadable",
  error:
    "The pay run approver list could not be read, so trade pay figures are not shown.",
};

/** null when the caller may read named pay figures, else the refusal. */
export async function payFiguresApproverRefusal(
  client: any,
  caller: { authMode: string | null; userId: string | null | undefined },
): Promise<PayFiguresRefusal | null> {
  if (caller.authMode !== "jwt" || !caller.userId) return NOT_APPROVER;
  let setting: any;
  try {
    setting = await client.from("trade_pay_settings")
      .select("pay_run_approver_user_ids")
      .eq("id", 1)
      .maybeSingle();
  } catch {
    return UNREADABLE;
  }
  if (!setting || setting.error) return UNREADABLE;
  const ids = setting.data?.pay_run_approver_user_ids;
  if (!Array.isArray(ids) || ids.length === 0) return UNREADABLE;
  return ids.includes(caller.userId) ? null : NOT_APPROVER;
}
