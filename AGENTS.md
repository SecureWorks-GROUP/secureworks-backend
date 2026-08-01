# SecureWorks Agent Instructions

## Acceptance Deposit Invoice Invariant

The quote self-accept flow (`send-quote` /accept → `ops-api`
`send_acceptance_invoice`) emails the client a branded "Pay Now" deposit invoice.
For that link to work, the Xero invoice MUST be `AUTHORISED` — a `DRAFT` invoice's
online link cannot take card payment and bank transfers against it land
unreconciled.

Invariants (do not regress):

- `sendAcceptanceInvoice` defaults `xero_status` to `AUTHORISED` when calling
  `createDepositInvoice` (one authoritative place). Do NOT change `createInvoice`'s
  or `createDepositInvoice`'s global `DRAFT` default — make-safe / manual / MCP
  `create_deposit_invoice` paths intentionally create drafts for review.
- The branded Pay Now email/SMS only goes out when the invoice actually came back
  `AUTHORISED` AND the OnlineInvoice URL fetch succeeded (see
  `_acceptanceInvoiceChargeable`). On failure: no client email, a loud
  `acceptance_invoice_authorise_failed` job_event, and a `{ success:false }` return
  that the accept flow handles gracefully (acceptance is still confirmed to the
  client, just without a payment link).
- The debt-followup chase cron (`daily-digest` "Unpaid Deposit Chasers") only acts
  on `AUTHORISED` deposits (positive filter) — any non-AUTHORISED status means an
  unpayable link, never chase. Likewise `sendPaymentLink` (ops-api
  `send_payment_link`) throws a 409 for any non-AUTHORISED invoice, and the cron
  only records "reminder sent" when the send actually succeeded.

## Make-Safe Boards Share One Server Read Model

The Ops and Trade make-safe boards must consume `ops-api?action=makesafe_board`
and the projection helpers in `supabase/functions/ops-api/makesafe_board_read_model.ts`.
Never derive a board column from `job_assignments.status` in a client. Ops stages
and the Trade `New / Allocated / Complete / Archive` columns are parity-checked
from the same canonical rows. Keep trade payloads allow-listed and free of pricing
and trade-invoice data.

U2-S1 cycle-scoped evidence lives in `makesafe_cycle_evidence.ts` and is shared by
board enrich and `makesafe_audit`. Apply
`20260727000001_makesafe_attendance_cycles_u2_s1.sql` **before** the matching
`ops-api` (new selects include `attendance_cycle_id` / `cycle_attribution`). Do not
deploy the matching media-cycle reads until
`20260728000001_makesafe_state_authority_u2.sql` is applied as well; it owns the
`job_media` cycle-attribution columns and index. Do not
add a second status engine; later U2 slices own readiness-approval invalidation and
display-authority cutover. Consumer contract:
`docs/makesafe-board-read-model-v1.md`. `reattend_makesafe` is relationship-gated:
a dispatcher, manager of the job vertical, or trade with a non-cancelled assignment
may open the next cycle; unrelated users remain refused. Each attendance submits an
additive `job_service_reports` row bound to its immutable attendance cycle while the
board remains one card per `jobs.id`. Charging disposition is deliberately separate
and awaits the Captain's ruling; see
`docs/evidence/makesafe-trade-reattendance-v1.md`.
Apply `20260730000001_makesafe_report_cycle_uniqueness.sql` before deploying the
matching `ops-api`; its unique nullable-cycle index is the database guard that
makes concurrent report retries converge on one report per attendance cycle.

## Deterministic Make-Safe Replay Measures Identity, Not Job Readiness

The canonical diagnosis and sanitized production projection are in
`docs/evidence/makesafe-deterministic-intake-zero-match-diagnosis-2026-07-21.md`.
Keep own-domain SES copies accounted as non-work, shape HTML through the shared
legacy stripper, and measure strong WO/PO identity separately from missing
client/address/PDF/portal recovery. Claim-only work stays below the floor and
cannot become live. Aggregate replay must expose no cursor post IDs, and clean
evidence requires both cursor timestamps null, no cap, and no caveats in the same
response. Use the bounded `max_sources` replay option when needed. Full-open binds
every bounded source to its persisted primary-source case authority before ranking;
exact mode binds only the selected case and its closed ancestry, never unrelated cases
that merely share the ambient bounded page. Exact selection closes semantic parent ancestry before
lineage validation, except the intentional fresh review-exception `sibling_of`
promotion, and a source already canonical-accounted on any case cannot make a
regrouped case fresh or spend the run cap. Multi-authority regrouping is allowed
only when every source is already canonical, all authorities share one deliverable,
and every non-primary case already matches the planned state. Fresh, cross-deliverable
or state-divergent merges fail loudly before writes. That guard now runs per
isolated lineage component (cases are unioned by lineage cluster and by shared
persisted authority, including a split old authority spanning clusters), so one
poisoned component is quarantined into `isolated_failures` and the run reports
`completion_status: 'completed_degraded'` with `components_failed` /
`sources_quarantined` counts while every unrelated safe component still commits.
An equal builder PO alone no longer unions two different explicit claims, and a
persisted authority backing multiple corrected instructions fails its component.

