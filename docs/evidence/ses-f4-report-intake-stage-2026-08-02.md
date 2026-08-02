# F4 — a report card is no longer born in Report Ready (2026-08-02)

Forward-only fix for board-truth register row 33: *"Every newly approved roof or
assessment card is put straight into Report Ready before completion is proved"*.

## The defect, reproduced

`approveIntakeDraft` wrote `substatus: 'ready_to_invoice'` on every report-only
card at approval time. The legacy board ladder reads `ready_to_invoice` as
submitted-report evidence and derives `report_ready`:

- intake write (pre-fix): `supabase/functions/ops-api/index.ts:18172`
  (`...(body?.report_unsubmitted === true ? {} : { substatus: 'ready_to_invoice' })`)
- ladder, `hasSubmittedReport` includes `ready_to_invoice`:
  `supabase/functions/ops-api/index.ts:13458`
- ladder, fall-through to Report Ready:
  `supabase/functions/ops-api/index.ts:13526`

The standing deterministic callback does not send `report_unsubmitted`, so every
auto-approved roof / assessment card took the default branch. Result: the card
claimed to be report-ready before anybody proved the builder's Prime portal report
had been completed — the forward source of the captain's Docs Ready / Report Ready
complaint (`data/spotcheck-findings.md`, SWMS-261114 and SWMS-261116).

## The fix

A new, truthful report-only waiting state:

```
awaiting_portal_completion
```

"The report-only card is instructed and live, and it is waiting on proof that the
builder-portal report was completed." It is not an assignment, and it is not
`company_contact_done` reused for its mapping.

| Engine | File | Result |
|---|---|---|
| Legacy ladder (`_deriveMakesafeBoardStage`) | `supabase/functions/ops-api/index.ts:13527-13539` | `allocated` |
| M1 measured engine (`computeMakesafeStatus`) | `supabase/functions/ops-api/makesafe_computed_status.ts:480-488` | `allocated` |
| v2 state projection (`expectedStageForSubstatus`) | `supabase/functions/ops-api/makesafe_state_projection.ts:496-504` | `allocated` |

The constant is defined once
(`supabase/functions/ops-api/makesafe_computed_status.ts:10-28`) and imported by
every consumer, including `scripts/ses-stage-parity-harness.ts`.

The v2 projection entry is load-bearing rather than cosmetic: an unrecognised
substatus raises a hard `projection_input_error`
(`supabase/functions/ops-api/makesafe_state_projection.ts:1024-1031`), and a live
v2 seed is only acceptable at zero such cards. Without it, the first new report
card would block the seed.

Intake now writes it: `supabase/functions/ops-api/index.ts:18161-18188`.
The privileged `report_unsubmitted=true` opt-out is unchanged and still leaves the
card at the `createMakesafeJob` default (`company_contact_required` -> New).

## The advance seam (deliberately not wired here)

Advancing beyond Allocated needs an explicit portal-completion evidence event, and
the bar for that event is an open captain decision (register rows 20, 21, 26). No
advance is built or wired in this change.

The seam is the existing, already-guarded one:

- `awaiting_portal_completion` is a PRE-report substatus and is deliberately NOT in
  `PORTAL_GUARDED_ADVANCE_SUBSTATUSES`
  (`supabase/functions/ops-api/makesafe_portal_guard.ts:24-28`), so a card is free
  to sit in it;
- every substatus that would move the card past Allocated
  (`admin_to_send_report`, `ready_to_invoice`, `complete`) IS in that guarded set,
  so `assertMakesafePortalVerifiedForAdvance`
  (`supabase/functions/ops-api/index.ts:4363`) refuses to advance a report card
  without a recorded portal-locked verification for the current cycle;
- **the future completion control hooks into `markMakesafePortalReportDone`**
  (`supabase/functions/ops-api/index.ts:14068`, action
  `mark_makesafe_portal_report_done`). It records
  `makesafe_job_details.portal_verified_*` for the current cycle and moves the card
  to `admin_to_send_report`. That path already works from the new state — the card
  is not in `_PORTAL_DONE_ALREADY_SUBSTATUSES`
  (`supabase/functions/ops-api/index.ts:14066`), so the real-advance branch runs.
  Whatever the captain rules the trade-side control must be (a trade click, a
  locked-form screenshot), it terminates in that one action. Nothing else needs to
  learn about this state.

## Money: nothing is touched

`ready_to_invoice` reads financial but is a board substatus only. Verified by
exhaustive grep across the repo's money, pack, send and reporting modules:

```
grep -rn "ready_to_invoice" \
  supabase/functions/ops-api/makesafe_send_pack.ts \
  supabase/functions/ops-api/ses_reporting_actions.ts \
  supabase/functions/ops-api/ses_docs_ready.ts \
  supabase/functions/ops-api/makesafe_draft_pack.ts \
  supabase/functions/daily-digest/index.ts
# -> zero matches
```

- Pack drafting (the only automated path to a DRAFT invoice) selects
  `admin_to_send_report` alone and additionally skips every row with a
  `report_type`: `supabase/functions/ops-api/makesafe_draft_pack.ts:1657-1659`,
  `supabase/functions/ops-api/index.ts:32423`.
- The intake write patches `makesafe_job_details` directly and sets no timestamp;
  the `report_sent_at` stamp lives on `updateMakesafeSubstatus`
  (`supabase/functions/ops-api/index.ts:14007`), which intake does not call.
