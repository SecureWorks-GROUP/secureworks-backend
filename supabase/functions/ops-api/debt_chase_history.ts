// Chase history filter, shared by the readers that show past chases (Clear Debt, job_detail,
// invoice_context, debt notes in debt_picture.ts).
//
// The old debt desk (30 Sep to 1 Oct 2026, removed 8 Oct 2026 when the Debt Workshop replaced
// it; docs/debt-workshop/README.md) wrote its approvals, skips, refusals and send claims onto
// payment_chase_logs as rows carrying a draft_id. Those rows stay in the table, so the readers
// must keep leaving them out. This constant was moved here unchanged from the removed
// debt_desk_drafts.ts.

/**
 * PostgREST `.or()` filter for the chase-history readers, so every invoice a desk send covered
 * reads as chased once. A desk approval, skip, refusal or claim is not a chase. send_chase_sms
 * logged a desk send with its own row (no draft id) on the first covered invoice only; the
 * desk's sent row there carries the job id, as that row does, and is left out. The desk's sent
 * rows on the other covered invoices carry no job id and are shown. Jan's morning text went to
 * Jan, not the payer, so it is not a chase of the payer either: its rows carry no schedule step
 * and are left out.
 */
export const DEBT_CHASE_HISTORY_FILTER =
  "draft_id.is.null,and(outcome_code.eq.sent,job_id.is.null,schedule_step.not.is.null)";
