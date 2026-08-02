# SES F6 SWMS rule alignment evidence

## Result

The close-out gate now requires SWMS only when the card is MLB and the sealed
family row is physical work with `swms_policy: always`. MLB roof/assessment
cards and every non-MLB card are exempt. This is the Captain's 2026-08-01 ruling
and the sealed matrix contract at `supabase/functions/ops-api/ses_family_matrix.ts:225-234`
and `supabase/functions/ops-api/ses_family_matrix.ts:290-298`.

`_requiresMakesafeSwms` derives the canonical family and asks that matrix instead
of re-encoding its family policy (`supabase/functions/ops-api/index.ts:13274-13300`).
The board stage and card-face missing-document derivations use the same predicate
(`supabase/functions/ops-api/index.ts:13558-13560`,
`supabase/functions/ops-api/index.ts:13895-13903`). The send function computes it
once, then reuses it for preflight, PDF loading, and the client-send attachment
gate (`supabase/functions/ops-api/index.ts:33617-33628`,
`supabase/functions/ops-api/index.ts:33667-33677`,
`supabase/functions/ops-api/index.ts:33915-33924`,
`supabase/functions/ops-api/index.ts:33960-33966`).

Legacy MLB cards with neither a canonical family nor `report_type` retain the
existing physical fallback (`supabase/functions/ops-api/index.ts:13277-13291`).
This preserves the one unstamped MLB card in the measured legitimate cohort.

No production data, stage, money-seal, invoice, or communication row was written.
Both measurements used the Management API database query endpoint with
`read_only: true`; the harness hard-codes that production boundary at
`scripts/ses-stage-parity-harness.ts:25-33`.

## Before and after parity counts

Both runs used the same active-v1 population, 407 cards, and frozen clock
`2026-08-02T06:00:00.000Z`:

```text
/Users/marninstobbe/.deno/bin/deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-stage-parity-harness.ts --now=2026-08-02T06:00:00.000Z \
  --out=/tmp/ses-f6-parity-{before|after}.json
```

The harness imports the runtime predicate rather than transcribing it
(`scripts/ses-stage-parity-harness.ts:493-496`) and applies it to the close-out
measurement (`scripts/ses-stage-parity-harness.ts:630-638`).

| Engine / projection | Run | New | Allocated | Trade Report In | Report Ready / Docs Ready | Completed | Archive | Cancelled |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Legacy canonical, authoritative | Before | 36 | 30 | 12 | 24 | 2 | 303 | 0 |
| Legacy canonical, authoritative | After | 36 | 30 | 12 | 24 | 2 | 303 | 0 |
| Legacy pre-overlay | Before | 64 | 35 | 12 | 30 | 2 | 264 | 0 |
| Legacy pre-overlay | After | 64 | 35 | 12 | 30 | 2 | 264 | 0 |
| M1 pure | Before | 66 | 64 | 9 | 0 | 39 | 229 | 0 |
| M1 pure | After | 66 | 64 | 9 | 0 | 39 | 229 | 0 |
| M1 published | Before | 38 | 53 | 8 | 0 | 5 | 303 | 0 |
| M1 published | After | 38 | 53 | 8 | 0 | 5 | 303 | 0 |
| Post-cutover with overlays | Before | 40 | 57 | 9 | 0 | 39 | 262 | 0 |
| Post-cutover with overlays | After | 40 | 57 | 9 | 0 | 39 | 262 | 0 |

The M1-pure versus legacy-canonical divergence remained 104 cards, and the
post-cutover divergence with overlays reapplied remained 71. No card changed
column in this F6 diff. That is expected: removing SWMS from a missing list does
not erase other missing close-out documents or a binding historical overlay. The
prior audit independently recorded the same zero-release caveat; this pass does
not reproduce that audit outside the repository.

## Cards no longer recorded as missing SWMS

