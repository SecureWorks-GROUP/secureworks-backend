# Job Profit: patio expected versus actual

Addition to `docs/job-profit-read-contract.md` (kept apart so it does not collide with open PRs on that file).

## Patio expected versus actual (`patio_expected`)

`job_profit` (one job) adds `patio_expected` only when the job's scope is a
patio scoper 2.0 record (`scope_json.tool = 'patio-scoper'`), or
`{ status: 'unreadable', error }` when the scope could not be read. Every
other job's response is unchanged. Rules: `job_profit_patio_expected.ts`.

- `revision`: `n`, `frozen_id`, `scope_revision_id`, `parent_revision_id`,
  `sealed_at`, `outputs_agree`. `source` is always `jobs.scope_json_last_save`:
  only the last save is on the job, a parent is never readable, and nothing in
  the job system freezes the record yet (`frozen_in_job_system: false`).
- `expected`: the scoper's own ex-GST `materials_ex`, `labour_ex`, `sale_ex`,
  and `cost_ex`, `profit_before_commission_ex`,
  `margin_before_commission_pct` (the record carries no commission). `null`
  is not known, never 0. No cost, profit or margin while a lane it needs is
  `null`, the family is not supported (`supported` false or not stated: no
  sale), or the scoper did not confirm its outputs agree (then no expected
  figure is shown at all).
- `lanes.materials` / `lanes.labour`: expected beside the engine's actual,
  `actual_complete`, and `variance_ex` (actual minus expected) only when both
  are known and the actual lane is complete (no unlinked, ordered-not-billed,
  emailed-not-placed or open-order materials; no missing or unapproved labour).
- `actual`: the engine's own figures, untouched. Expected figures never enter
  `v_job_profit`.
- `sale_matches_sent_quote`: the expected sale against `quoted_ex`, within $1.
  `false` means the saved revision is not the quoted one.
- `status`: `complete` only when cost, profit, both variances and the quote
  match are all known; otherwise `incomplete`, with `flags` naming why.
