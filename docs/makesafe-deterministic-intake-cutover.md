# Make-safe deterministic standing intake

## Current authority

Captain Amendment 45 retired paid AI extraction permanently. Standing make-safe
intake is deterministic email parsing plus bounded PDF text extraction, with no model
fallback. Amendment 46 adds three first-class advancement lanes: human review,
automatic advancement during every SES reporting run, and captain terminal feedback.

This supersedes the old legacy/deterministic flip runbook. Do not restore its one-pass
flip or legacy rollback ritual.

## Release order

Apply these intake migrations before the matching `ops-api`:

1. `20260720000001_makesafe_intake_cases.sql`
2. `20260720000002_makesafe_deterministic_intake_cutover.sql`
3. `20260721000001_makesafe_intake_production_controls.sql`
4. `20260721000002_makesafe_intake_full_open.sql`
5. `20260724025815_makesafe_lineage_authority_corrections.sql`
6. `20260724062509_makesafe_lineage_authority_supersessions.sql`
7. `20260724070000_makesafe_deterministic_standing_intake.sql`
8. `20260726000001_makesafe_company_parsing_rules_slug_correction.sql`

Migration 7 makes the singleton settings row and future defaults
`deterministic/full_open`, clears exact allowlists, sets the bounded case cap to ten,
and prevents `intake_mode` from returning to `legacy`.

Migration 8 re-points the `20260704000002` parsing-rule seed at the live company
slugs (`aj`, `bw`, `wb`) without clobbering existing field rules, and installs the
fail-closed active-company coverage constraint. See `AGENTS.md` for the standing
coverage invariant.

Production deploys remain restricted to main in
`/Users/marninstobbe/Projects/_release/secureworks-site-main` using the guarded
script documented in `AGENTS.md`.

## Standing and reporting entry points

- `scan_ses_makesafes`: privileged/monitor entry point. It unconditionally calls
  `runDeterministicIntake`; the settings row supplies bounded selection controls but
  cannot select the retired paid-AI implementation.
- `makesafe_reporting_intake_pass`: routine-safe SES reporting hook. It calls the
  standing scanner once, then runs one capped clean-draft advancement sweep.
- `makesafe_deterministic_intake_replay`: aggregate dry-run evidence.
- `makesafe_deterministic_intake_dark_observe`: exact sanitized dry-run evidence.

The reporting hook is the only routine action allowed to cross the intake approval
boundary. It advances through `approveIntakeDraft`, the same function used by the
human review button, preserving required-field, work-order, duplicate, authority and
concurrency guards. Both the environment brake
`MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE=false` and the database
`auto_file_enabled=false` brake still force preview-only behavior.

## Bounded deterministic behavior

- The live case cap is structurally constrained to 1..10 and defaults to 10.
- The source read is cursor-driven and capped; case attempts have a fixed ceiling.
- Each PDF is capped by bytes, pages and characters, with bounded PDFs per source and
  per run.
- A cancelled, rejected or thrown run retains its prior completion cursor.
- A poisoned lineage component is written to `isolated_failures`; unrelated safe
  components commit and the run reports `completion_status=completed_degraded`.
- Retries reuse deterministic keys and append-only authority/artifact ledgers.
- Email-derived values win; PDF-derived fields carry per-field provenance.
- Gaps remain review work. No deterministic shortfall may call a paid AI endpoint or
  weaken the review/auto-file gates.

The old paid-AI scanner implementation is retained only as unreachable historical
code. It has no dispatch action, schedule, reporting hook, or standing caller.

## PDF extraction belt

Fresh work-order PDFs now cross the one-coordinate extraction worker before an
exact deterministic scan. The historical fallback remains bounded, but it is no
longer the fresh-arrival path. The evidence-of-record rule, reason-coded failure
accounting, backlog drain, and ordered migration-before-code release sequence
are owned by
`docs/evidence/makesafe-pdf-extraction-belt-2026-07-31.md`.

## Verification

Run the targeted contract:

```bash
~/.deno/bin/deno test -A --no-check \
  supabase/functions/ops-api/makesafe_production_controls_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_migration_test.ts \
  supabase/functions/ops-api/makesafe_intake_hardening_test.ts \
  supabase/functions/ops-api/makesafe_wave0_hardening_test.ts \
  supabase/functions/ops-api/makesafe_intake_recapture_test.ts \
  supabase/functions/ops-api/monitor_ses_makesafes_test.ts \
  supabase/functions/ops-api/makesafe_reporting_intake_pass_test.ts
```

Acceptance evidence must show:

- a fresh SES work-order PDF fills deterministic draft/job fields with
  `pdf_field_provenance` and `ai_calls=0`;
- one pathological record is quarantined while the batch completes degraded;
- one reporting-hook invocation records exactly one scanner call and one bounded
  guarded advancement sweep;
- the standing scanner slice contains none of `Anthropic`, `@anthropic-ai`,
  `messages.create`, `ANTHROPIC_API_KEY`, or a metered endpoint;
- incomplete/ambiguous drafts remain parked and passing drafts advance through the
  same approval function as manual review.