- No invoice, pack, docket, send or Xero row is read or written by this change, and
  `ses_money_sealed_at` is neither read nor touched.

**Conclusion: removing `ready_to_invoice` at intake touches nothing money-related.**

## Stated behaviour consequences

1. **Trade open-pool visibility (deliberate).** `ready_to_invoice` closed a card to
   the trade open pool (`supabase/functions/ops-api/index.ts:27397-27404`); the new
   waiting state does not, so a freshly approved report card is now visible and
   allocatable to trades. That is the truthful reading — the report has not been
   done — and it is a prerequisite for any trade ever completing it. Existing cards
   are unaffected because none carry the new value.
2. **Assignment auto-close.** `_MAKESAFE_SUBSTATUS_FINISHED`
   (`supabase/functions/ops-api/index.ts:27437-27439`) no longer treats a fresh
   report card as finished. It has no assignments at intake, so this is inert today
   and correct going forward.
3. **`reattendMakesafe`** no longer counts a fresh report card as "reported"
   (`supabase/functions/ops-api/index.ts:35053-35055`) — correct, there is no prior
   visit to re-attend.

## Migration

`supabase/migrations/20260802010000_makesafe_awaiting_portal_completion_substatus.sql`
widens the `makesafe_job_details.substatus` CHECK and **writes zero rows**. It must
be applied before the matching `ops-api`; it is declared in
`scripts/edge-function-schema-requirements.txt` against the renamed constraint
`makesafe_job_details_substatus_check_v2`, so marker existence proves the widening
landed rather than merely that some constraint exists.

The allowed list deliberately retains `pending_allocation`. Read-only Management
API check, 2026-08-02:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.makesafe_job_details'::regclass and contype = 'c';
-- makesafe_job_details_substatus_check: CHECK (substatus = ANY (ARRAY[
--   'pending_allocation', 'company_contact_required', 'company_contact_done',
--   'waiting_on_trade_report', 'admin_to_send_report', 'ready_to_invoice',
--   'complete']))

select substatus, count(*) from public.makesafe_job_details group by 1;
-- complete 247 | company_contact_required 88 | waiting_on_trade_report 44
-- admin_to_send_report 27 | ready_to_invoice 22 | pending_allocation 11
```

`pending_allocation` is live production drift that the repo's defining migration
(`20260601000001_makesafe_job_contract.sql`) does not carry. Dropping it from the
new CHECK would make the migration fail on apply against those 11 rows.

`bash scripts/apply-pending-migrations.sh --dry-run` reports exactly one pending
migration and no ledger version/name collision.

## Exit gate

**Tests.** `supabase/functions/ops-api/makesafe_report_intake_stage_test.ts`
(9 tests) plus one test in
`supabase/functions/ops-api/makesafe_state_projection_test.ts`:

- a freshly approved roof card and a freshly approved assessment card both land in
  `allocated` under BOTH engines, with and without builder portal links;
- the waiting state alone carries Allocated in M1 — the reason string names the
  waiting state, never an assignment, and the missing-evidence list still reports
  the uncaptured portal report;
- nothing advances them without an explicit completion event: portal links, a
  not-done capture, a done capture with no screenshot, a partial assessment
  capture set, a DRAFT invoice, completion photos, and arbitrary elapsed time all
  leave both engines at `allocated`;
- the guarded-advance set still contains every forward substatus and not the
  waiting state, and the post-event destination (`admin_to_send_report`) does
  derive past Allocated — so the seam is live, not a dead end;
- intake no longer contains the `ready_to_invoice` write;
- legacy `ready_to_invoice` and every other existing mapping derive exactly as
  before.

Full ops-api suite: **2682 passed / 20 failed**, against a HEAD baseline of
**2672 passed / 20 failed** — the same 20 pre-existing failures, byte-identical
list, plus the 10 new tests. (The pre-existing failures include
`makesafe_reconcile_corrections_test.ts:361`, which asserts index.ts contains
`body?.attach_work_order_for_report === true`; that string is not in index.ts at
HEAD either.) `deno check --config deno.jsonc supabase/functions/ops-api/index.ts`
is clean.

**Two-engine parity harness**, read-only against live production
(`scripts/ses-stage-parity-harness.ts`), before and after the change:

| Measure | Before | After |
|---|---:|---:|
| board cards | 407 | 407 |
| M1-pure vs legacy-canonical column changes | 104 | 104 |
| post-cutover changes with overlays reapplied | **71** | **71** |
| overlays total / binding today | 46 / 42 | 46 / 42 |
| overlays that would unbind under M1 | 13 | 13 |

`legacy_branch_histogram`, `transition_matrix` and `divergence_causes` are
identical maps. A per-card comparison over all 407 cards across
`legacy_stage`, `legacy_canonical_stage`, `legacy_branch`, `m1_pure`,
`m1_published`, `post_cutover_stage`, `post_cutover_overlay_binds`,
`divergence_cause` and `substatus` found **0 differences**, and **0 existing cards
carry the new substatus**. The change is forward-only, and the existing-card parity
numbers did not move.

## Out of scope

Existing-card cleanup — the 22 live `ready_to_invoice` cards and everything else
sitting in Docs Ready / Report Ready without proof — is a separate, captain-gated
tranche. This change writes nothing to any existing card.
