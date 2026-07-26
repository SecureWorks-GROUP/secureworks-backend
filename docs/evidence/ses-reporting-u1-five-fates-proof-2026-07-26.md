# SES Reporting U1: revised five-fates evidence

**Mission:** `ses-reporting-end-to-end-2026-07`, unit U1
**Branch:** `fm/ses-u1-intake-five-fates-v1`
**Evidence generated:** 2026-07-26
**Proof status:** **NOT PROVED**
**Safety:** Production access was read-only. The replay transport permits GET and HEAD only. No email, job, case, cursor, storage object, or communication was created or changed.

## Architect's verdict

The first U1 report confused planner and ledger agreement with correctness. That claim is withdrawn.

The revised evidence uses the independent 36-shape SES corpus catalogue as the oracle. It keeps four questions separate:

1. What fate does the independent catalogue expect?
2. What fate does the working-tree planner produce?
3. What fate is durable in production?
4. Is an independently expected live job visible through Hugo's canonical board projection within five minutes?

The result is diagnostic, not a pass:

- all 36 catalogue shapes have one unique expected fate
- only 13 of 36 example emails match that expected fate in the candidate planner
- only 10 of 36 match in the production durable ledger
- 8 of 1,396 production sources have no durable fate
- only 1 of 13 independently expected live examples is currently Hugo-visible
- that one observation gives an upper bound of 4,090,812 seconds, not evidence of a five-minute transition

U1 therefore remains open.

## Independent ground truth

Authority: `docs/evidence/ses-reporting-u1-independent-shape-catalogue.json`, derived independently from the retained SES corpus catalogue rather than planner output or the deterministic case ledger.

The replay loader rejects the catalogue unless it contains exactly 36 unique shape IDs and every shape has exactly one valid expected fate.

| Expected fate | Independent volume |
|---|---:|
| Live job | 644 |
| Blocked live job | 23 |
| Reason-coded exception | 0 |
| Revision or reattendance | 42 |
| Accounted non-work | 687 |
| **Total** | **1,396** |

These counts are expectations. They are not inferred from current planner results.

## Read-only corpus replay

Evidence: `docs/evidence/ses-reporting-u1-five-fates-replay.json`

| Measure | Result |
|---|---:|
| Real SES sources | 1,396 |
| Independent catalogue shapes | 36 |
| Shapes with exactly one expected fate | 36 |
| Structural diagnostic combinations | 79 |
| Sources receiving one planner fate | 1,396 |
| Sources with a durable production fate | 1,388 |
| Sources missing a durable production fate | 8 |
| Independent example planner matches | 13 / 36 |
| Independent example durable matches | 10 / 36 |
| Independent examples missing a durable fate | 4 / 36 |

Planner self-consistency is reported only as planner self-consistency. It is not named correctness.

### Candidate planner versus durable production ledger

| Fate | Candidate planner | Durable production |
|---|---:|---:|
| Live job | 43 | 1 |
| Blocked live job | 0 | 0 |
| Reason-coded exception | 670 | 706 |
| Revision or reattendance | 0 | 0 |
| Accounted non-work | 683 | 681 |
| **Total fated** | **1,396** | **1,388** |

The large disagreement with the independent expected distribution is unresolved. In particular, the candidate still produces no fate-4 examples and no fate-2 examples across this retained replay.

## Seven catalogue-baseline unhandled shapes

The catalogue identified seven shapes as unhandled before this patch. Candidate code now routes all seven through a named adapter and exactly one planner fate. That closes the silent unknown-builder path, but it does **not** make six incorrect outcomes correct.

| Shape | Independent expected fate | Candidate path | Candidate result |
|---|---|---|---|
| `BW-NEW-MS-WO-NO-PDF` | Blocked live job | `builderwest` | Reason-coded exception: `below_identity_floor` |
| `MLB-INFO-REQUIRED-OUR-REF` | Revision or reattendance | `mlb` revision signal | Reason-coded exception: `below_identity_floor` |
| `BW-REPLY-THREAD` | Revision or reattendance | `builderwest` revision signal | Reason-coded exception: `below_identity_floor` |
| `BW-CLAIM-REF-ADDRESS` | Live job | `builderwest` | Reason-coded exception: `below_identity_floor` |
| `BW-MAKE-SAFE-AND-REPORT` | Live job | `builderwest` | Reason-coded exception: `below_identity_floor` |
| `WESTERN-MS-WO-SUBJECT` | Live job | `western` | Live job, matches oracle |
| `BW-NEW-MS-WO-PDF` | Live job | `builderwest` | Reason-coded exception: `below_identity_floor` |