Duplicate email transport rows (Graph group post + mailbox twin, sha-identical
attachments) are deduped by `email_attachments.sha256` at the planner layer:
one content hash is one correlation coordinate, one instruction identity
fallback, one PDF evidence entry, and one extraction-budget spend, while both
transport rows stay persisted and accounted for audit. Do not regress this to
per-attachment-id counting; the invariant, tests and replay proof are in
`makesafe_duplicate_transport_dedupe_test.ts` and
`docs/evidence/track-a-d8-duplicate-transport-2026-07-30.md`.

Identity tokens are read out of attachment FILENAMES with underscores
normalised to spaces, because `_` is a word character and the PO grammar's
`\b` boundaries otherwise cannot see `PO20877` inside
`work_order_PO20877_Secure_Works_WA.pdf`. That normalisation is deliberately
scoped to filenames only — the same underscored token in body or PDF text
still yields no PO, because the verified Track A replay fates were computed
under the current text-matching behaviour. Widening it to the shared PO_RE
boundaries is a fate-moving change that needs its own replay revalidation.
Both halves are pinned in `makesafe_bwcwa6781_filename_po_fixture_test.ts`.

## Never Select `scope_json` In A List/Feed Query

`jobs.scope_json` (and therefore `calendar_events.scope_json`) is NOT a small
config blob: it averages ~100 kB per row and peaks at 2.6 MB. The bulk is base64
media parked under `scope_json.job.sitePlanImage` and `scope_json.job.checklist`
by the scoping tools. Everything else in the blob totals ~1.6 kB on average.

Selecting it across a range is what killed the ops calendar (`ops-api`
`?action=calendar` → HTTP 546, edge worker OOM): a 9-month window carried 115 MB
of `scope_json` for 157 kB of actually-used keys.

Rules:

- Single-job reads (`job_detail`, invoicing, PO extraction) may select the blob.
- Any query returning MANY rows must project only the keys it needs
  (`select=alias:scope_json->job->someKey`). PostgREST cannot strip keys, and
  `::text` casts are NOT honoured in filters — only projection bounds the payload.
- `calendarEvents` uses `CAL_SCOPE_PROJECTION` for this. Readiness reads scope in
  exactly two places (`evaluateCondition`): `attachment_is_fascia`
  (`scope.attachmentMethod` / `.attachment`) and `scope_mentions_asbestos`
  (the token anywhere in `JSON.stringify(scope)`). Only the asbestos one is live —
  see the `attachment_is_fascia` note below. The projection is a strict
  subset of the blob, so the substring test can never gain a false positive; it
  loses none either — verified across all 2253 live `scope_json` rows, the
  projected slice reproduces the full-blob answer for 69/69 asbestos jobs.
- `attachment_is_fascia` is INERT in production, like the `job_intelligence`
  badges below. It reads top-level `scope.attachmentMethod` / `.attachment`, and
  ZERO of the 2253 live `jobs.scope_json` rows carry either key at any level — the
  real attachment data sits under `scope_json->config` (99 rows contain the
  `fascia` token; 13 more under `scope_json->patios`). So the `engineering_doc`
  badge never fires. This is a PRE-EXISTING bug, not a regression from the
  projection: the old full-blob path and the projection both read `undefined`,
  identically. Rewiring it to `scope_json->config` would make 99 rows start firing
  a badge they don't today — a readiness-output change, so a separate product
  decision, not an incidental fix. `rd_attach_method` / `rd_attach` are retained
  in `CAL_SCOPE_PROJECTION` despite being inert: absent keys project `null` at ~0
  bytes, and they keep the intended semantics if the scoping tools ever emit them.
- If the fencing/patio scoping tools add a new FREE-TEXT key, add it to
  `CAL_SCOPE_PROJECTION` or the asbestos badge will silently miss it.
