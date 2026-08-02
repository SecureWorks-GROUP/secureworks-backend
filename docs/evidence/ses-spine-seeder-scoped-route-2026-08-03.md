# A scoped route to the identity-spine seeder — 2026-08-03

Owner document for `makesafe_state_seed_scoped`. Read this before changing
`supabase/functions/ops-api/makesafe_state_seed_scope.ts`, its handler in
`index.ts`, or anything that reads `makesafe_state_identity_current_v2`.

No client names, phone numbers, email addresses or street addresses appear
here. Suburb, job number and builder reference only.

---

## 1. The correction that matters most

**`spine_missing_lineage` is misnamed, and the diagnosis that motivated this
work was right about the cure but wrong about the disease.**

The blocker fires on three terms, not one
(`ses_prepare_docket_revision.ts`):

```ts
!text(input.identity.lineage_id) ||
!text(input.identity.job_id) ||
!text(input.identity.source_content_hash)
```

Measured against production on 2026-08-03, read-only through the Management
API:

| | Live intake cases |
|---|---:|
| Missing `lineage_id` | **0** |
| Missing `source_content_hash` | **103 of 163** |

**Not one live intake case on the board is missing a lineage id.** The term
that is actually absent is `source_content_hash`. Any future work that reads
the blocker's name and goes looking for lineage will find nothing wrong and
conclude the board is fine.

The four proof cards are the worked example. Each has exactly one
`confirmed_live_job` case, and each of those cases carries a populated
`lineage_id` and `instruction_key` and a **null** `source_content_hash`:

| Card | Suburb | Builder ref | Live cases | `lineage_id` | `source_content_hash` |
|---|---|---|---:|---|---|
| SWMS-261020 | Floreat | MLB-27037 | 1 | present | **null** |
| SWMS-261025 | Koondoola | MLB-27093 | 1 | present | **null** |
| SWMS-261065 | Munster | MLB-26344 | 1 | present | **null** |
| SWMS-261080 | Floreat | MLB-27148 | 1 | present | **null** |

### The measurement this corrects

The batch-4 diagnosis
(`kun-agent-workspace/data/ses-run-skill-batch4-v1/report.md`) concluded:

> *"Of the 163 jobs that have a live intake case, 163 have a lineage id. Not one
> is missing. **Where the canonical intake ran, the spine is perfect.**"*

The first sentence is true. **The conclusion drawn from it is wrong.** Lineage
is not the term U4 is missing, so "every case has a lineage id" does not mean
those cards are fine. Measured on the term that actually gates them, **103 of
the 163 cased jobs — roughly two thirds — are blocked**, exactly like the
caseless ones.

**Intake having run is not sufficient.** That matters for scope: the repair
population is not 274, it is **377 of 437**, and the extra 103 were invisible
under the caseless framing.

## 2. Why the hash is missing, and why it is a closed scar

`stamp_makesafe_intake_case_identity_v1` (a `BEFORE INSERT OR UPDATE` trigger
on `makesafe_intake_cases`, installed by
`20260728060000_makesafe_board_reconcile_truth_u2.sql`) stamps
`source_content_hash` unconditionally on every write. It works. It has no
backfill, and a case row is never rewritten after intake settles it.

The boundary is exact:

| | Count | Oldest case | Newest case |
|---|---:|---|---|
| Unstamped | 103 | 2026-07-21 | **2026-07-27 23:55Z** |
| Stamped | 60 | 2026-07-21 | 2026-07-31 |

Every unstamped case predates the trigger. Every case created after it is
stamped. **This is historical debt with a hard cutoff, not a live defect** — no
new unstamped case can be created while the trigger exists.

### What the hash is computed from

`source_content_hash` is **derived, not supplied**. Nothing upstream produces
it, and no external system has to. The trigger computes it from the case row
itself:

```sql
v_source_payload := to_jsonb(NEW)
  - 'source_version' - 'source_content_hash' - 'lineage_version'
  - 'lineage_correction_hash' - 'lineage_supersession_hash'
  - 'updated_at' - 'observed_at' - 'last_decision_at';
NEW.source_content_hash := makesafe_fact_hash_v1('intake-source', v_source_payload);
```

That is the whole case row minus its own identity columns and the
trigger-maintained timestamps, so a no-op write keeps the same identity. **Every
input already exists on the row.** The hash is absent purely because the row has
not been written since the trigger was installed — there is no missing upstream
producer to build, and no data to recover.

This is the answer to the question that decides the whole approach: **the
seeder alone is sufficient for the cased 103.** Nothing has to run before it.

## 2b. Proof that the seeder actually fixes the cased 103