The dedicated BuilderWest adapter requires a BuilderWest identity signal. It does not select on the shared PrimeEco sender domain alone, which avoids stealing MLB and generic portal traffic. A regression test pins that boundary.

The honest conclusion is:

- 7 of 7 baseline-unhandled examples now have an explicit candidate path
- 7 of 7 have a terminal candidate fate
- only 1 of 7 currently matches the independent expected fate
- the other 6 remain product or parsing gaps, but they are visible and reason-coded rather than silently dropped

## Confirmed production parsing-rule drift

A read-only production GET independently confirmed the slug mismatch:

| Live slug | Field rules present |
|---|---|
| `aj` | No |
| `bw` | No |
| `wb` | No |
| `mlb` | Yes |
| `kba` | Yes |

The original seed targeted `ajs` / `ajbr`, `builderwest`, and `western-building`, while live production uses `aj`, `bw`, and `wb`.

Candidate migration:

`supabase/migrations/20260726000001_makesafe_company_parsing_rules_slug_correction.sql`

It:

- targets both the live slugs and legacy aliases
- keeps `template_first:false`
- does not overwrite an existing `fields` rule set
- adds the observed AJ `Job No` form
- fails closed if any active company has neither field rules nor an explicit reviewed exception
- accepts an intentional exception only when both `intentionally_no_fields:true` and a non-empty `no_fields_reason` are present

The replay applies the pending migration rules as a local candidate overlay. It records the distinction in `execution_context` and reports:

- production live missing rules: `aj`, `bw`, `wb`
- candidate missing rules after overlay: none
- production migration applied: false

The migration has not been applied to production. It must land before matching edge code.

## Hugo-visible five-minute law

The old report stopped at `jobs.created_at`. That metric is withdrawn.

The revised observer runs the canonical shared make-safe board read model with Hugo's current production profile and records the observation timestamp. It measures:

`email received -> observed in Hugo-equivalent server board projection`

This is an upper bound because historical first-visible timestamps are not persisted.

| Measure | Result |
|---|---:|
| Independently expected live examples | 13 |
| Visible at observation | 1 |
| Measured upper bounds | 1 |
| Within 300 seconds | 0 |
| Above 300 seconds | 1 |
| Unmeasured because not visible | 12 |
| Measured upper bound | 4,090,812 seconds |

This does not prove the exact first moment the card entered Hugo's board. It proves current projection membership under Hugo's server profile. It is not a Hugo browser session and does not substitute service-role access for Hugo authentication.

A supervised, non-synthetic live probe is still required to prove the five-minute promise. It must preserve one correlation chain from email receipt through case, job, canonical board projection, and Hugo-visible card observation.

## PDF extraction budget

The production-shaped replay saw:

- 584 eligible PDF documents
- 50 extracted under the run cap
- 534 deferred
- 527 sources carrying at least one cap-deferred document

A causal regression now exercises the exact code boundary: a full old sweep ahead of a newest recent work order, through `_readInputsForTest` and `enrichSourcesWithPdfText`. It proves the candidate ordering gives the recent work order a slot before old sweep PDFs.

It does **not** prove this ordering defect caused the historical production outcome. The corpus shows severe cap pressure, but the production causal claim remains unproved until source selection, attachment eligibility, deployed revision, and scan timing are observed together.

## Silent-disappearance hardening

The candidate monitor now treats source accounting as the completion boundary:

1. Every included source is retained with its post, receipt, conversation, and thread coordinates.
2. Non-2xx and network handoff failures append a reason-coded `email_events_raw` exception for every included source, plus the aggregate business event.
3. HTTP 200 triggers a canonical `makesafe_intake_case_sources` check.
4. Any included source still lacking a case gets `intake_exception_scan_completed_without_case_fate`.
5. Missing `EdgeRuntime.waitUntil` is no longer log-only. The source exceptions are written synchronously before success is returned.
6. If source exception or aggregate alarm persistence fails, the continuation rejects and retains the expiring mailbox lease. It does not acknowledge a log-only failure as settled.

This closes the code paths identified by the adversary. It is not yet production proof because the code is not deployed and the existing eight source gaps remain.

## Independent production re-verification