- `ops_summary`'s `today_schedule` reads `calendar_events` through
  `OPS_SUMMARY_SCHEDULE_COLUMNS` (13 columns) rather than `select('*')`, so the
  view's `scope_json` and `pricing_json` never enter the worker. That list is
  exactly the keys `toOpsSummaryScheduleEvent` emits — change the two together.
  It deliberately does NOT reuse `CAL_LIGHT_COLUMNS` (a superset maintained for
  the calendar's own consumers). The same live-view caveat as
  `CAL_FINANCIAL_COLUMNS` applies: verify names against
  `information_schema.columns`, not the migrations. `ops_summary` also enumerates
  `jobs_needing_scheduling` (`OPS_SUMMARY_NEEDS_SCHEDULING_COLUMNS`) and its
  active-jobs count read (`OPS_SUMMARY_ACTIVE_JOB_COLUMNS`). Because explicit
  projections turn schema drift into PostgREST 400s, all three go through
  `logQueryErrors()` (see the live-schema section below) so a drifted column name
  is logged instead of surfacing as a quiet day on the board.
- `calendar_events` `include_financials=true` enumerates columns
  (`CAL_FINANCIAL_COLUMNS`) rather than `select('*')` for the same reason. Keep it
  in sync with the LIVE `calendar_events` view — check
  `information_schema.columns`, NOT the migrations. The view has drifted ahead of
  this repo: the newest migration defining it
  (`20260330000001_calendar_clock_fields.sql`) declares 41 columns, while live has
  44 — `label`, `visible_to_trades` and `recurrence_group_id` exist in production
  but in no migration here. `CAL_FINANCIAL_COLUMNS` is correct against live and
  includes all three. A maintainer who reconciles it against the migration instead
  would silently drop them from the `include_financials` response. Note the
  tradeoff cuts BOTH ways, and the reverse is the sharper one: `select('*')` was
  drift-proof in both directions, enumeration only in one. Because those three
  columns exist live but in no migration here, any database provisioned from these
  migrations — a fresh `supabase start`, a Supabase preview branch, a CI
  integration env — gets a PostgREST 400 (`column calendar_events.label does not
  exist`) on `include_financials=true` rather than a response. Production is
  unaffected (the columns exist there) and no in-repo code calls
  `include_financials`, which is why this is a documented follow-up and not a
  blocker. The real fix is closing the migration/view drift — a migration that
  recreates `calendar_events` with all 44 columns so the migrations match prod —
  and that is a separate task.

## `pricing_json` In List Reads: Project, And Keep The Response Byte-Identical

`jobs.pricing_json` is a full quote blob and the same list/feed rule applies.
`ops-api` `pipeline` reads it for every active job (~hundreds of rows) only to
derive `value` and the fencing neighbour badge, so it projects four JSON paths
(`PIPELINE_PRICING_PROJECTION`) instead of the column. Two constraints that are
easy to break:

- Use `->`, not `->>`. `->>` coerces to text, so a numeric total would come back
  as a string and change the response's runtime value types.
- The aliases sit exactly where `pricing_json` used to sit in the select list,
  and `stripPipelinePricingAliases` removes them before the response — that
  preserves the previous JSON key order byte for byte. Adding a projection key
  means adding it to `PIPELINE_PRICING_PROJECTION` only; the alias list and the
  null-path list are derived from it, never restated.

A row whose `pricing_json` is a JSON-encoded STRING makes all four paths return
SQL NULL. A second server-side probe is restricted to fencing rows with a
non-null, non-empty blob and all four paths null; it re-reads only those
candidates and recovers the neighbour array, reproducing the old
`JSON.parse(string)` branch. The empty-object exclusion is load-bearing: without
it, 56 live fencing rows match but all 56 blobs are `{}` (112 bytes total) and
cannot be used. With it, a read-only check on 2026-07-20 returned zero candidates.
The fallback recovers neighbours ONLY — the old `value` chain read properties off
the raw column, so a string blob yielded 0 there, and "fixing" it would be a
behaviour change. The probe logs and degrades rather than failing the board if it
errors, and it is skipped entirely when the endpoint's `type` filter is set to
anything other than `fencing`.

The probe is hard-capped at `PIPELINE_MALFORMED_PRICING_LIMIT` (100 rows). The
null-path predicates describe today's blob shape, not an invariant: if the
fencing quote format stops writing those exact paths, every non-empty fencing row
becomes a candidate and an uncapped probe would refetch full blobs up to the
PostgREST 1000-row ceiling on every `pipeline` request — silently restoring the
payload this projection removes. Hitting the cap is a data problem to clean up
separately, so the probe `console.warn`s loudly and leaves neighbours beyond the
cap unrecovered rather than degrading quietly.

Related pre-existing behaviour, deliberately unchanged: `ops_summary`'s
`today_schedule` omits `job_number`, and its `not_invoiced` attention items emit
`client`/`suburb` as `undefined` because the active-jobs read never selected
`client_name`/`site_suburb`. `OPS_SUMMARY_ACTIVE_JOB_COLUMNS` (`id, status,
type`) preserves both omissions exactly — it is NOT a regression introduced by
the narrowing. Populating either would be an API change, not a performance
change.

## `job_intelligence` Shape Differs Between Live and Migrations

`computeReadiness` reads `assignment_count`, `po_count`, `wo_count`,
`deposit_paid`, `all_pos_delivery_confirmed`, `doc_types`, `quoted_amount` and
`job_type` off `job_intelligence`. Whether it finds them depends on the database:

- **Migration-provisioned** (fresh `supabase start`, preview branch, CI):
  `job_intelligence` is the MATERIALIZED VIEW from
  `20260319000002_readiness_engine.sql`, and it carries all eight. No migration
  drops it — `20260407000001_job_intelligence.sql` is `CREATE TABLE IF NOT
  EXISTS`, which silently no-ops against the existing MV since an MV and a table
  share the relation namespace.
- **Live production**: a TABLE of AI-intelligence fields (`risk_level`,
  `ai_summary`, `financials`, …) without those eight. It did not get that way from
  these migrations.

The two environments genuinely disagree, so code reading `job_intelligence` must
not hardcode either shape — the calendar uses a plain `select('*')`, which is
drift-proof in both directions and keeps readiness output identical on each.
Closing the drift is a separate task.

## A Wrong Column Name Reads As "No Data", Not As An Error

PostgREST rejects a select naming a column that does not exist with a 400
(`42703`), returning `data: null` and `error` set. Almost every call site here
destructures `{ data }` only, so the query degrades to zero rows: a $0 pipeline
figure, an empty digest, or an unmatched invoice looks exactly like a quiet week.
These bugs survive for months because nothing throws.

Two rules follow:

- Verify column names against the live schema (`information_schema.columns`),
  not against the migrations or what the surrounding code assumes. Live names
  that commonly surprise: `xero_invoices.invoice_date` / `.invoice_type` /
  `.fully_paid_on` (not `date` / `type` / `fully_paid_on_date`),
  `business_events.occurred_at` (not `created_at`), `jobs.site_address` /
  `.site_suburb` / `.type`, `trade_invoices.week_end` / `.subtotal_ex` /
  `.total_inc` / `.xero_bill_id`. Rename in the select with a PostgREST alias
  (`date:invoice_date`) so the response shape callers expect stays intact — but
  remember filters and `.order()` must use the REAL column name.
- On any batched read whose emptiness is business-meaningful, check `error`.
  `_shared/pgrest.ts` exports `logQueryErrors()` for labelling a
  `Promise.all` batch; single reads that must not silently skip work should
  `console.error` and bail (see xero-sync Strategy 2).

Two known-broken queries are deliberately left 400ing with a `NEEDS A DECISION`
comment rather than papered over, because dropping the filter would match the
wrong rows: quote-number search in `ops-api` (`quote_revisions.quote_number`)
and the inbox-to-PO domain matcher in `monitor-inbox`
(`purchase_orders.supplier_email`). Both need a join rewrite, not a rename.

## Migrations Apply Before Edge Deploys

The production Edge Function workflow applies pending reviewed migrations before
deploying function code, then reruns the independent read-only schema gate.
The lane is documented in `docs/project-knowledge/EDGE_DEPLOY_LANE.md` and owned
by `scripts/apply-pending-migrations.sh`,
`scripts/migration-autoapply-exclusions.txt`,
`scripts/migration-autoapply-ledger-aliases.txt`,
`scripts/check-edge-schema-preflight.sh`, and
`scripts/edge-function-schema-requirements.txt`. The apply runner uses the
Management API, records a ledger row only after the migration transaction
succeeds, and never runs broad `db push`. Exact-file exclusions preserve audited
production ledger debt and fail closed on hash drift; serialized workflow runs
prevent concurrent deploys from racing the same pending migration.
The audited automatic boundary starts at version `20260722000001`; older sparse
production history remains in the manual lane.

Production carries migrations that are NOT in this repo (other lanes apply
directly through the Management API), so a new migration's version must be
checked against the LIVE ledger — `supabase_migrations.schema_migrations` — not
just against `supabase/migrations/`. A repository file whose version matches a
ledger row of a different name is a `ledger version/name collision` and fails the
whole deploy run before any migration or function ships. The fix is to renumber
the repository file (and its `supabase/rollbacks/` twin and every reference) to
an unused version, never to add an exclusion or alias — those account for
audited debt, not for a migration that still has to run. `bash
scripts/apply-pending-migrations.sh --dry-run` with a production
`SUPABASE_ACCESS_TOKEN` reproduces the gate read-only and is the cheap pre-merge
check. See the owning evidence document for incident-specific decisions.

The post-apply guard refuses only when a declared migration ledger version or
required queryable marker is absent; ledger name/checksum drift is advisory.
When a function selects a newly added column, keep the migration in the same
reviewed merge or land it first — otherwise the post-apply gate refuses deploy.
`jobs.quoted_value`
(`20260717000001_jobs_quoted_value_generated.sql`) is the current example:
`daily-digest` selects it, and as of 2026-07-20 the migration is still NOT
applied in production (a read-only check returned `42703`). **That means the four
`daily-digest` reads that select `quoted_value` are 400ing in production right
now** and, per the entry above, degrade to empty — the sales conversion,
pipeline, and margin-trend sections of the digest silently report zero. This is PRE-EXISTING and unrelated to the `ops-api` lean-read work; the fix
is to apply `20260717000001_jobs_quoted_value_generated.sql`. `ops-api` and
`reporting-api` do not select it — `reporting-api`'s `quoted_value` is a response
key derived from `pricing_json`, and `ops-api` `pipeline` deliberately projects
`pricing_json` paths instead so the read is not coupled to migration order.
Deterministic make-safe intake also requires
`20260721000001_makesafe_intake_production_controls.sql` and then
`20260721000002_makesafe_intake_full_open.sql` before its matching `ops-api`:
health and scan read those rollout/auth/selection columns. After the two
lineage-authority migrations below, apply
`20260724070000_makesafe_deterministic_standing_intake.sql` before its matching
`ops-api`: it permanently establishes bounded `deterministic` / `full_open`
standing authority (cap 10, empty exact allowlists). There is no legacy flip or
rollback ritual. Do not deploy code first. The 2026-07-24 lineage-authority correction
`20260724025815_makesafe_lineage_authority_corrections.sql` also lands before its
matching `ops-api`: the runtime reads effective source authority (and the guarded
`target_job_id` binding) from its append-only
`makesafe_intake_source_authority_corrections` /
`makesafe_intake_case_authority_corrections` ledgers. The migration only installs
those tables on a non-production database and applies the reviewed 335-case /
600-source false-`po:BOX` and AJ 70062 → SWMS-261055 data correction against the
exact production snapshot; it never writes a job, assignment, draft, status or
communication row. The second-round append-only overlay
`20260724062509_makesafe_lineage_authority_supersessions.sql` lands before its
matching `ops-api` for the same reason: the runtime reads its
`makesafe_intake_source_authority_correction_supersessions` ledger to apply the
reviewed authority splits, and rejects any supersession whose
`superseded_correction_id` or `prior_authority_case_id` no longer matches the
first-round result. It installs the table only on a non-production database,
records 33 correction-only authorities plus 2 cleared identity expectations
against the guarded snapshot, and likewise writes no operational row.
The U1 intake-accounting migration
`20260727012426_makesafe_intake_accounting_u1.sql` must also be applied before
its matching `ops-api`: cancellation lineage, source-issue accounting,
operational-fact loading, and legacy-drain reads select its new columns. It
writes no operational row and does not put the 752 existing exceptions on the
Captain board; island 2 owns that projector consumption.
Captain Amendments 45-46 keep paid AI extraction off permanently: automatic,
terminal-skill and manual intake checks all use the deterministic contract in
`docs/makesafe-intake-terminal-hook.md`. Every SES reporting skill run calls
`makesafe_reporting_intake_pass` exactly once; it runs one bounded scan and then
advances only clean/high-confidence drafts through the same guarded approval
function as the human review button. Explicit environment/database auto-file
brakes remain, but advance-what-passes is the default.

## Make-safe Scheduled Scan Completion Boundary

`makesafe-ses-poll` is called by `pg_net` with a 5-second request deadline, but a
bounded deterministic batch can legitimately run longer. Keep the nested
`scan_ses_makesafes` call owned by `EdgeRuntime.waitUntil`; never make the monitor
await the scan or paper over batch growth with a larger fixed timeout. The
standing entry point passes a four-source read cap to the deterministic runtime;
the runtime still enforces its 1..10 case cap and attempt ceiling.

The standing recent lane is a newest-first queue over physical SES sources without
a final case-source or classifier-exclusion fate. It pages only
`post_id,received_at`, then loads bodies/attachments for the two selected rows;
transient intake issues remain eligible. Keep the two-row historical lane, four
full-source bound, and eight standing PDF attempts unchanged. A selected source
that reopens an exception must bring its persisted authority closure inside the
same cap or receive a reason-coded deferral.

Apply `20260727020000_makesafe_intake_fresh_source_health.sql` before the matching
`ops-api`. Intake health is fresh-source coverage: it degrades when the oldest
eligible source without a final fate exceeds five minutes. Do not use the legacy
`last_inbound_email_at` or a successful function return as proof of current-mail
coverage.

Transfer the existing 10-minute mailbox lease to that continuation and release it
only when the nested scan settles, so the two-minute poll cannot launch overlapping
batches. A non-2xx or network-failed continuation must write both the aggregate
`makesafe.intake.scan_handoff_failed` event and a reason-coded `email_events_raw`
exception for every included source. HTTP 200 is not enough: verify each source has a
canonical case-source row and account for any remainder. Keep the two fates distinct:
a run that stopped at its per-run case or source-read cap has not reached those
sources, so they are `intake_deferred_scan_run_cap_deferred` /
`makesafe.intake.scan_handoff_deferred`; only an unbounded run that returned success
with sources still unfated writes the terminal
`intake_exception_scan_completed_without_case_fate`. Labelling deferral as an
exception alarms on healthy bursts and corrupts the replay accounting. If
source/accounting or alarm persistence fails, reject the continuation and retain the
expiring lease.

Apply `20260726000001_makesafe_company_parsing_rules_slug_correction.sql` before the
matching deterministic-intake edge code. Production slugs are `aj`, `bw`, and `wb`,
not the aliases targeted by the original seed. Every active company must have field
rules or both `intentionally_no_fields:true` and a non-empty `no_fields_reason`.

The 50-document PDF budget runs three strict tiers, never one flat priority set: exact
diagnostic seeds, then the bounded recent email half newest first, then sweep rows
oldest first. Seeds are old by construction, so folding them into the recent tier lets a
newer burst spend the whole budget before an explicitly seeded re-plan. Without the
tiering, old replay PDFs consume the budget before a clean new builder work order and
break the five-minute live-job law. The GET-only regression harness is
`scripts/replay-makesafe-five-fates.ts`; do not use runtime `dryRun` for a strictly
read-only production proof because dark observe intentionally advances its own cursor.

Deterministic instruction keys are long enough that 200 values overflow a reliable
PostgREST GET URL. Keep all case/lineage `.in()` filters on the runtime's 25-item
default chunk; the cap-1 continuation 500 is recorded in
`docs/makesafe-cap1-continuation-500-root-cause-2026-07-21.md`.

The deterministic sweep cursor is a completion checkpoint. A cancelled, rejected or
thrown run retains the prior cursor and rereads idempotently. A completed degraded
run writes truthful health, advances with the explicit
`scan_page_completed_degraded_retry_next_sweep` caveat, and retries when the bounded
sweep returns to the window head rather than letting one poison case pin every older
page. The cap-5 incident and 750-row explicit cursor recovery are recorded in
`docs/makesafe-cap5-timeout-root-cause-2026-07-21.md`.

## Fencing Job Mint Invariant

The fence browser must not mint permanent jobs, job numbers, GHL contacts, or
opportunities itself. The additive authenticated command is
`ghl-proxy?action=mint_fence_job`; its client contract and separately approved
release proof are in `docs/fence-mint-contract.md`, with atomic ledger/lock RPCs
in `20260721000001_fence_job_mint.sql`. Keep the request UUID stable across
retries, preserve tenant/role/mapping guards, never transfer `scope_json` in the
mint response, and never add quote/send/communication effects to this command.
Historical duplicate opportunity mappings are resolved by
`20260720235959_fence_opportunity_mapping_dedupe.sql` before the mint migration:
it audits every original mapping, unmaps only deterministic losers, and never
deletes jobs. The production evidence and ambiguous-case list are in
`docs/evidence/fence-opportunity-mapping-dedupe-2026-07-23.md`; never bypass the
post-dedupe zero-duplicate gate. Apply
`20260723000001_fence_job_mint_record_guards.sql` after the base mint migration:
untyped PL/pgSQL records must be protected by nested `FOUND`/owner guards, never
`FOUND AND record.field`, because a no-row result otherwise raises SQLSTATE
`55000`. Legacy non-fence create endpoints remain unchanged until separately
migrated.

## Assessment Cards Require The Prime Triad And Invoice Only

Assessment/quote cards require the work order plus three typed Prime links:
assessment report, photos, and quote (the builder may label quote as scope).
`makesafe_email_links.ts` is the canonical alias/type boundary. Completion
requires a headless locked/submitted capture with a screenshot for every member;
human confirmation alone is not evidence. The assessment recipe creates only
the invoice draft: $150 ex GST ($165 inc), or $130 ex GST ($143 inc) for
fence-only work. It never requires a SWMS, local report PDF, or separate photo
pack. The current contract lives in `ses_family_matrix.ts` and
`ses_prepare_docket_revision.ts`.

## Repair And Restoration Are Typed SES Families With Unsealed Recipes

Repair is a first-class non-urgent family alongside roof, assessment,
make-safe, and restoration. Its reporting recipe is not sealed, so repair
cards must remain visible and typed but cannot select a report, pack, portal,
SWMS, pricing, invoice proposal, or outbound-draft recipe; the matrix returns
`repair_recipe_unsealed`.

Restoration is a typed emergency-service family. Converted restoration cards use `jobs.type = 'insurance'` with
`metadata.insurance_job_type = 'restoration'`; that authority outranks any stale
`metadata.makesafe_job_family` value. The board, audit, trade scope and U4
adapter must keep those cards visible and typed as restoration. Until the
Captain seals a restoration reporting recipe, U4 must return
`restoration_recipe_unsealed` with the card facts and must not select a report,
pack, portal, SWMS, pricing, invoice-proposal or outbound-draft recipe.

## Roof Report Runs In ops-api, Not The Wiki Python

The SecureWorks own-letterhead roof report is a trade-filled template that
renders our branded PDF. The renderer that actually runs is the TS/jsPDF
`supabase/functions/ops-api/roof_report_render.ts` (sibling of
`makesafe_report_render.ts`), NOT the wiki `render_makesafe_report.py` - render
executes in ops-api. `roof_report_template.ts` is the single source of truth for
the field set, the locked storey pricing (Single $275 inc / Double $385 inc,
2026-07-16), validation, and the field->render-job mapping. Actions:
`roof_report_template` (read), `save_roof_report` (draft), `submit_roof_report`
(render + advance checklist), `render_roof_report` (routine-safe re-render). Fills
persist in `makesafe_roof_report_drafts` (one row per job, pack_kind `roof`).
`roof_report` is an allowed `attachMakesafeDocument` doc type and is deliberately
NOT subject to the make-safe report-type gate (generating our own report for
report-type jobs is the point). Full flow + action contract in
`docs/evidence/roof-report-template-flow-2026-07-22.md`.

## Production Edge Deploy Rule

`ops-api` and `send-quote` are production backend functions. They must have one
deployable reality only.

Production deploys are allowed only from:

- GitHub repo: `SecureWorks-GROUP/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`

Do not deploy these functions from dashboard repos, stale worktrees, feature
branches, temporary folders, or copied source trees.

Allowed local command:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
SW_API_KEY=... scripts/deploy-edge-function.sh send-quote
```

Disallowed command from any other folder:

```bash
supabase functions deploy ops-api
supabase functions deploy send-quote
```

If a local Supabase CLI guard is installed, this disallowed command will be
blocked automatically. Do not bypass the guard.

Why this matters: there is one live Supabase function slug, but this Mac has
multiple old local copies. A deploy from a stale folder overwrites production and
can remove live actions used by Ops, Sales, Finance, Evidence, Scope Freeze, and
quote sending.

If you are unsure, do not deploy. Open a PR or run the read-only smoke script:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```

## Make-safe Gap-Fill Is Subscription-Claude, Never The Paid API

The deterministic intake flags what it cannot resolve (`exception` /
`blocked_live_job` cases). Draining that backlog is the job of the batch AI
gap-fill, driven by the captain's SUBSCRIPTION Claude — the edge function calls no
model. Two ops-api actions: `makesafe_gap_fill_queue` (read the flags + the
report-submitted-but-pack-not-drafted jobs) and `makesafe_gap_fill_apply`
(additive audited write). Code in `supabase/functions/ops-api/makesafe_gap_fill.ts`
+ `makesafe_gap_fill_report_ready.ts`; the runnable procedure is
`docs/makesafe-gap-fill-batch-skill.md`; the trade-submit ping is designed (not yet
built) in `docs/makesafe-gap-fill-ping-design.md`.

Invariants (do not regress): fills are ADDITIVE (only currently-empty job-material
fields `client_name/client_phone/client_email/site_address/site_suburb`), never
overwrite a populated value, never mint builder WO/PO/reference identity, never
create a job or change state/reason_code/lineage, and never send. Each fill writes
`last_decision_provenance='ai'` + a fresh reason, which the case triggers record as
an append-only `case_update` event. There is deliberately NO approval gate. `apply`
is privileged-only (api_key / admin-owner jwt), NOT routine-callable; `queue` is a
read (routine-allowed). Report-ready reuses `selectDraftPackDueJobIds` so the queue
and the reporting run agree on "not yet drafted".

## Make-Safe Computed Status Cutover Is A Display-Only Ledger

M1 remains the pure engine in `makesafe_computed_status.ts`; the captain-approved
cutover is the append-only `makesafe_board_status_applications` ledger introduced
by `20260724005540_makesafe_board_truth_cutover.sql`. Apply the migration before
the matching `ops-api`. `makesafe_status_apply` is service-role/API-key only,
idempotency-keyed, exact-list guarded, and must never call operational status
writers. It records before/after/evidence/attribution and changes only the server
board projection; raw `jobs`, `makesafe_job_details.substatus`, assignments,
invoices and communications remain untouched. Archived/completed/cancelled
display stages and terminal job states are structurally read-only. The release
sequence and seven-card first tranche are in
`docs/makesafe-board-truth-cutover-2026-07-24.md`.

## Duplicate Board Cards: Prove One Instruction Before Archiving One

A shared claim reference plus a shared street is NOT a duplicate. Two cards are
duplicates only when they resolve the SAME single builder PO and that PO's
work-order PDF declares ONE instruction. MLB routinely issues several POs against
one claim (assessment + roof + make-safe are separate jobs), and the extractor
often attaches every one of that claim's work-order PDFs to every card, so
union-finding cards by shared PO token merges distinct jobs into a false group.
The 2026-08-01 re-verification of nine nominated groups found five were not
duplicates at all, and that in all four genuine pairs BOTH cards carried the
identical PO — so a "the card carrying the PO survives" rule decides nothing.
Evidence and per-group reasoning:
`docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`.

Archiving a loser is display-only and reuses the one board-status ledger
(`makesafe_board_status_applications`) via the additive pointer columns in
`20260801045000_makesafe_duplicate_survivor_archive.sql` — apply it before the
matching `ops-api`. Do not add a second board-status engine. The authorized group
list in `makesafe_duplicate_survivor.ts` is closed and hand-adjudicated: this path
has no discovery step by design, so no card that a human did not adjudicate can be
archived by it. `makesafe_duplicate_survivor_archive` is API-key-only and
dry-run-by-default; it refuses to write when the plan has any skipped group, and
it refuses a survivor that is itself terminal or already an archived duplicate so
an archive can never strand work. Never derive the survivor from the
`external_ref` string form: SWMS-261118 carries the fuller `MLB-26344PO-57087`
while the worked card SWMS-261065 carries the bare ref.

Board `archive` is overloaded: it is both "this card is dead" and "this job
finished more than seven days ago". `survivorArchiveIsNaturalCompletion` is the
only place that separates them, and a survivor qualifies as finished only with
its own derived `archive` stage, no status-application overlay, no duplicate
pointer, and an independent M1 `computed_status` of `archive`/`completed`. Widen
nothing else in that guard, and never work around it by forcing a plan through.
The RPC guards raw `jobs.status` and pointer chains rather than display stage, so
planner-side display rules need no migration.

For the current duplicate-survivor apply-set adjudication, including display
overlay handling, per-tranche apply ledgers and captain rulings, see
`docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`.

## The SES Phase A/B Board State Is Re-Provable, Not Just Documented

`scripts/ses-ab-certificate-checker.ts` re-proves the whole Phase A/B boundary
against live production, read-only, and exits non-zero on any failure. Run it
before trusting any claim about intake accounting or adjudicated board truth,
and after any new correction tranche. It needs only `SUPABASE_ACCESS_TOKEN`
(Management API `/database/query`, `read_only: true`); it refuses non-SELECT
statements and client-identifying columns before the request is sent. The dated
certificate, scope, ledgers, exceptions, and interpretation rules it backs are
authoritative in `docs/evidence/ses-ab-certificate-2026-08-01.md`.

## The SES Evidence Ruler Never Guesses A Captain Question

`supabase/functions/ops-api/makesafe_evidence_requirements.ts` is the Phase C1
ruler: the 49 family x display-stage evidence rows plus the pure
`readSesCardEvidence`. It is a read-only second opinion, NOT a second status
engine, and it must never gain a write, a stage move, or a dependency from
`makesafe_computed_status.ts` / the board read model.

Two rules hold the whole of Phase C up. A cell whose governing sources conflict
stays `question` and reads `unresolved_question` — promoting one requires a
Captain ruling that answers the named constant, never a code edit. And a card
short only on question cells is `undetermined`, never `fail`; only a `missing`
on a `required` cell fails. `ghl_equivalence` is the one question attached to an
item rather than a cell, so a GHL-only portal link is undetermined at required
AND optional cells.

Families and stages are imported from `ses_family_matrix.ts` and
`makesafe_computed_status.ts` rather than restated, and `unknown` is refused
rather than measured. `scripts/ses-measure-card-evidence.ts` is the read-only
single-card entrypoint C2 batches over; it reuses ops-api's own doc-boolean and
cycle-scoping derivations, and reports `stage_source` rather than implying a
stage. Contract, modelling decisions, transit heuristics and the verification
baseline are in `docs/evidence/ses-evidence-ruler-c1-2026-08-01.md`.

## The SES Money And Outbound Seal Is Write-Once

The write-once SES money/outbound seal and its approved invoice-void release
path are owned by `docs/project-knowledge/sync-layer.md`; deploy ordering and
build-stamped version truth are owned by
`docs/project-knowledge/EDGE_DEPLOY_LANE.md` and
`docs/project-knowledge/OPS_API_SOURCE_OF_TRUTH.md`. The shared runtime
boundary is `_shared/sealed_ses_money_fence.ts`.

The v2 authority bootstrap and full-board two-way reconciliation are owned by
`20260728060000_makesafe_board_reconcile_truth_u2.sql`,
`makesafe_state_seed`, and `makesafe_state_reconcile`. Both actions are
API-key-only, POST-only, and dry-run by default. A live seed is acceptable only
when the complete v2 comparison reports zero `projection_input_error` cards and
the SWMS-26980 U4 dry-run reports no `spine_missing_*` blocker. Reconciliation
may write only the display status ledger plus the on-card Captain-action ledger;
it must commit an exact `trustworthy | captain_marked` partition with
`neither=0`. Apply the safeupdate compatibility follow-up
`20260729020000_makesafe_family_pointer_safeupdate_guard.sql` before the
matching `ops-api`; keep live seed invocation dark until the migration-first
deploy and schema gate complete. Detailed ownership and sequencing live in
`docs/makesafe-board-read-model-v1.md`.

## SES Docs Ready Signoff Approves Exact Pack Bytes

Apply `20260728210000_makesafe_ses_docs_ready_signoff.sql` before the matching
`ops-api`. Audit-grade assembler output enters `needs_review`; only an identified
Captain/admin-owner can move the exact docket hash and assembler/family versions
to `signed_off`. Any new docket revision invalidates the old tick, and U6R
rechecks current signoff before every report/photo/invoice route send. The
authoritative API and gate code is in `ses_docs_ready.ts`,
`ses_docket_persistence.ts`, and `ses_reporting_actions.ts`; do not add a
client-only send bypass or a second family-completeness rule.

## The Repository Root Stays npm-Package-Free

This repo is Deno-rooted (`deno.jsonc` at the root). Deno 2 auto-discovers a root
`package.json` and would drag an npm toolchain into `deno check`, `deno cache` and
`deno task test:ops-api`. Any Node/npm project must therefore own a subdirectory
and keep its `package.json` / lockfile there — never at the root. Current example
and rationale: `docs/ses-reporting-proof-harness.md`.

## `ops-api/index.ts` Deno Check Must Stay Clean

`deno check --config deno.jsonc supabase/functions/ops-api/index.ts` is the
gate for honest validation of SES and other edge work. Do not re-accept a
non-zero error baseline.

Load-bearing type rules (see
`supabase/functions/ops-api/index_deno_type_baseline_test.ts`):

- Every live trade-portal action that has an inner `switch (action)` case must
  also appear on the outer trade fall-through list (`my_jobs` …
  `submit_makesafe_report`); otherwise TypeScript marks the inner case
  unreachable while the handler still exists.
- The `serve` handler must return a `Response` on every path — never
  `result = …; break` with an undeclared `result`.
- Mutual recursion (`syncFencingNeighbours` / `syncFromScopeJson`) needs an
  explicit `Promise<…>` return type.
- PostgREST id lists: use `collectUniqueStringIds` (or an equivalent
  source-aligned string guard), not `.filter(Boolean)` / untyped `Set` spreads
  that leave `unknown[]`.

## SES Synthetic Live-Fire Lab

The repeatable production-front-door proof is documented in
`scripts/test-lab/ses-synthetic-livefire/README.md`. Apply
`20260727080821_makesafe_synthetic_livefire_infrastructure.sql` and
`20260728030000_synthetic_livefire_readiness_cleanup.sql` plus
`20260728040000_synthetic_livefire_case_tombstone_cleanup.sql` before the
matching `ops-api`; the deployed cleanup contract must be
`ledger-bound-case-tombstone-purge/v2`. A full pass requires both Supabase
management access and the active production `SW_API_KEY`. Synthetic traffic is
self-addressed, permanently release-blocked, and cleanup is exact-marker
guarded. Mutable residue is deleted; append-only/group evidence is retained only
after terminal accounting excludes it from live boards, projections, and
fresh-source health.

## Deterministic Intake Notifies After Board Proof

The post-mint Hugo notification and honest five-minute denominator are owned by
`makesafe_hugo_notification.ts`,
`20260729010000_makesafe_hugo_notification_sla_v1.sql`, and
`docs/evidence/ses-hugo-notification-sla-v1.md`. Notify only a job with explicit
deterministic mint authority after the canonical server board contains it,
resolve the one recipient from staff/config authority, and persist the
once-per-job pre-send audit claim before GHL. Synthetic live-fire must
short-circuit before board, config, audit, or transport work. The ordered
extraction-belt and settlement release sequence lives in
`docs/evidence/makesafe-pdf-extraction-belt-2026-07-31.md`.

## Trade App Visibility Contract

The authoritative trade visibility contract, including the server-side lenses,
full-range Everyone feed, deliberate Mine/open-pool boundaries, pagination,
tenant scoping, and client follow-up, lives in
`docs/trade-all-means-all-v1.md`. Keep `_resolveManagerVisibility`,
`_managerBoardVerticals`, and `_resolveTradeJobFeedLens` in `ops-api/index.ts`
aligned with that document and their regression tests.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
