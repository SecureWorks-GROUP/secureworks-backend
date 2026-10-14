// Our automated money messages are switched off (captain, 30 Sep 2026: "all off").
// Xero's own reminder emails stay on permanently.
//
// Every money message to a customer now goes through the Debt Workshop
// (docs/debt-workshop/README.md), one guarded send at a time. These paths send nothing:
//   - the GoHighLevel chase-overdue tag workflow (trigger_chase_workflow /
//     stop_chase_workflow): refused here, by name;
//   - the payment thank-you text (handle_payment_event, driven by the
//     process-payment-events cron, which migration
//     20260930170000_debt_autotexts_off unschedules);
//   - the Pay Now text on quote acceptance (send_acceptance_invoice keeps its
//     branded email and its AUTHORISED gate, and has no SMS leg);
//   - the daily-digest deposit chaser and the stale_followup day-3 deposit
//     reminder (daily-digest keeps its ops annotations only).
//
// Do not bring any of them back by adding the missing GHL credentials to their
// ghl-proxy calls: those calls have failed silently since mid-July, and fixing
// them would switch every one of these back on at once (debt-map-s1 section 7.1).

export const AUTOMATED_MONEY_MESSAGES_OFF_CODE = 'automated_money_messages_off'

export const RETIRED_CHASE_WORKFLOW_ACTIONS = ['trigger_chase_workflow', 'stop_chase_workflow'] as const
export type RetiredChaseWorkflowAction = typeof RETIRED_CHASE_WORKFLOW_ACTIONS[number]

// 409, never 401: a 401 force-logs-out the Trade App, and this is a refusal,
// not a login failure.
export function chaseWorkflowRefusal(action: RetiredChaseWorkflowAction) {
  return {
    status: 409,
    body: {
      error: `${action} is switched off: automated money messages are off (captain, 30 Sep 2026). Chase from the Debt Workshop instead.`,
      code: AUTOMATED_MONEY_MESSAGES_OFF_CODE,
      action,
    },
  }
}
