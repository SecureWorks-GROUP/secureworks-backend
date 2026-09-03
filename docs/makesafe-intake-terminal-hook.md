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

A third, non-emergency condition sits alongside them. The captain's 2026-08-06
ruling is the outcome it serves — advancement must be an explicit action or a
scheduled path, never a side effect of rendering a board; the allow-list below is
the implementing mechanism, chosen in that change rather than specified by him.
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

### Repair family is supervised on every lane

An `SWR-` mint is irreversible, so a human taps every one. Advance-what-passes
stops at the repair family: `approveIntakeDraft` refuses (409) whenever the
family that would actually be created is `repair` and the caller carries the
module-private unattended marker every in-repo automation lane stamps (the
sweep, the legacy drain and the deterministic scan lanes among them). The
deterministic runtime additionally withholds its own guarded approval for a
repair-family plan and leaves the draft written and `needs_review`, and the
sweep skips it earlier with `repair_family_supervised_review`; those are
earlier, weaker layers, not the guarantee. A parked repair draft is ordinary
review-queue work for an operator.

Which work orders resolve to repair widened with the captain's 2026-08-31
ruling: a properly identified, readable work order that is not general make-safe,
not a roof report, not an assessment/quote report and not a temporary fence
make-safe is repair. The complement applies only after the quality floor above
has passed, so an unparseable, cancelled, chatter, unknown-builder,
insufficient-identity or quote-stage draft still parks as a reviewable exception
exactly as before. Contract and measured effect:
[intake WO+PO identity and the repair complement](evidence/intake-wo-po-identity-and-repair-complement-2026-08-31.md).

## Operator Intake queue and Advance contract

The make-safe board reads its operator queue through
`list_intake_drafts?status=draft,needs_review`. `ops-api` reads the complete matching
draft set in bounded pages, classifies it, and only then applies the 50-card return
limit. The list route is read-only: it does not approve, reject, delete or otherwise
change a draft.

A draft is omitted only when `readAccountedIntakeDraftObligations` proves all of the
following from the canonical obligation rows and current identity/family grammar:

1. the canonical external reference is exact;
2. the builder instruction identity is proved and agrees;
3. the canonical family resolves consistently; and
4. exactly one live canonical SES job represents that obligation.

Canonical SES scope includes make-safe jobs and insurance restoration jobs. A
distinct-family work order remains visible. Conflicting top-level and extracted
company sources, missing or one-sided WO/PO identity, conflicting stored identity
evidence, unknown or conflicting family evidence, terminal bindings (including
`invoiced`) and multiple live matches also remain visible. Stored family, stored
report type, preview text, PDF context and full-email text are classified as separate
present signals before agreement. If any present signal cannot be classified, family
is unresolved and the draft remains operator work.

The response distinguishes the queue from its returned slice:

| Field | Meaning |
| --- | --- |
| `total_count` | Exact rows in the requested statuses before accounted filtering |
| `visible_total_count` | Rows remaining after proved-accounted omission |
| `omitted_count` / `omitted_accounted_count` | Proved-accounted rows omitted |
| `returned_count` | Cards in this response, at most 50 |
| `limit` | Current response cap |
| `has_more` | More visible rows exist beyond the returned slice |
| `accounted_filter_error` | Matcher failure; every draft stays visible |

`auto_approve_clean_intake_drafts` uses the same classification before its existing
cleanliness and approval gates. Proved-accounted drafts are skipped. Every uncertain,
conflicted, terminal or multiple-match disposition is also skipped. Only
`no_equivalent_live_obligation` may enter the existing clean-draft path. If the
obligation read fails, the sweep fails closed and approves none of the checked rows.
These are in-memory read decisions; no second Maybe state or persisted disposition is
introduced.

The focused regression contract is:

```bash
~/.deno/bin/deno test --allow-env --allow-read \
  supabase/functions/ops-api/makesafe_intake_accounted_operator_filter_test.ts
```

It covers same-family omission, distinct-family retention, identity and family
uncertainty, cross-source company conflict, independent preview/PDF family conflict,
terminal/multiple bindings, canonical restoration scope, honest counts beyond the
50-card cap, Advance skips, and genuine new roof/temporary-fencing eligibility. This
change has local code and test evidence only; it performs no production writes and
does not claim a post-deploy live queue count.

## Read-only diagnostic surface

`makesafe_deterministic_intake_dark_observe` remains available for exact,
sanitized diagnostics. It accepts at most 50 unique source IDs or instruction keys,
returns no source PII, creates no case/draft/job/storage object, and records only its
separate observe cursor. Its response must show `ai_enabled=false` and `ai_calls=0`.