The three production-side numbers above were re-observed by a second reader, read-only, without reusing
`ses-reporting-u1-five-fates-replay.json`. Queries were `SELECT` only against project `kevgrhcjxspbxgovpmfl`
over the same window (`ses@secureworkswa.com.au`, `received_at` in `[2026-01-27T14:42:02.814Z, 2026-07-26T14:42:02.814Z)`).
Nothing was written, deployed, or migrated.

| Report claim | Independent re-observation | Agrees |
|---|---|---|
| `aj`, `bw`, `wb` have no field rules; `mlb`, `kba` do | all five companies active; `parsing_rules ? 'fields'` false for `aj`/`bw`/`wb`, true for `mlb`/`kba` (`template_first` `false`) | Yes |
| 1,396 sources, 1,388 durable, 8 missing a durable fate | 1,396 in-window sources, 1,388 with a canonical `makesafe_intake_case_sources` row, 8 with neither a case source nor an `intake_exception_%` event | Yes |
| Durable ledger: 706 exception, 681 accounted non-work, 1 live job | case states `exception` 706, `accounted_non_wo` 681, `confirmed_live_job` 1 | Yes |
| Only 1 of 13 independently expected live examples is Hugo-visible | exactly one in-window durable case carries a `job_id`, so at most one can be board-visible; the catalogue holds exactly 13 `live_job` shapes | Yes |
| Measured upper bound 4,090,812 seconds | that source's `received_at` is `2026-06-09T06:22:27Z`; to the recorded board observation at `2026-07-26T14:42:38.751Z` is 4,090,812 seconds | Yes |

The last row also confirms the metric is email receipt to board observation, not `jobs.created_at`: that job's
`created_at` is `2026-07-23T06:34:40Z`, which would have produced a different and much smaller number.

This raises the confidence in the reported production observations. It does not change the verdict: the
re-observation confirms the same gaps, so `proof_status` stays **NOT PROVED**.

## What is proved, and what is not

### Established

- the independent catalogue contains 36 unique real-email shapes with one expected fate each
- the current candidate and production durable outcomes disagree materially with that oracle
- live parsing rules are absent for `aj`, `bw`, and `wb`
- the corrective migration covers all current live slugs and fails closed on future uncovered active companies
- all seven baseline-unhandled examples now enter an explicit named candidate path
- each of those seven receives one candidate fate, with six still reason-coded as below the identity floor
- the candidate continuation no longer accepts source-level disappearance after a failed or partial scan handoff
- the PDF ordering regression passes at the exact old-sweep versus recent-work boundary

### Not established

- U1 correctness across the 36-shape oracle
- zero durable source gaps in production
- semantic correctness for six of the seven baseline-unhandled examples
- production deployment of the slug correction, adapters, handoff accounting, or PDF ordering change
- causal attribution of historical misses to PDF budget ordering
- a clean email reaching Hugo-visible state within five minutes
- browser-level Hugo authentication and rendering parity

## Release and proof sequence

1. Apply `20260726000001_makesafe_company_parsing_rules_slug_correction.sql` first.
2. Merge through review. Do not deploy from this feature worktree.
3. Release only from `/Users/marninstobbe/Projects/_release/secureworks-site-main` on `main`.
4. Confirm the deployed monitor and ops-api revisions match the reviewed main commit.
5. Let ordinary intake account or explicitly exception-record the eight existing durable gaps.
6. Run a supervised clean builder-email probe and observe the same source on Hugo's canonical board within 300 seconds.
7. Rerun the independent 36-shape report. U1 can pass only when agreed acceptance thresholds are met against the independent oracle, durable source gaps are zero, and the Hugo-visible probe satisfies the law.

## Regression commands

```bash
~/.deno/bin/deno test --allow-all --no-check \
  supabase/functions/ops-api/makesafe_deterministic_intake_test.ts \
  supabase/functions/ops-api/makesafe_builder_shape_adapters_test.ts \
  supabase/functions/ops-api/makesafe_company_parsing_rules_migration_test.ts \
  supabase/functions/ops-api/makesafe_intake_five_fates_replay_test.ts \
  supabase/functions/ops-api/makesafe_intake_late_pdf_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime_test.ts \
  supabase/functions/ops-api/monitor_ses_makesafes_test.ts
# 189 passed, 0 failed

~/.deno/bin/deno check --config deno.jsonc \
  scripts/replay-makesafe-five-fates.ts \
  supabase/functions/monitor-ses-makesafes/index.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts \
  supabase/functions/ops-api/makesafe_intake_five_fates_replay.ts
```

The replay key is supplied by environment and is never written to evidence.