The comparison query selected cards where `before.facts.swms_required == true`
and `after.facts.swms_required == false`, keyed by `job_ref`; it returned exactly
26. A separate comparison of `legacy_canonical_stage` returned an empty set.
Missing-SWMS cards fell from 31 to 5.

| Resulting authoritative column | Cards |
|---|---|
| Archive (9) | `SWMS-261124`, `SWMS-26416`, `SWMS-26491`, `SWMS-26659`, `SWMS-26692`, `SWMS-26693`, `SWMS-26791`, `SWMS-26855`, `WB68792` |
| Report Ready / Docs Ready (16) | `SWMS-26585`, `SWMS-26709`, `SWMS-26728`, `SWMS-26732`, `SWMS-26735`, `SWMS-26736`, `SWMS-26740`, `SWMS-26748`, `SWMS-26754`, `SWMS-26759`, `SWMS-26803`, `SWMS-26848`, `SWMS-26851`, `SWMS-26852`, `SWMS-26853`, `SWMS-26857` |
| Trade Report In (1) | `SWMS-26980` |

The five cards still recorded as missing SWMS are the legitimate MLB physical or
fencing cohort: `SWMS-26597` (legacy family fallback), `SWMS-26731`,
`SWMS-26782`, `SWMS-26832`, and `SWMS-26845`.

The load-bearing comparison was:

```jq
(.[0].cards | map({key:.job_ref,value:.}) | from_entries) as $before |
(.[1].cards | map({key:.job_ref,value:.}) | from_entries) as $after |
[$before | keys[] as $ref |
  select($before[$ref].facts.swms_required == true and
         $after[$ref].facts.swms_required == false) |
  {job_ref:$ref,
   before_column:$before[$ref].legacy_canonical_stage,
   after_column:$after[$ref].legacy_canonical_stage}]
```

## Tests

`supabase/functions/ops-api/makesafe_lifecycle_test.ts:173-195` proves the sealed
family result and the single predicate shared by send preflight and attachment
paths. `supabase/functions/ops-api/makesafe_lifecycle_test.ts:204-240` proves an
MLB physical card is still held while MLB roof, MLB assessment, and non-MLB
physical cards are not held for SWMS.

Fresh verification:

```text
deno test --allow-all --no-check supabase/functions/ops-api/makesafe_lifecycle_test.ts
  16 passed, 0 failed
deno test --allow-env --allow-read --allow-net=127.0.0.1 --no-check \
  supabase/functions/ops-api/makesafe_wave0_safety_spine_test.ts
  33 passed, 0 failed
deno check --config deno.jsonc supabase/functions/ops-api/index.ts \
  scripts/ses-stage-parity-harness.ts scripts/ses-evidence-stage-checker.ts
  passed
```

The repository-wide `deno task test:ops-api` remains red before test execution on
the unrelated existing type error at
`supabase/functions/ops-api/myjobs_all_means_all_test.ts:382`. Running the same
suite with `--no-check` produced 2,674 passes and 20 failures in untouched test
areas. Those baseline failures were not changed in this bounded F6 patch.

The stale Wave 0 pure-copy assertion that Western required SWMS was removed;
Western identity remains covered only for its actual portal-routing purpose
(`supabase/functions/ops-api/makesafe_wave0_safety_spine_test.ts:302-356`).

## Live UI proof

**UNVERIFIED in the live UI.** The initial Chrome CDP target disappeared twice
with `BRIDGE_NOT_READY`. Per instruction, one completely fresh isolated Chrome
session was then attempted. It remained stable, `?noAutoIntake=1` was active, and
no state-changing click or production write was made. However, the backend
worktree's local dashboard requested only the legacy `makesafe_pipeline` feed and
rendered its known 30-card fallback; it never requested canonical
`makesafe_board`. That fallback cannot prove the authoritative board and was not
captured as evidence. The authoritative after count for Docs Ready is therefore
the read-only parity result: **24**. The separate whole-board live re-sweep owns
the remaining UI proof.
