# Job Profit: patio expected versus actual

Addition to `docs/job-profit-read-contract.md` (kept apart so it does not collide with open PRs on that file). Rules: `supabase/functions/ops-api/job_profit_patio_expected.ts`. Revision contract consumed: Sales, `company-os/sales-scoping-integration-20261020.md`.

`job_profit` (one job) adds `patio_expected` only when the job's last save or its frozen scope revision is a patio scoper 2.0 record, or `{ status: 'unreadable', error }` when either read fails (the profit read itself never fails for it). Every other job's response is unchanged.

Three sources, never mixed:

| Block | Source | Role |
|---|---|---|
| `current_estimate` (`label: draft_current_estimate`) | `jobs.scope_json`, the last save (four projected paths) | A draft. Shown, never compared with actuals. |
| `frozen_scope` (`label: frozen_scope`) | the job's `scope_revisions` row with `status = 'frozen'`, `tool_kind = 'patio'` (superseded rows are kept but are not the current freeze) | The only expected side compared with actuals. |
| `commercial_baseline` | `v_job_profit` `expected_source` and lanes, untouched; `accepted` is true for `frozen_at_acceptance` and `accepted_quote_revision` | The engine's own baseline, shown beside, never replaced. |

`frozen_scope.server_revision` (`id`, `revision_number`, `frozen_at`, `tool_version`) is the server's row. `tool_revision` (`n`, `frozen_id`, `scope_revision_id`, `parent_revision_id`, `sealed_at`, `outputs_agree`) is the tool's own identity. A `frozenId` is never a server row id. `same_revision_as_current` compares tool ids only. When it is false, the flag `last_save_not_frozen` is set.

Expected figures (ex GST, `materials_ex`, `labour_ex`, `sale_ex`, `cost_ex`, `profit_before_commission_ex`, `margin_before_commission_pct`; the record carries no commission):

- `null` is not known, never 0. Non-numbers and negatives are `null`.
- No figure at all unless the revision is sealed (`n` and `frozenId`) and `outputsAgree` is true.
- No sale unless `supported` is true. `false` or not stated gives no sale.
- No cost, profit or margin while a lane is `null`, or while the frozen pricing says incomplete: `pricing_complete: false`, `internal.costs_complete: false`, `revision.sealed: false`, or any `sell_to_confirm`. Pricing with none of these flags is read as complete, as the send gate reads it.

`lanes.materials` / `lanes.labour` hold the frozen scope's expected figure beside the engine's actual, plus `actual_complete` and `variance_ex` (actual minus expected). There is a figure only when the frozen scope fixes a cost and the actual lane is complete. Unlinked, ordered-not-billed, emailed-not-placed or open-order materials, or missing or unapproved labour, give no variance, never a false saving. `actual` is the engine's own figures.

`sale_matches_sent_quote` compares the frozen sale with `quoted_ex`, within $1. `status` is `complete` only when the frozen cost and profit, both variances and the quote match are all known. Otherwise it is `incomplete`, with `flags` naming why. Flags: `revision_not_frozen`, `frozen_revision_unreadable`, `last_save_not_frozen`, `frozen_pricing_incomplete`, `frozen_costs_incomplete`, `frozen_pricing_not_sealed`, `frozen_sell_to_confirm`, `outputs_not_confirmed`, `revision_not_sealed`, `family_not_supported`, `supported_not_stated`, `expected_materials_not_known`, `expected_labour_not_known`, `expected_sale_not_known`, `actual_materials_open`, `actual_labour_open`, `no_sent_quote`, `expected_sale_differs_from_sent_quote`, `quote_costs_incomplete` (from #1121 once released).
