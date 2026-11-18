# Job work order labour confirm (FU49 9a, option A)

Director ruling 18 Nov 15:54: option A, sealed amount only.

The office sees open jobs whose draft job work order has no agreed labour.
Each row shows the job's sealed budget amount as a proposal, and one press
writes it as the draft's agreed labour. A named approver still approves the
work order afterwards. The cap and the pay run read only approved work
orders, so a confirmed draft does not count until it is approved.

## Actions (ops-api, staff only)

- `GET list_job_work_order_labour_confirm?limit=&offset=`
  - Lists open jobs (`job_work_order_open_statuses`) whose `kind = 'job'`
    work order is a draft with `agreed_labour_ex` null, oldest first.
  - Page default 25, hard cap 50. `more: true` and `more_than: N` mean more
    rows exist. The read never counts a total.
  - `reason` is one of:
    - `sealed_amount`: `proposal` carries `agreed_labour_ex`,
      `job_budget_id` and `scope_revision_id`.
    - `no_amount_in_sealed_quote`: the newest sealed budget has no work
      order amount. Nothing is proposed.
    - `no_sealed_quote`: the job has no sealed budget. Nothing is proposed.
    - `revision_differs`: the draft was filled from a revision other than the
      budget's. Nothing is proposed.
- `POST confirm_job_work_order_labour`
  `{ work_order_id, job_budget_id, agreed_labour_ex }`
  - Needs a signed-in office person (admin, owner, ops_manager). The server
    key alone is refused: there would be no person to record.
  - The caller only echoes what it was shown. The database re-reads the
    sealed budget under the work order's row lock. A changed proposal is
    refused (`proposal_changed`).
  - A second press answers `already_confirmed` with the first record.

## Rules

- Proposal source: `job_budgets` (newest version per job), field
  `budget.labour.work_order_amount_ex_gst`, through `budgetAgreedLabour`.
  It is never the quote's pricing estimate and never today's cost table
  (P1-05.5).
- Write: `confirm_job_work_order_labour` (`20261118170000`).
  - In one transaction it writes `work_orders.agreed_labour_ex` on the
    draft and one append-only row in `job_work_order_labour_confirmations`
    (who, when, budget, revision, amount).
  - The seal trigger stamps `hand_edited_at`, so a confirmed draft is never
    issued automatically.
- Switch: `job_work_order_labour_confirm_v1`.
  - It is seeded off, and an unreadable switch counts as off.
  - The press is refused in ops-api, and again in the database.
- Reads that fail:
  - A failed list or budget read answers 503.
  - It never answers an empty list or "no amount".
- Making option B (the press also approves) means changing
  `LABOUR_CONFIRM_PRESS` and `confirmJobWorkOrderLabour` only.

Code: `supabase/functions/ops-api/job_work_order_labour_confirm.ts`. Tests:
`job_work_order_labour_confirm_test.ts`, migration contract
`20261118170000_job_work_order_labour_confirm`.