This was verified link by link against production, read-only, rather than
assumed — the route was built only after it held.

The seeder touches the case row (`seed_makesafe_state_authority_v1`, the
`UPDATE public.makesafe_intake_cases` over `selected_cases`), which fires the
trigger chain. Each link:

| # | Link | Risk | Verified |
|---|---|---|---|
| 1 | `UPDATE … FROM selected_cases` | must match the card's live case | predicate is `(job_id = ANY OR target_job_id = ANY) AND state IN (live)` — matches all four |
| 2 | `enforce_makesafe_intake_case_write`: immutable identity | throws if lineage/instruction/cycle change | seeder writes only the 5 hash/version columns |
| 3 | same: `decision_changed` | throws on decision metadata without an audited decision | none of the 5 columns is a decision fact, so no branch fires |
| 4 | same: `company_key` must equal `'company:'||company_id`, same org | throws on legacy drift | **163/163 clean**, 0 bad keys, 0 org mismatches |
| 5 | same: `job_id` must be a `type='makesafe'` job in the same org | throws for a restoration-typed card | **163/163 clean** today — but see the warning below |
| 6 | `makesafe_intake_cases_u2_hashes_check` (`NOT VALID`, so re-checked on update) | throws on a malformed hash | **0 violations in 163**; the stamp always writes `sha256:` + 64 hex |
| 7 | `stamp_makesafe_intake_case_identity_v1` | must set the hash | sets `NEW.source_content_hash` **unconditionally** |
| 8 | `makesafe_fact_hash_v1` | `makesafe_canonical_json_v1` **raises** on non-integer numbers | production's hash calls `makesafe_fact_canonical_json_v1` instead (installed by `20260729030000`), which is decimal-tolerant and **total over jsonb** — its only `RAISE` is unreachable for a valid type |
| 9 | `record_makesafe_intake_case_event` (AFTER) | unexpected event rows | every branch is gated on state / case facts / authority / identity, so a hash-only update writes **zero** events |
| 10 | track record | has this trigger ever run here? | **60 live cases are already stamped by it in production**, all well-formed, `source_version` 1–7 |

Link 8 was the one that could have sunk this. `makesafe_canonical_json_v1`
rejects any JSON number that is not a finite base-10 integer, and a case row's
`raw_identity_json` can legitimately carry decimals. Production's fact hash does
not use it.

Belt and braces: the seed also mints an `effective_intake_case` identity
revision carrying its own `source_content_hash`, and U4 reads
`firstText(case.source_content_hash, revision.source_content_hash)`. **Either
path alone clears the blocker.**

> **Warning for the restoration card.** Link 5 is a live hazard the seed-scope
> migration did not cover. `20260729000000` widened the SEEDER to accept
> `insurance`/`restoration` jobs, but `enforce_makesafe_intake_case_write` still
> demands `job.type = 'makesafe'`. A restoration card that has a live intake
> case bound by `job_id` would throw on the case touch and fail its whole chunk.
> Production has exactly one restoration job and it is caseless today, so
> nothing hits this now — but keep the single restoration card out of a mixed
> tranche, and give it its own run key.

## 3. The whole population

```
canonical cards (makesafe + insurance/restoration)   437
  caseless (need a legacy_job_record revision)       274
  cased but unstamped (need the case hash)           103
  spine complete today                                60
  ambiguous (>1 live case)                             0
non-terminal cards                                   225
  of which spine-blocked                             186
```

Zero ambiguous cards means a seed today cannot mint a single
`unresolved_authority` row. That is measured, not assumed, and it is why the
ambiguity control in the test suite is a fixture rather than a live card.

## 4. The route, and why it is a separate action

`makesafe_state_seed` already existed and already called
`seed_makesafe_state_authority_scoped_v2`. It is **full-board only** by design:
the server selects the whole canonical board and the caller cannot narrow it,
so a convenient subset can never be dressed up as a completed board. Its
acceptance gate is board-wide (zero `projection_input_error` cards plus a clean
U4 canary on SWMS-26980). That is the sweep, and it has never been run.

Proving four cards through that action would mean writing 437 cards, which this
task does not authorise, or weakening a board-wide gate to fit a tranche.

So the scoped run is a **different operation with a different promise and a
different name**: `makesafe_state_seed_scoped`.

- Same producer. `seed_makesafe_state_authority_scoped_v2` only — never the
  bare `_v1`. Nothing new mints identity, and there is no second authority for
  the same fact.
- API-key-only, POST-only, `dry_run` by default. Same posture as its sibling.
- Cards are named by **job number**, not job id: the operator adjudicates cards
  by the reference on the board, and a mistyped uuid must never silently select
  a different card.
