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
reporting work. After intake, a run may prepare the selected card's deterministic
U4 docket with `POST ops-api?action=prepare_ses_docket_revision`, passing only a
`job_id` or `job_number` selection, an idempotency key and explicit `dry_run`.
The one other operator-supplied body field is `materials_charge`, the answer to
a `materials_charge_figure_required` refusal on a single named card; its three
states and inheritance rules are owned by `ses_materials_charge_guard.ts` and
the AGENTS.md entry "MLB Physical Materials Must Never Silently Drop Off The
Invoice". The server owns the canonical `ses.assembler-input/v1` adapter. The
caller must never hand-author an assembler envelope.

The intake action performs:

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

The U4 action likewise sends nothing, creates or authorises no Xero invoice and
does not mutate job/substatus/assignment rows. `dry_run:false` appends only the
draft docket revision and its private artifacts. A ready revision enters the
append-only Docs Ready `needs_review` queue and may project the card into
pre-Xero Docs Ready; it is not sendable until the exact docket bytes are signed
off. A blocked revision remains on its existing board stage with
named blockers. The exact review API and send precondition are documented in
the [U4 pack assembler evidence](evidence/ses-u4-pack-assembler-build-2026-07-27.md#docs-ready-review-contract).
Assessment uses the sealed
`assessment-triad-invoice-only/2026-07-27` recipe and stays blocked only when
its required work order, typed Prime links, or screenshot-backed locked
captures are missing.

For physical work, `dry_run:true` is a proof pass, not a binary pack build. It
returns the ordered current-cycle photo ids, captions, raw SHA-256 hashes, byte
sizes and intended artifact paths. It does not retain the photo bytes across
iterations, base64-encode them, or render the report PDF. Full photo embedding
and private artifact persistence occur only on the real non-dry pack build.

When a physical card has no card-local trade report or photos, U4 may use sibling
evidence only from an explicit durable bundle. Both directions must be current and
provenance-recorded under the same bundle, and the claiming direction must carry a
positive claim for the exact authorised invoice line, hashed delivery artifact,
photo artifact, report and SWMS. A note, inferred address, one-way binding or
scope-mismatched claim remains a typed blocker naming the suspected sibling; cards
without a bundle-evidence claim retain the ordinary local-evidence behavior.

`MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE=false` or
`makesafe_cron_settings.auto_file_enabled=false` remains an explicit emergency brake.
Without either explicit brake, advance-what-passes is the default.

A third, non-emergency condition sits alongside them (captain ruling 2026-08-06):
`auto_approve_clean_intake_drafts` performs live approvals only for a `triggered_by`
on the closed allow-list in `makesafe_intake_advance_trigger.ts` —
`ses-reporting-skill` (the `makesafe_reporting_intake_pass` coupling below) or
`ops_intake_review_sweep` (the operator's INTAKE-column button). This is an INTENT
gate, not an authority gate: the privileged caller check is unchanged, and an
unnamed or unrecognised trigger still receives the full preview, so a direct
privileged call with no `triggered_by` returns eligibility and evidence while
approving nothing. Advance-what-passes remains the default for the named triggers.

The scoped routine credential may call `makesafe_reporting_intake_pass`. It may not
call
`approve_intake_draft` or `auto_approve_clean_intake_drafts` directly, and raw
`scan_ses_makesafes` is no longer routine-allowlisted. This makes the one-pass
reporting coupling structural.
The same credential may call `prepare_ses_docket_revision`; the action is inside
the routine default-deny allowlist solely because its write path is draft-only and
append-only. Invoice creation, authorisation and every send remain separate
privileged-human actions.

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
Before minting a new card, approval and in-place re-extraction require exactly one
work-order PDF with settled extracted text. The existing job-family classifier then
uses that PDF's declared type together with the builder context; a pending extraction
refuses with `pdf_extraction_pending`, and an email carrying multiple work orders is
refused rather than selecting one document implicitly. This is forward-only for newly
minted cards and does not reclassify existing cards.

## Read-only diagnostic surface

`makesafe_deterministic_intake_dark_observe` remains available for exact,
sanitized diagnostics. It accepts at most 50 unique source IDs or instruction keys,
returns no source PII, creates no case/draft/job/storage object, and records only its
separate observe cursor. Its response must show `ai_enabled=false` and `ai_calls=0`.
