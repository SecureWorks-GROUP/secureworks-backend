# Make-Safe board truth staged cutover

This is the release procedure for the captain-approved reconciliation that
supersedes the proposed 80-card bulk flip.

The evidence review measured 385 cards and 80 declared-versus-computed
disagreements. Seventy-three had a second evidence conflict. The first tranche
is therefore exactly seven reviewed live cards, followed by an engine refresh
and a second guarded live-only tranche.

## Safety contract

- The cutover is display-only. It appends to
  `makesafe_board_status_applications`; it does not update `jobs`,
  `makesafe_job_details`, assignments, invoices, events, messages, or
  notifications.
- A card whose current displayed stage is `completed`, `archive`, or
  `cancelled`, or whose job state is terminal, is ineligible. The TypeScript
  planner and database RPC both enforce this.
- Every run supplies an exact job-number list, a unique `run_key`,
  `evidence_ref`, and `applied_by`. A run key cannot be replayed with a
  different transition set.
- The append-only ledger is both the board overlay and the durable transition
  log. Update/delete is rejected.
- Apply the migration before deploying `ops-api`. Deploy `ops-api` only from
  merged `main` in
  `/Users/marninstobbe/Projects/_release/secureworks-site-main` through
  `scripts/deploy-edge-function.sh ops-api`; that wrapper supplies the required
  `--no-verify-jwt`.

## Release order

1. Merge the reviewed PR to `main`, update the authorized release worktree, and
   apply `20260724005540_makesafe_board_truth_cutover.sql`.
2. From the authorized release worktree, run:

   ```bash
   SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
   ```

3. Use the endpoint below with the production ops key. Save every JSON response
   as release evidence; do not hand-edit the transition list.

   ```bash
   export MAKESAFE_OPS_URL='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api'
   curl --fail-with-body --silent --show-error \
     -H "x-api-key: ${SW_API_KEY}" \
     -H 'content-type: application/json' \
     "${MAKESAFE_OPS_URL}?action=makesafe_status_apply" \
     --data @stage1.json
   ```

## Stage 1: seven clean live corrections

Use this payload first with `dry_run: true`:

```json
{
  "dry_run": true,
  "job_numbers": [
    "SWMS-261019",
    "SWMS-26633",
    "SWMS-26791",
    "SWMS-26810",
    "SWMS-26934",
    "SWMS-26953",
    "SWMS-26998"
  ]
}
```

The dry run must report exactly seven transitions and zero skipped rows:

| Before | After | Expected |
| --- | --- | ---: |
| `new` | `allocated` | 4 |
| `report_ready` | `allocated` | 2 |
| `report_ready` | `trade_report_in` | 1 |

Then add:

```json
{
  "run_key": "makesafe-board-truth-stage1-20260724",
  "applied_by": "captain-approved-cutover",
  "evidence_ref": "makesafe-board-review-surface-v1/report.md"
}
```

to the same exact list and set `dry_run` to `false`. Stop if the dry run has
any skipped row or any unexpected transition. The live response must report
`applied_count: 7`, the seven transition rows, whole-board before/after counts,
unchanged `terminal_untouched` counts, and the current disagreement count.

## Stage 2: refresh the corrected engine

The deployed engine has two corrections:

1. Durable sent-pack evidence plus an AUTHORISED/PAID ACCREC invoice
   closes a card even if historical typed portal captures are missing.
2. Completion time follows the displayed model's chain: pack send time,
   invoice date/creation, detail invoice-ready time, and job completion/update
   timestamps. A missing timestamp remains `completed`; it does not fall into
   `archive`.

Terminal displayed cards and terminal job states return terminal computed truth
before any early-stage evidence rule.

Refresh the shadow:

```bash
curl --fail-with-body --silent --show-error \
  -H "x-api-key: ${SW_API_KEY}" \
  -H 'content-type: application/json' \
  "${MAKESAFE_OPS_URL}?action=makesafe_status_shadow_refresh" \
  --data '{}'
```

Then save:

```bash
curl --fail-with-body --silent --show-error \
  -H "x-api-key: ${SW_API_KEY}" \
  "${MAKESAFE_OPS_URL}?action=makesafe_status_disagreements"
```

Do not reuse the original 80-row set. The refreshed response is authoritative.

## Stage 3: remaining trustworthy live corrections

Review the refreshed disagreements and construct a new exact job-number list
containing only live cards with understood evidence. Run
`makesafe_status_apply` first with `dry_run: true`, then with a new run key,
for example `makesafe-board-truth-stage3-20260724`.

Acceptance evidence is:

- whole-board before/after counts by state;
- identical `completed`, `archive`, and `cancelled` counts for every pass,
  except cards that were live before the pass and intentionally advanced into
  a completed-type stage;
- the complete append-only transition rows for both run keys;
- a fresh shadow refresh and final disagreement response proving all live-card
  residuals are either zero or individually explained;
- a read-only query showing no transition row has a terminal
  `before_status`.

Any terminal card in a plan, any skipped row, any mismatch between planned and
applied counts, or any logged transition that does not become current display
truth is a hard stop.