- **Every named card must resolve.** Unknown, out-of-scope, or duplicated job
  numbers refuse the whole request with a per-card reason. A tranche is
  hand-adjudicated, so a partial selection is an adjudication error, not a
  subset to run.
- Hard-capped at `MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS` (25). Reaching 437 would
  take 18 separately authorised, separately ledgered run keys. The
  inconvenience is the point.
- `board_complete: false` on every response, always.
- The RPC remains the authority on scope. The client-side predicate is a
  preview for the dry run; on a live run the RPC re-classifies under `FOR
  SHARE` and `checkMakesafeStateSeedScopeResult` reports any disagreement
  rather than letting a narrowed run read as a clean seed.

### Spine diagnostic

`deriveSesSpineFacts` reports the three identity terms before and after a run.
It is **reporting only** — nothing branches on it, and the authoritative check
stays a U4 `dry_run` prepare. `ses_spine_diagnostic_parity_test.ts` pins it
against the **real** `buildSesAssemblerInput` over the live SWMS-26980 snapshot
fixture, including a scenario proving the fixture actually moves the adapter,
so the mirror cannot silently agree with a stub.

## 5. What the seed will do to the four cards

Every other spine precondition on all four is already satisfied, measured
read-only:

| Precondition | All four |
|---|---|
| `cycle_attribution` | `bound` |
| Builder reference (`builder_wo_canonical`) | present |
| Work-order `job_documents` row | 1 |
| `deliverable_ref_canonical` | `GENERAL_MAKESAFE` |
| Company report recipient | present |
| Family | `general_makesafe` → `physical_makesafe` |
| Trade report / media | 1 report, 9–31 media |

So `source_content_hash` is the only missing spine term on all four. The seed
touches the case row, the `BEFORE UPDATE` trigger stamps the hash
unconditionally, and it also mints an `effective_intake_case` identity revision
(`case_count = 1`). Both paths supply the term U4 reads.

**This is a prediction, not a proof.** See section 7.

## 6. The seeder writes more than identity — know this before a sweep

`seed_makesafe_state_authority_v1` is not an identity-only function. Per
selected job it may also create an attendance cycle, bind cycle attribution
across `makesafe_job_details` / `job_assignments` / `job_service_reports` /
`job_documents` / `job_media` / `makesafe_report_pack_cycles`, and insert
`makesafe_terminal_proofs` and `makesafe_cancellation_decisions` rows.

Two writes are **global, not scoped to the selection**: it publishes five rows
into `makesafe_family_rule_revisions` and repoints
`makesafe_family_rule_current`. Both tables are empty in production today and
**no edge function or script reads either**, so the first run's global effect is
currently inert — but it is a board-wide write from a four-card action and a
sweep planner must know it.

The money seal is untouched. The seeder writes no `xero_invoices` row, sets no
`job_id` link, and sends nothing; it only reads invoice status when deciding a
terminal proof. `trg_makesafe_intake_cases_seal_jobs` fires only on `UPDATE OF
job_id, target_job_id`, which the seeder does not touch.

## 7. What is NOT proven here

**The four-card live run has not happened.** Two things block it and neither is
a code problem:

1. `makesafe_state_seed_scoped` is not deployed. It deploys on merge to main.
2. The ops API key available to this lane
   (`kun-agent-workspace/data/secrets/sw-api-key`) is rejected by production
   with `Unauthorized` on every action, so neither the live seed nor the
   bracketing U4 `dry_run` prepare could be executed.

`preview_makesafe_state_authority_v2` would have shown exactly what the seed
would mint, read-only — but `EXECUTE` is granted to `service_role` only and the
Management API query role is refused (`42501`). That refusal is the grant
working; it was not worked around.

Everything in sections 1–6 is measured against production read-only. Section 5
is derived from those measurements plus the seeder's own SQL. The
before/after bracket belongs to whoever runs the tranche.

## 7b. The four-card proof, ready to run

Preconditions: `makesafe_state_seed_scoped` merged and deployed, and a working
ops key in `SW_API_KEY`. Then it is four commands.

