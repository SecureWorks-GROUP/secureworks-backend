# Make-safe deterministic intake operator contract

## Standing rule

Captain Amendments 45-46 make deterministic intake permanent. The paid AI extraction API stays off permanently.
Email parsing and bounded PDF text extraction are the only standing extraction path.
Missing fields remain visible for manual review or a later subscription-run agent.

Apply `20260724070000_makesafe_deterministic_standing_intake.sql` before its matching
`ops-api`. It establishes `deterministic` + `full_open`, empty exact allowlists and a
ten-case commit cap. There is no legacy flip or rollback ritual.

## Three advancement lanes

### Automatic code

The mailbox poll invokes `scan_ses_makesafes` through its existing
`EdgeRuntime.waitUntil` continuation. That action always runs the deterministic
runtime. One malformed source or PDF is quarantined inside its lineage component;
unrelated safe components continue and the response reports `completed_degraded`.

### SES reporting skill

Every reporting run calls `makesafe_reporting_intake_pass` exactly once before its
reporting work. The action performs:

1. one bounded deterministic intake scan; then
2. one bounded, oldest-first sweep of at most 100 `draft` / `needs_review` rows.

The sweep advances only clean, complete, high-confidence drafts. It calls the same
`approveIntakeDraft` function as the human review button, so required fields,
servable-work-order evidence, cancellation/combined-obligation checks, canonical
duplicate guards and the atomic draft claim cannot drift. A passing draft is
auto-filed into the live Trade make-safe workflow; an incomplete, ambiguous,
duplicate or concurrently claimed draft stays parked or fails locally. The reporting
action sends nothing, invoices nothing, and does not choose or mutate a named crew
assignment.

`MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE=false` or
`makesafe_cron_settings.auto_file_enabled=false` remains an explicit emergency brake.
Without either explicit brake, advance-what-passes is the default.

The scoped routine credential may call `makesafe_reporting_intake_pass`. It may not
call
`approve_intake_draft` or `auto_approve_clean_intake_drafts` directly, and raw
`scan_ses_makesafes` is no longer routine-allowlisted. This makes the one-pass
reporting coupling structural.

### Terminal make-safe skill

Captain terminal feedback executes through the existing deterministic reads and
privileged/manual correction surfaces. It never calls a metered extraction model.
When the terminal workflow performs a normal reporting run, it uses the same
`makesafe_reporting_intake_pass` action exactly once.

### Manual operator

A spectating human may approve a reviewable draft with the review button. That route
continues to use `approveIntakeDraft`; reviewed fields remain the final authority.
Reason-coded cancellations, conflicts, unknown builders, identity-floor failures and
missing job material never bypass review.

## Read-only diagnostic surface

`makesafe_deterministic_intake_dark_observe` remains available for exact,
sanitized diagnostics. It accepts at most 50 unique source IDs or instruction keys,
returns no source PII, creates no case/draft/job/storage object, and records only its
separate observe cursor. Its response must show `ai_enabled=false` and `ai_calls=0`.
