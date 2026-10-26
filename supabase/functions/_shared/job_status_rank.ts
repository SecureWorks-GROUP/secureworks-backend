// Job status rank for forward-only GHL stage sync, in the board's own order
// (_shared/stage-gate/job-state-machine.ts). ghl-webhook (a GHL stage event) and ghl-proxy
// sync_ghl (an opportunity re-read) move a job only to a status ranked above its own.
//
// Every stored status is ranked. An unranked one used to read as 0, so a GHL stage mapped
// to accepted counted as a forward move and pulled an awaiting_deposit or order_materials
// card back to Accepted; the deposit advance (ops-api job_deposit_advance.ts) moves cards
// there without moving GHL, so that would undo it. get_review and archived rank above
// every stage GHL can map to. Legacy names rank with the stage they stand for (deposit
// with awaiting_deposit, processing with order_materials).
export const JOB_STATUS_RANK: Readonly<Record<string, number>> = {
  draft: 0, quoted: 10, partially_accepted: 15, accepted: 20,
  awaiting_deposit: 21, deposit: 21, approvals: 22, order_materials: 23, processing: 23,
  awaiting_supplier: 24, order_confirmed: 25, schedule_install: 26, scheduled: 30,
  in_progress: 40, rectification: 40, complete: 50, final_payment: 55, invoiced: 60,
  get_review: 70, archived: 80, cancelled: -1, lost: -1,
}