```bash
BASE="https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api"
CARDS='["SWMS-261020","SWMS-261025","SWMS-261065","SWMS-261080"]'
RUN_KEY="ses-spine-tranche-1-2026-08-03"
post() { curl -sS -X POST "$BASE?action=$1" -H "x-api-key: $SW_API_KEY" \
  -H 'Content-Type: application/json' --data "$2"; }

# 1. BEFORE — U4 bracket. Expect spine_missing_lineage on all four, persisted:false.
for jn in SWMS-261020 SWMS-261025 SWMS-261065 SWMS-261080; do
  post prepare_ses_docket_revision "$(jq -cn --arg jn "$jn" '{selection:{mode:"job_number",job_number:$jn},
    dry_run:true,force_refresh:true,idempotency_key:("spine-before:"+$jn)}')" \
  | jq -c '{jn:"'"$jn"'",state:.results[0].state,blockers:[.results[0].blockers[]?.reason_code]}'
done

# 2. DRY RUN — no writes. Expect selected:4, spine_incomplete_before:4.
post makesafe_state_seed_scoped "{\"job_numbers\":$CARDS,\"dry_run\":true}" | jq .

# 3. LIVE — the only authorised write. Expect ok:true, seeded:4, skipped:0,
#    spine_incomplete_after:[].
post makesafe_state_seed_scoped \
  "{\"job_numbers\":$CARDS,\"dry_run\":false,\"run_key\":\"$RUN_KEY\"}" | jq .

# 4. AFTER — U4 bracket again. Expect no spine_missing_* on any of the four.
#    Re-run step 1 with idempotency_key "spine-after:<jn>".
```

Acceptance, all four required:

- step 2 reports `board_complete:false`, `selected` = the 4 named cards,
  `seed_result.persisted_writes: 0`;
- step 3 reports `accounting.agrees: true`, `seed_result.seeded: 4`,
  `skipped: 0`, `spine_incomplete_after: []`;
- step 4 shows **no** `spine_missing_source`, `spine_missing_lineage` or
  `spine_missing_deliverables` on any card;
- `persisted: false` on every U4 call in steps 1 and 4.

Re-running step 3 with the same `run_key` must return
`idempotent_replay: true` and write nothing — worth doing once, as it proves the
ledger key.

Stop and report rather than retry if: step 3 returns 409 (the RPC refused —
read its message, do not re-key), `accounting.agrees` is false (the RPC
re-classified the selection under `FOR SHARE`), or any card still carries a
`spine_missing_*` blocker at step 4. A `403`/`409` anywhere on a money path is
the seal working and must never be worked around.

Read-only reconfirmation of the whole board afterwards, via the Management API:

```sql
SELECT count(*) FILTER (WHERE source_content_hash IS NULL) AS still_unstamped
FROM makesafe_intake_cases WHERE state IN ('confirmed_live_job','blocked_live_job');
-- 103 before the tranche, 99 after.
```

## 8. Reaching the other 373

A scoped run, not a sweep — and not yet.

Of 437 canonical cards, 377 need the seed (274 caseless + 103 unstamped). The
brief's "268 others" undercounts because the 103 cased-but-unstamped cards were
not visible under the caseless framing.

Recommended order, each tranche its own run key and its own before/after
bracket:

1. The four proof cards.
2. The remaining **103 cased-but-unstamped** cards, in tranches of 25. These
   are the lowest-risk group: they already have exactly one live case, so the
   seed mints `effective_intake_case` and stamps a hash the trigger would have
   written anyway. Nothing is invented.
3. The **274 caseless** cards. Higher blast radius: each gets a
   `legacy_job_record` revision, and for a card with no attendance cycle the
   seeder also creates one and rebinds cycle attribution across six tables.
   That is a real state change, not a hash backfill, and it deserves its own
   adjudication.

The full-board `makesafe_state_seed` sweep is defensible only after (2) and (3)
have been walked in tranches, because its board-wide acceptance gate cannot
pass while any card would fail — and a single failure in a 437-card run is
harder to attribute than one in a 25-card run.

**A sweep is not covered by this work and must not be run without the Captain's
sign-off.**

## 9. Intake is not broadly producing caseless jobs today

The motivating diagnosis read "the most recent caseless job was created
2026-08-01, so this is still happening". The rate says otherwise.

| Month | Caseless canonical jobs created |
|---|---:|
| 2026-06 | 212 |
| 2026-07 | 61 |
| 2026-08 | 1 |

Of the **44** canonical cards created since 2026-07-25, **42 have a live intake
case**. The two that do not are both known, individually documented cards, not
deterministic-intake output:

- **SWMS-261118** (Munster, `MLB-26344PO-57087`) — the duplicate-survivor card
  paired with SWMS-261065. See
  `docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`. Note that seeding
  SWMS-261065 does nothing for its duplicate partner.
- **SWMS-261124** (`BWCWA-6648`) — the card from the 2026-08-01 "intake source
  issue uniqueness violated" outage. See
  `docs/evidence/ses-261124-archive-display-diagnosis-2026-08-01.md`.

So the cause is **manual/repair card creation outside the intake case flow**,
at a rate of roughly 2 in 44, and the 274 is overwhelmingly a June/July backlog
from before deterministic intake stood up. Filed, not chased.
