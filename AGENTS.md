# SecureWorks Agent Instructions

## Builder Portal Links Are Share Paths, Not Host Names

`urlIsBuilderPortalLink` in `supabase/functions/ops-api/makesafe_email_links.ts`
requires a share/report-style path and structurally rejects image/CDN/tracking
URLs. A `*.primeeco.tech` host alone is never enough —
`documents.primeeco.tech/.../logo.png` is not a portal. The merge boundary
(`mergeDeterministicAndClaudeLinks` / `normalizeReportExternalLinks`) is the
load-bearing filter; ops/trade display mirrors the same predicate so historical
polluted `external_links` rows stay hidden without a production strip. Do not
treat link liveness as a stage input (expiry is age, not failure). Tests:
`makesafe_email_links_test.ts` (F5), `dashboard/scripts/test-f5-portal-link-hygiene.js`.

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

Ops projection defaults to **card shape** (`fields=card`, response `shape:"card"`):
placement keys plus the presentation fields the kanban paints. Diagnostics
(`computed_status_evidence`, `derived_stage_v2_*`, fat `lineage` siblings,
`notes`, `job_identity`, …) and the flat `rows` duplicate opt in via
`fields=full` / `include_diagnostics=1`. Card mode must never re-derive a column
— `canonical_stage` stays declared ladder + display-ledger overlay. Do not
reintroduce a board-path dual-fetch of `makesafe_pipeline?history=all`; card
shape stamps `has_wo` / `invoice_status` / `site_suburb` / company slug so the
board is self-sufficient. Contract: `docs/makesafe-board-read-model-v1.md`.

Default ops board also defaults to **active columns only**
(`column_scope: "active"`): Archive is not hauled. On demand via
`include_archive=1`, `columns=archive` (optional `limit`/`offset`),
`columns=all`, or `fields=full`. Always publish `column_counts` and `archive`
meta so history never looks deleted. Placement for returned cards is unchanged.

Board **TTFB** after card shape + archive-on-demand is dominated by **serial
PostgREST round-trips inside `makesafePipeline`**, not payload bytes (active
and `include_archive=1` share the same TTFB class live). Keep
`fetchAllRowsInChunks` concurrent across URL-budget chunks, one dependent-read
wave in the pipeline, and active-scope skip of stage-dependent joins for
`jobs.status='archived'` (early-return archive; census only). Do not re-cut
card bytes and call it a TTFB win. Remeasure wall time on production after
every board-path change.

That concurrency is BOUNDED, and the bound is module-wide, not per call:
`CHUNK_FETCH_CONCURRENCY` in `makesafe_compact_reads.ts` (8, captain's cap
2026-08-04) limits total in-flight reads across every caller of
`fetchAllRowsInChunks` AND every other board fan-out whose width grows with the
board — today that means `makesafePipeline`'s typed + detail-authority
job-source lanes, active and cancelled, which build one raw paginated `jobs`
read per URL-budget id chunk and so acquire a slot via the exported
`withBoundedFetchSlot`. Any new growth-dependent fan-out on the board path must
do the same; why a per-call bound is not enough, and why pool exhaustion reads
as a board-truth outage rather than a slow board, is on that constant. Do not
re-serialise the dependent `Promise.all` and do not raise or drop the cap
without a measurement (`makesafe_compact_reads_test.ts` pins it in-call, across
a 10-wide wave, and after a failed chunk;
`makesafe_board_population_test.ts` pins the 20-lane job-source fan-out).

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

The forward mint invariant is one canonical builder instruction per card,
including terminal cards. The shared identity grammar, attach-time correction,
self-generated WO exclusion and pre-mint refusal live in
`makesafe_builder_work_order_identity.ts`,
`makesafe_work_order_identity_refresh.ts` and
`makesafe_instruction_mint_gate.ts`; the bounded proof and read-only impact
measurement are in
`docs/evidence/ses-f9-instruction-identity-forward-2026-08-02.md`. Do not turn
this into a board re-key/backfill or let `work-order-SWMS-*.pdf` count as a
builder instruction/evidence floor.

## The Purchase Order Is The Instruction Key; The Work Order Is The Group

Per the captain's 2026-08-02 ruling, `builderInstructionKey` is **builder scope
plus purchase order** (`MLB:PO-54000`). The work order and claim reference are
grouping and provenance and must never re-enter the identity — a composite
`claim+PO` key gives one purchase order two keys when its group reference
drifts, which is the twin the gate exists to prevent. `MLB-RR`/`MLB-MW` are one
scope with `MLB`. AJ keys on its job number (`AJ:JOB-67009`); repair keys on the
work order and fires only when a caller states the family. There is NO
claim-only fallback for anyone else: `bw` is Builderwest and `wb` is Western
Building, whose `WB69684-178656` references carry a second per-instruction
number a claim-only key would discard. Reference prefix outranks
`requesting_company_slug` (the slug is measurably wrong on real rows); the
slug->scope map is closed so an unknown slug yields no key.

Re-prove the grain against production before trusting any count, and after any
correction tranche: `scripts/ses-identity-grain-measure.ts` (read-only,
Management API). Always report DECLARED PO coverage (the card's own PO, 62/440)
separately from OBSERVED (any PO the grammar reads, including work-order
FILENAMES, 274/440) — MLB attaches every PDF of a claim to every card in that
family, so an observed token is not ownership. Contract, the measured
gains/losses, and the five open captain items (including `MLB:PO-54129`, one PO
that legitimately became two billed jobs) are in
`docs/evidence/ses-identity-grain-conform-2026-08-02.md`. Hostile probes:
`makesafe_instruction_key_po_grain_test.ts`.

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
  `.total_inc` / `.xero_bill_id`. Company identity is **not** on `jobs`: live
  `jobs` has no `requesting_company_slug`, `requesting_company_id`, or
  `external_ref` — those live on `makesafe_job_details` (and company rows on
  `makesafe_companies` via `requesting_company_id`). Selecting any of them from
  `jobs` is a production 400 (`column jobs.requesting_company_slug does not
  exist`); the mailer ops route shipped once on that phantom. Rename in the
  select with a PostgREST alias (`date:invoice_date`) so the response shape
  callers expect stays intact — but remember filters and `.order()` must use
  the REAL column name.
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

## Repair And Restoration Are Typed SES Families With Sealed Physical Pack Recipes

Repair is a first-class non-urgent family alongside roof, assessment,
make-safe, and restoration. Restoration is a typed emergency-service family:
converted restoration cards use `jobs.type = 'insurance'` with
`metadata.insurance_job_type = 'restoration'`; that authority outranks any stale
`metadata.makesafe_job_family` value. The board, audit, trade scope and U4
adapter must keep those cards visible and typed.

Captain 2026-08-02 (`data/decisions/2026-08-02-docs-ready-repair-restoration.md`):
repair "match[es] the whole existing system"; restoration is "exactly the same
as any other job, so it is a different family type". Both keep family identity
and assemble on the physical labour/materials pack path — matrix rows in
`ses_family_matrix.ts` with `family` repair/restoration and
`job_type: physical_makesafe` (same pattern as temporary_fencing). Evidence
ruler: `physicalShapedFamily()` for both. Do not invent a weaker pack shape.

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

## The Ops Dash UI Lives In The `dashboard` Submodule

`dashboard/` is a git SUBMODULE of `SecureWorks-GROUP/secureworks-ux` (see
`.gitmodules`) — `ops.html`, `trade.html`, and their Playwright tests live THERE,
not in this repo, and the pinned commit here is routinely far behind ux `main`.
For any Ops Dash / Trade App UI work: `git submodule update --init dashboard`,
then branch the submodule off ITS `origin/main` (not the stale pin). UI changes
ship as a secureworks-ux PR; this repo's gitlink is only bumped by occasional
pointer chores — never point it at an unpushed commit.

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

## U4 Generates Its Own SWMS; It Never Reuses An Attached One

`renderSesSwmsPdf` (`ses_swms_render.ts`) is the sealed deterministic renderer,
bound directly as `renderSwmsArtifact` in
`createSesAssemblerRuntimeDependencies`. Reusing a staff-attached SWMS PDF was
rejected in #432 (a stale attachment violates the current-cycle input contract),
which is why `resolveSwmsArtifact` still exists but is consumed by nothing —
leave it alone, it backs a pinned defect test, and do not re-enable it.

`buildSesSwmsGenerationPlan` is the fact gate and runs BEFORE the renderer: eight
real facts (crew included), each provenance-stamped by `sourcedText`, no default
and no carry-over. Missing any one is `swms_generation_facts_missing` and the
renderer is never called — that refusal is the safety guarantee, so never
"recover" it with a placeholder. Requirement scope lives in `swmsDecision` +
`ses_family_matrix.ts` (`swms_policy: always` for MLB only), not in the renderer;
wiring or changing the renderer must never widen which cards need a SWMS.

Because the dependency is optional and every preparer test stubs it, an absent
binding is invisible to the whole suite and surfaces only in production as
`swms_generation_capability_unavailable`. Tests asserting a runtime capability
must therefore drive the real factory, not a stub. Evidence, the production
measurement and the regression/control pair:
`docs/evidence/ses-swms-renderer-runtime-binding-2026-08-02.md`.

## The Docket Persist Path's Budget Is Spent On Re-Encodings, Not On Photos

Every `WORKER_RESOURCE_LIMIT` (HTTP 546) on `prepare_ses_docket_revision` so far
has been a **re-encoding** of bytes we already held, never the photo work
itself. Twice now the plausible hypothesis ("too many photos") was wrong and the
measurement found a byte-to-string conversion: `sesSha256(Array.from(bytes))` in
`artifactFromBytes` (~20x, fixed in `7f7cb5f`), then
`physicalReportRenderJob` building a binary string one `String.fromCharCode` at
a time and base64-ing it for EVERY current-cycle photo (measured 6-8x heap
growth, 206-280 MB for a 33.5 MB photo set). Raw byte buffers are external to
the V8 heap; strings are not, which is why an encoding costs many times what the
bytes do.

So before touching the artifact set, profile. `deno test --allow-run
supabase/functions/ops-api/makesafe_report_photo_budget_test.ts` (and
`ses_artifact_hash_budget_test.ts`) reproduce the limit honestly in a subprocess
under a hard `--max-old-space-size`; both are SKIPPED/red under
`deno task test:ops-api`, which grants no `--allow-run`. Board volumes to size
against, measured read-only from `storage.objects` metadata: heaviest SES card
51 photos / 33.5 MB, then 69 / 27.9 MB and 50 / 20.9 MB.

jsPDF accepts a `Uint8Array` directly and emits a byte-identical image stream, so
`MakesafeReportPhoto.bytes` is the form to use; `bytesBase64` and `url` stay
supported for the legacy pack path. `makesafeReportHashInput` deliberately
records the BASE64 length whichever form arrives, so moving a caller between them
cannot re-version rendered reports. The renderer's own
`DEFAULT_REPORT_PHOTO_LIMIT = 8` / `MAX_REPORT_PHOTO_LIMIT = 40` bound what is
embedded in a single report PDF (bind still accounts every current-cycle
`job_media` id; the 8 MiB report budget is the size gate). Those caps do NOT
bound what the docket hashes, uploads or lists, and reducing either to save
memory is forbidden.

## Portal Completion Has Two Producers

The trade roof-report confirmation contract, including its producer boundaries,
authorization, idempotence, and deploy ordering, is owned by
`docs/evidence/ses-roof-trade-confirmation-2026-08-02.md`. Keep the implementation
and migration aligned with that document and its regression tests; do not add a
third portal-capture producer or make the attestation a board stage.

## A Report Card Waits In `awaiting_portal_completion`, Not `ready_to_invoice`

Intake parks every newly approved report-only (roof / assessment) card in the
`awaiting_portal_completion` substatus. Apply
`20260802010000_makesafe_awaiting_portal_completion_substatus.sql` before the
matching `ops-api`; it only widens the `makesafe_job_details.substatus` CHECK and
writes zero rows. Keep `pending_allocation` in that CHECK — it is live production
drift (11 rows) that no repo migration declares.

Three engines must agree the state maps to **Allocated**: the legacy ladder
(`index.ts` `_deriveMakesafeBoardStage`), M1 (`makesafe_computed_status.ts`, which
owns the one exported constant every consumer imports), and the v2
`expectedStageForSubstatus` — the last is load-bearing, because an unrecognised
substatus is a hard `projection_input_error` and a live v2 seed needs zero of
those. Nothing advances the card automatically: it is deliberately a PRE-report
substatus, so `PORTAL_GUARDED_ADVANCE_SUBSTATUSES` still gates every forward move,
and `mark_makesafe_portal_report_done` is the single explicit portal-completion
event that leaves it. `ready_to_invoice` is a board substatus only — no invoice,
pack, send or digest path selects on it. Evidence, the money proof, the trade
open-pool consequence and the before/after parity run:
`docs/evidence/ses-f4-report-intake-stage-2026-08-02.md`.

## `makesafe_content_hash` Is A ROW Fact Hash, Never A File Byte Hash

Despite the name and the `sha256:<64hex>` shape, this column is stamped by
`stamp_makesafe_fact_identity_v1` (`20260728060000_makesafe_board_reconcile_truth_u2.sql`)
over `to_jsonb(NEW)` minus `makesafe_fact_version` / `makesafe_content_hash` /
`updated_at`, digested as `'SecureWorks:make-safe-fact:v1:<table>\n' || canonical_json`.
It includes the row's own `id`, so it **cannot** equal the stored file's sha256 by
construction. It pairs with `makesafe_fact_version` so `makesafe_state_compare.ts`
and the board reconcile engine can tell whether a row changed. One BEFORE trigger
serves six tables (`job_documents`, `job_media`, `job_service_reports`, …).

A card's real byte-integrity coordinates live elsewhere and are what
`inspectSesSupportingReportProof` / `sesSupportingReportDocumentBinding` enforce:
`job_documents.data_snapshot_json.curated_source_expected_raw_sha256` /
`report_render_hash`, and the docket artifact's `metadata.expected_raw_sha256` /
`output_sha256`. Measured 2026-08-06: of the 31 curated-bound report rows,
**0** have `makesafe_content_hash` equal to their bound byte hash. That is the
whole population, not a defect — comparing the two produced one high-severity
false "the integrity column is lying" finding on a live money card.

Do not "repair" the column to a byte hash: the BEFORE trigger recomputes it on
every write so it would not persist, and if it did it would corrupt the state
comparator. Changing its meaning is a migration across all six tables.

Known adjacent confusion, unfixed: `ses_mailer_ops_send.ts` reads
`job_media.makesafe_content_hash` as a photo byte hash (falling back to
`sesSha256Bytes` only when absent, which for make-safe media never happens), so the
audited `content_hash` on a builder-facing attachment does not attest the bytes
sent. It still uniquely keys each row, so no wrong attachment ships. Evidence:
`data/mosman-doc-integrity-f01-f02-v1/report.md`.

## A DRAFT Invoice Never Closes A Card, And The Visible Ladder Has A Version

`_makesafeInvoiceIsRaised` (AUTHORISED / SUBMITTED / PAID) is the invoice term of
`invoiceDone` in BOTH `_deriveMakesafeBoardStage` and `enrichMakesafeBoardJob`;
a test pins the two copies together at source. `hasActiveMakesafeInvoice` (any
non-VOIDED/DELETED row, DRAFT included) must never be the closure signal again —
a DRAFT is unpayable, so reading one as "invoice done" both filled Docs Ready
with unsendable cards and let an attached draft PDF archive a report card.
`invoiceIsDraft` / `readyForReview` are the opposite case and stay unchanged:
the captain's ruling REQUIRES a DRAFT invoice to reach Docs Ready. The two
non-invoice terms (`jobs.status='invoiced'`, substatus `complete`) are operator
declarations and are deliberately untouched.

On a REATTEND card the ladder must still see a qualifying current-cycle DRAFT.
`allowCloseoutFromEvidence` is a blunt `!hasReattendBoundary(detail)` and says
nothing about a particular invoice, so `enrichMakesafeBoardJob`'s
`invoiceForStage` may suppress closeout on reattend but must NOT blank the
invoice outright — that ran the cycle guard a second time, more crudely, and
destroyed the precise per-invoice answer the shared qualifier already computed
(`invoiceBelongsToCurrentAttendance`: a draft created at/after
`last_reattend_at` is current, missing stamp fails closed). The card then
derived `trade_report_in` while the SAME row published
`invoice_qualifies_as_current_draft: true` — an internally contradictory board
that hid ready cards from the Captain (White Gum Valley SWMS-261114, Koondoola
SWMS-261025, 2026-08-06). Passing a `qualifying_draft` through is closeout-safe
by construction: `qualifies` requires `status === 'DRAFT'` and every closeout
driver requires `_makesafeInvoiceIsRaised`. Leave `invoice_raw_status` /
`invoice_date` / `invoice_created_at` suppressed — those are completion-time
inputs. Diagnose such a card from `invoice_draft_qualification_reason`, never
from `commercial_warning`, which fires on every reattend regardless of the
invoice. Regression + three controls:
`makesafe_reattend_current_draft_stage_test.ts`.

`MAKESAFE_STAGE_LADDER_VERSION` versions the visible ladder (published as
`declared_stage_engine_version`, advisory, ops payload only) so a measurement
can name the derivation that produced it. Bump it whenever the ladder's output
changes; do NOT bump `MAKESAFE_BOARD_CONTRACT_VERSION`, which versions payload
shape. Contract, the 407-card before/after and the residual `ready_to_invoice`
mechanism that still holds 11 cards in Docs Ready:
`docs/evidence/ses-draft-invoice-not-a-raised-invoice-2026-08-02.md`.

Two measurement rules from that release generalise. Pin the parity harness to an
explicit `--now=` on both sides or the 7-day completed/archive clock moves under
you. And a `ses-e1-freeze-stage-baseline.ts --mode=verify` "no longer disputed"
failure can mean CONVERGENCE (the legacy ladder caught up to the certified
corrected destination) rather than drift — check each card against its frozen
`post_cutover` before treating it as a defect, and still never re-snapshot v1.

## Authorised Invoice PDF Bind Is Recoverable Without Re-Approval

When an obligation is already `authorised` (or its `xero_binding.status` is
AUTHORISED) but a later docket re-prepare left the current pre_xero pack without
the Xero PDF, `execute_ses_invoice_revision` routes into
`recoverAuthorisedInvoicePdfBind` (`ses_reporting_actions.ts`): reconcile the
exact stored Xero identity, `fetchAuthorisedPdf`, and
`commit_ses_invoice_bound_docket_v1` against the **current** docket. Never mint,
re-authorise, void, or send. Identity mismatch (invoice number / Xero id /
total) refuses. Idempotent on replay. Do **not** generalise this into a
`stale_review` bypass for unauthorised revisions. A card with a raised invoice
and report evidence that is not yet sent must stay in Docs Ready
(`authorisedAwaitingSend` / ladder v4) — never regress to `trade_report_in`
after money is committed.

The same shape applies at SEND IT: `approveSesReleaseRevisionAction` looks for a
human APPROVE INVOICE row against `boundDocket.based_on_revision_id`. After a
re-prepare that row can be orphaned even though money already authorised.
`sesReleaseInvoiceApprovalSatisfied` accepts a missing row only when the member
docket is `stage=invoice_bound` **and** the bound obligation's
`xero_binding.status` is AUTHORISED (case-insensitive) — AUTHORISED is
downstream proof that `execute_ses_invoice_revision` already ran under the
approval gate. Non-AUTHORISED still refuses. Docs Ready signoff, recipients,
readiness, and the money fence are untouched. Neither read may degrade into that
business refusal: `sesReleaseInvoiceApprovalReadRefusal` turns a PostgREST fault
on the approval read, or a fault/absent row on the obligation read, into the
distinct `invoice_approval_unreadable`, so a read fault never tells an operator
to re-approve money that is already AUTHORISED. Tests:
`ses_release_invoice_approval_gate_test.ts`.

## `spine_missing_lineage` Is Almost Never About Lineage

The blocker fires on `!lineage_id || !job_id || !source_content_hash`
(`ses_prepare_docket_revision.ts`). Measured 2026-08-03: **zero** live intake
cases on the board are missing a lineage id; **103 of 163** are missing
`source_content_hash`. Read the name, go hunting for lineage, and you will find
nothing wrong. This corrects the batch-4 reading that "where intake ran the
spine is perfect" — intake running is NOT sufficient, and about two thirds of
the cased jobs are blocked too, so the repair population is 377 of 437, not the
274 caseless.

The hash is DERIVED, not supplied: `stamp_makesafe_intake_case_identity_v1`
computes it from the case row itself (minus its own identity columns and the
trigger-maintained timestamps). There is no upstream producer to build. It is
absent only because the trigger has no backfill and a settled case row is never
rewritten, so every case created before `20260728060000` is unstamped and every
one after it is stamped — closed historical debt with a hard cutoff.

Note which canonicaliser the hash uses: `makesafe_canonical_json_v1` RAISES on
any non-integer number, but production's `makesafe_fact_hash_v1` calls the
decimal-tolerant `makesafe_fact_canonical_json_v1` (`20260729030000`), which is
total over jsonb. Do not repoint it. Separately,
`enforce_makesafe_intake_case_write` still requires `job.type = 'makesafe'` even
though the seed scope was widened to restoration — so touching an intake case
bound to a restoration job throws and fails the whole chunk.

The repair is the EXISTING `seed_makesafe_state_authority_scoped_v2`. Two doors,
one producer, deliberately different operations: `makesafe_state_seed` is the
full-board sweep whose acceptance gate is board-wide and which refuses to be
narrowed, and `makesafe_state_seed_scoped` is the named, hand-adjudicated tranche
(job numbers not ids, every named card must resolve or the request is refused,
capped at 25, `board_complete:false` always). Never call
`seed_makesafe_state_authority_v1` directly — the v2 wrapper is what partitions
and ledgers the run. `deriveSesSpineFacts` is reporting only and is pinned to the
real adapter by `ses_spine_diagnostic_parity_test.ts`; do not let it become a
second status engine.

The seeder is NOT identity-only: per job it may create an attendance cycle and
rebind cycle attribution across six tables, and it writes two GLOBAL rows
(`makesafe_family_rule_revisions` / `_current`) regardless of selection size —
inert today only because nothing reads them. The 2026-08-03 batch-5 run
completed four ledgered tranches (4/25/25/6), seeding 60 named cards with 0
skips and no identity overwrite; this is a completed scoped proof, not
permission for an unreviewed board-wide sweep.
Population, tranche order, the money-seal analysis and the caseless-intake cause
are in `docs/evidence/ses-spine-seeder-scoped-route-2026-08-03.md`.

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

An overlay only binds while its `source_status` equals the freshly derived
`board_stage`, so before calling a ledger row stale, read the card's CURRENT
derived stage — linking an AUTHORISED invoice to a card with no close-out docs
moves it to `report_ready` on its own. Never diagnose a display stage from the
rendered board alone: `ops.html` retries `makesafe_board` twice and then silently
falls back to `makesafe_pipeline`, which buckets on raw `board_stage` and never
reads `makesafe_board_status_current`, so on that fallback EVERY captain display
transition is invisible. Any non-200 from `makesafe_board` is therefore a
board-truth outage, not a missing panel. The intake-exception desk may degrade
and the board may not: `_loadIntakeExceptionProjectionForBoard` catches, alarms,
and returns `degradedIntakeExceptionProjection`, whose `degraded` marker (null on
a healthy read) is what tells a consumer an empty desk is unreadable rather than
clean. Never widen that catch to the canonical rows, and keep
`makesafe_intake_exception_read` throwing. Worked example, including the
2026-08-01 `intake source issue uniqueness violated` outage:
`docs/evidence/ses-261124-archive-display-diagnosis-2026-08-01.md`.

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
authoritative in `docs/evidence/ses-ab-certificate-2026-08-01.md` — read its
2026-08-01 addendum before quoting any count from that document's body.

Two rules govern how a failure may be answered, because the cheap fix for each
is the wrong one:

- **The phase A census is an identity manifest, not a pinned count.** `a3`/`a4`
  diff the certified identity sets by membership and assert invariants
  (`evaluateCensusInvariants`): keys partition into
  live-job / exception-only / synthetic, no key or live case is destroyed,
  promotion runs exception -> live only, the synthetic set stays closed, and a
  `confirmed_live_job` case always has its job. Growth above the floor is
  reported, never failed. The manifests are the re-certification snapshot and
  must never be trimmed or re-snapshotted to make a failure green; a missing
  certified identity or a count moving DOWN is the defect these checks exist to
  catch.
- **A merge group may be accounted without being settled.** Adding a work order
  to `ses-ab-certificate-v1.duplicate-accounting.txt` is what clears a `d1`
  `unaccounted`, and the disposition records what was actually decided.
  `captain_hold_live_pair` is the honest disposition for a group proved to be
  one instruction whose survivor the standing ruling cannot pick while BOTH
  members are live; it must name a decision key, and `d3` fails if a member goes
  terminal or gains a duplicate pointer, so a stale hold cannot absorb a real
  change. Do not widen the older `open_hold` rule (at most one live card per
  work order) to fit such a group — that guard protects the other holds.

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

A Captain ruling is recorded, never absorbed — and so is a ruling that
OVERTURNS one. `Q_PO_FLOOR` is the worked example of both: it stays exported
carrying a `resolution`, sits in `SES_RESOLVED_CAPTAIN_QUESTIONS` rather than
`SES_CAPTAIN_QUESTIONS`, `q()` throws if a resolved question is ever named by a
cell again, and the ruling it replaced is kept verbatim under
`resolution.supersedes` with its date, its measured effect while it governed,
and the reason it stopped. Never delete a ruling to make the table read
cleanly. Answer or re-answer a question that way, bump
`SES_EVIDENCE_CONTRACT_VERSION`, and every past measurement stays attributable
to the ruler that produced it.

The current floors, both from the 2026-08-01 rulings
(`data/decisions/2026-08-01-po-wo-invoice-ruling.md`):

- `po` is OPTIONAL in all 49 rows — a purchase order is expected but its
  absence is not a failure. It stays OBSERVED: every reading still reports
  `observed_present` and the measured detail, so the PO is visible on the card
  without ever being a gate. (The superseded "of course every card needs a po"
  answer, which made it REQUIRED, was about work orders.)
- `builder_wo_doc` is REQUIRED at every non-cancelled stage of all SEVEN
  families, `completed` and `archive` included — nothing to invoice against
  without a work order. It stays a question only at `cancelled` (under the open
  `cancelled_floor`). Repair and restoration were the two unsealed recipes this
  ruling did not reach; the Captain's own 2026-08-02 ruling sealed them onto the
  physical-shaped table (`Q_REPAIR_RECIPE` / `Q_RESTORATION_RECIPE` now carry a
  `resolution`), which is how a recipe is sealed — by a recorded ruling, never
  by a code edit alone.
- SWMS is deliberately NOT encoded here. "Required only for MLB make-safes"
  turns on builder identity, which a family x stage table never sees; the
  builder-aware rule is sealed in `ses_family_matrix.ts` (MLB `always`, AJS
  `builder_waiver_unless_hrcw`, everyone else `hrcw_only`). `report_only_swms`
  stays OPEN pending plan-v2 C.11, because flattening the high-risk-work
  trigger to N-A by builder identity is a safety call, not a paperwork one.

Families and stages are imported from `ses_family_matrix.ts` and
`makesafe_computed_status.ts` rather than restated, and `unknown` is refused
rather than measured. `scripts/ses-measure-card-evidence.ts` is the read-only
single-card entrypoint, and `scripts/ses-c2-measure-board-evidence.ts` batches
it over the named SES population in nine read-only queries — run that before and after
any ruler change and report both count sets. Contract, modelling decisions,
transit heuristics and the verification baseline are in
`docs/evidence/ses-evidence-ruler-c1-2026-08-01.md`; the first PO ruling and its
measured board effect are in
`docs/evidence/ses-c3-po-ruling-and-suburb-backfill-2026-08-01.md`; the
supersession, the work-order floor and the bracketed before/after sweep are in
`docs/evidence/ses-b1-ruler-v2-2026-08-02.md`.

## `jobs.site_suburb` Is Suburb-Scoped, And Backfills Are Ledgered

The Ops board renders `jobs.site_suburb` alone and falls back to the literal
"Suburb TBC", so a full address written into that field would put a client's
street address on the board. Extract the suburb; never widen the field.
`scripts/apply-ses-c3-suburb-backfill-v1.ts` is the pattern for any card-data
backfill here: a closed hand-checked fixture with no discovery step, live
re-derivation at both dry-run and apply time (production is the data source,
the fixture only authorises), writes through the existing typed ops-api
`update_job_field` action rather than raw SQL, a committed before/after ledger,
and a `--mode verify` re-read that also proves board stage unchanged. Evidence:
`docs/evidence/ses-c3-po-ruling-and-suburb-backfill-2026-08-01.md`.

The forward extraction bug is still open: `makesafe_deterministic_intake.ts`
sets `site_suburb` from the email SUBJECT only and no builder parsing rule
defines the field, so a body-address builder keeps producing blank suburbs. The
in-repo `addressSuburb()` also misses a comma before `WA` and a trailing
`, Australia`; `deriveSuburb()` in the backfill script handles both and is the
reference for that fix.

## Missing SES Work-Order PDFs Are Re-Attached, Never Re-Minted

An SES card with no `work_order` `job_documents` row usually still has the
builder PDF in the private `makesafe-emails` bucket. Recovering it is a
COPY through the sanctioned ops-api `attach_email_attachment_to_job` action
(which delegates to `attachMakesafeDocument`, so the typed row, the
`job_id`+`type`+`file_name` idempotency key, trade visibility and the event
ledger match every other attach). Keep the artifact's own file name so the
forward intake path `ensureIntakeWorkOrderEvidence` collides with it instead of
creating a twin, and never move, rename or delete the `email_attachments` row or
its object.

Only a case-bound, identity-verified artifact may be attached without human
adjudication: reachable from the card's OWN `makesafe_intake_cases` →
`makesafe_intake_case_sources.attachment_refs` chain AND with the card's own
`builder_wo_canonical` digits in its extracted PDF text (tranche 1,
`scripts/apply-ses-c3-wo-backfill-v1.ts` +
`docs/evidence/ses-c3-wo-backfill-tranche1-2026-08-01.md`).

Everything else is adjudicated per card before it is written (tranche 2,
`scripts/apply-ses-c3-wo-backfill-v2.ts` +
`docs/evidence/ses-c3-wo-backfill-tranche2-2026-08-01.md`; every verdict and its
agreement matrix is in `scripts/ses-c3-wo-backfill-v2.adjudication.json`). Two
rules from that tranche generalise:

- **Match builder references on DIGIT boundaries, never as a substring.** A
  four-digit reference (`BWCWA6771`, `BWCWA6773`) is a substring of unrelated
  five- and six-digit job and purchase-order numbers, and a `position()` /
  `like` test attaches another builder's work order. Require the reference in
  the document's own job/work-order-number field plus a second independent
  agreement (street number + street word, locality, or policyholder name).
- **Several work orders on one claim means SKIP unless a CARD-BOUND fact picks
  one** — a purchase-order token in the card's OWN stored documents, or exactly
  one candidate whose issue date falls inside the card's creation window. Scope
  wording and selection-by-exhaustion are inferences, not evidence. Two
  candidates are one artifact only when they share a content group (`sha256`,
  or `size_bytes` + extracted-text hash).

Because a tier-B/C artifact has no case to re-prove it against, the runtime
guard is the adjudicated `md5(pdf_extraction_text)` plus the artifact `sha256`:
a re-extraction refuses the write rather than attaching a document nobody read.

`builder_wo_doc` is not an input to `makesafe_computed_status.ts`, so a correct
re-attach never moves a board stage — prove it, do not assume it, by bracketing
the run with a C1 measurement. `scripts/ses-measure-card-evidence.ts` needs a
service-role key; `scripts/ses-c2-measure-board-evidence.ts` batches the same
ruler over the named SES population through the Management API alone, and lets verify
assert that NO board card moved.

## The SES Money And Outbound Seal Is Write-Once

The write-once SES money/outbound seal and its sanctioned SES-native paths (the
`create_ses_invoice_draft` DRAFT mint and the invoice-void release sequence) are
owned by `docs/project-knowledge/sync-layer.md`; deploy ordering and
build-stamped version truth are owned by
`docs/project-knowledge/EDGE_DEPLOY_LANE.md` and
`docs/project-knowledge/OPS_API_SOURCE_OF_TRUTH.md`. The shared runtime
boundary is `_shared/sealed_ses_money_fence.ts`.

`create_ses_invoice_draft` always runs the full live-ACCREC duplicate guard
(`fetchAllAccrecInvoices` + `resolveExistingInvoice` in `makesafe_send_pack.ts`)
before any Xero create — never skip it, never substitute the indexed
`resolve_ses_invoice_duplicates` probe (`scanned_full_estate: false`). The
guard's reference tiers are PO-scoped only when **both** the obligation
`proposal.reference` and the live invoice reference carry distinguishable PO
tokens. If the local proposal emits a claim-only builder ref (e.g. `MLB-27037`
for two cards that are really `…PO-56397` and `…PO-56459`), the second mint
correctly refuses as `invoice_duplicate_live` / `reference_substring`. That is
fail-closed money safety, not a reason to weaken the guard — fix the proposal
reference grain so multi-PO siblings can mint separately.

The seal is not a Xero-API fence — it fences the LOCAL money mirror, and
`linked` is one of the sealed verbs alongside created/authorised/changed/sent.
So "set `xero_invoices.job_id` on an SES card" is a sealed write even though it
touches no Xero record and no money column: every sanctioned writer refuses it,
and `linkContactInvoicesToJob` re-reads the target seal from the database so a
caller-supplied job shape cannot get around it. As of 2026-08-01 **all 440 SES
board cards carry an explicit `ses_money_sealed_at`** (source
`job_spine_backfill`), so this is the universal case, not an edge one. The two
approved release families void an invoice or release a delivery route; neither
links one. The Captain's 2026-08-01 ruling was to leave the seal alone and close
the gap on the READ side instead: `makesafe_invoice_reference_match.ts` is the
ONE implementation that matches a card to its card-unique UNLINKED issued ACCREC
(whole digit runs of >=5 digits, never a substring; the reference must be owned
by exactly one job across the FULL jobs table, both sides of a contest excluded;
one invoice may fund one card). Anything ambiguous stays `missing` by design.
The C1 entrypoint, C2 batch, the cohort deriver and **the C4 board UI** must all
consume it rather than re-deriving the rule. Bump
`SES_EVIDENCE_CONTRACT_VERSION` on any ruler-semantics change and bracket it with
a before/after `ses-c2-measure-board-evidence.ts` run. Evidence, the 51-card
cohort and the measured board effect are in
`docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`.

The seal permits exactly ONE read: fetching the bytes of an invoice PDF that
already exists (`get_invoice_pdf`), by the Captain's 2026-08-02 ruling. The
exemption is declared in `_shared/sealed_ses_money_fence.ts` as the closed
`SEALED_SES_MONEY_READ_EXEMPT_ACTIONS` set, and it is double-locked: the action
must be on that set AND the caller must be an identified operator (ops key, or
admin/owner JWT), which every write call site structurally omits. Do not add a
name to that set — created/authorised/changed/linked/sent all still refuse, and
`sealed_ses_money_fence_test.ts` fails on any widening (membership pin,
write-verb guard, and a 16-action re-refusal sweep run with the most privileged
caller). The gate itself is unchanged: a missing mirror row, an absent
authoritative job link, an unreadable classification and a synthetic live-fire
job each still fail closed before any Xero call. Evidence, the production
measurement and the front-end answer are in
`docs/evidence/ses-invoice-pdf-read-exemption-2026-08-02.md`.

The SES-native cockpit and pack reads show a bound Xero DRAFT by re-fetching the
Xero-rendered bytes through `makeSesXeroGateway().fetchAuthorisedPdf` (which
serves DRAFT as well as AUTHORISED, despite the name), never by adding an action
to that exempt set and never by rendering a local proposal table as though it
were INV-n. A DRAFT stays editable in Xero, so a stored `pdf_object_key` /
`pdf_content_hash` is a pointer to yesterday's bytes: it may back a signed URL
but must never be served as current, and a failed fetch is reported unavailable
rather than substituted. An AUTHORISED bind is proved instead by a docket
artifact whose metadata matches the bound invoice — no Xero call.
Contract: `data/ses-draft-invoice-create-409-v1/report.md` (Phase 3); tests:
`ses_invoice_tab_xero_pdf_test.ts`.

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

## Sealed Release Graph Send Is The Only Builder Pack Transport

Every builder-facing report / photo / invoice PACK ships here. The one other
builder-facing route is ops-visibility mail (next section), which is separately
audited and can never carry an invoice.

Approved SEND IT is `prepare_ses_release_revision` →
`approve_ses_release_revision` → `execute_ses_release_revision`. The Graph
gateway is `ses_graph_mail_gateway.ts` (wired from `makeSesGraphMailGateway` in
`ops-api/index.ts`): draft on `admin@`, HTML body + Maverick signature, stamp
the SES operation token on the non-visible header
`x-secureworks-ses-operation`, and prove Sent Items by matching that header
**client-side** (list newest → filter; hydrate single-message headers when the
folder list omits them; never OData `contains(subject,…)`). Builder-facing
subject, body and Xero invoice Reference must never carry `[SES-…]` / the
operation token — a legacy subject-token match remains only so already-stamped
in-flight messages stay reconcilable across deploy. Invoice mint reconcile
uses the local `xero_invoices.ses_external_token` mirror and the effect
`external_id` checkpoint, with legacy `Reference.Contains` only for historical
rows that still have the stamp. `send-outlook-email` refuses sealed SES jobs by
design — do not re-open it as a bypass, and do not add Mail.app. Exact-once
`graph_outcome_unknown` still means reconcile by token, not redispatch; refusal
facts must carry the underlying Graph error when one was recorded.

## Mailer Ops Visibility Send Is A Separate Audited Route

Captain-authorised ops mail to the builder **work-order mailer** (not
`makesafes@` / `report_recipient` billing packs) is
`ops-api?action=send_mailer_ops_visibility` in `ses_mailer_ops_send.ts`. It is
itself the audited route: `effect_kind=mailer_ops_send` (migration
`20260805020000_ses_mailer_ops_send_effect.sql`), report PDF provenance, capped
photos (module-local `MAILER_OPS_PHOTO_CAP` only — never import into pack/docket),
ordinary Graph Mail.Send from `admin@`, mandatory CC **`ses@secureworkswa.com.au`**
(intake mailbox = second proof surface), Sent Items proof with operation header.
`kind` is `report`|`photo` only — invoice is structurally impossible (types +
DB CHECK + no money attachment path). One `job_id` + kind per call so card one
can hard-stop before later cards. `dry_run` defaults true. Do **not** satisfy
this need by weakening `send-outlook-email` fences or by exempting addresses on
the sealed money fence. Tests: `ses_mailer_ops_send_test.ts` (wiring only; zero
Graph — green suite does not prove delivery). Evidence:
`data/mailer-ops-send-action-v1/report.md`.

Company identity and the builder `external_ref` are read from
`makesafe_job_details` / `makesafe_companies` — never from `jobs`, which carries
neither in production (see the wrong-column section above; the route shipped
once on that phantom and 400ed live). Re-verify every selected column against
live schema before another mailer deploy. Resolution order and the
billing-recipient refusal are owned by
`data/mailer-ops-send-action-v1/report.md`.

Three boundaries on that route are load-bearing. `body.to` is REQUIRED and only
confirmed against an allowlist (this card's own intake `emails.from_email` plus
the company's full-address entries) — `sender_patterns` is an INBOUND trust list
and must never auto-select a destination. The effect identity carries an
`artifact_hash` retry coordinate — kind, recipients and the operator's
`attempt_key`, and deliberately NOT the subject, attachment hashes or photo
selection — which is what `release_revision_id` is for `route_send`. Keep
re-resolved content out of it: a newly uploaded photo re-picks the spread and a
transient `emails` read error changes the recovered subject, so content in the
identity would mint a second operation_key and mail the builder twice. Content
lives in `payload_hash`, where drift reconciles the ORIGINAL effect. Exact-once
holds per attempt, and a stuck `unknown` token is still never redispatched — the
operator retries under a new `attempt_key`. Any call that did not itself
dispatch (`dispatched === false`: an already-confirmed replay OR a reconcile of
an earlier attempt's message) returns the STORED ledger proof and audits as
`mailer_ops_visibility_reconciled`; it must never recompose a proof, and the
effect `provider_digest` only carries subject/attachment claims when that same
call composed the message. Photo attachments are named from
the trade's `label` (ordinal-prefixed, `site-photo-NN.ext` when unlabelled);
never ship the storage UUID as the builder-facing file name. Evidence is current-attendance-cycle scoped through
the shared `makesafe_cycle_evidence.ts` boundary and excludes `phase:'receipt'`
media (receipts are cost evidence, not builder-facing site photos).

AJS/AJBR only (Captain 2026-08-04 / skill backend release contract): two routes
— `report_invoice` (report PDF + real Xero invoice PDF) then `photo`; TO
`workorders@ajs.build` + participants. **Permanent pack CC** (Captain 2026-08-06):
`ses@secureworkswa.com.au` **and** `vanessa@ajs.build` **and** `mandi@ajs.build`
on **every** AJS/AJBR pack email (report_invoice and photo). Domain is always
`ajs.build` — never `ajsbuild` / `ajsbuid`. Authoritative producer is
`ajsPackCc()` in `ses_release_route_shape.ts` (constants in
`ses_graph_mail_gateway.ts`); legacy `makesafe_send_pack` and
`checkExactRecipientGate` consume the same list via
`requiredPackCcForReportRecipient`. Do **not** put vanessa/mandi on the To.
The execute envelope gate applies the widened set only to a release with no
`route_send` effect yet; one already dispatching keeps the `ses@` floor it was
approved under, because a stored envelope cannot be rewritten and re-preparing a
half-sent release re-mails the builder. An unreadable send ledger refuses as
`route_send_proof_unreadable` rather than guessing a floor. That boundary and the
live domain audit are owned by `docs/evidence/ajs-cc-routing-fix-2026-08-06.md`.
Builder-facing body copy is plain client English (what is attached, the job
reference, thanks) and carries no internal vocabulary: no draft, docket, pack,
route, cycle or revision. `resolveDocketRoutes` (`ses_reporting_actions.ts`) SETS
that body rather than inheriting `report?.body` / `photo.body`, so a draft stored
under older wording cannot leak it into builder mail; `buildEmailDrafts`
(`ses_prepare_docket_revision.ts`) writes the same wording at prepare. Both
places are pinned by `ses_release_route_shape_test.ts` and
`ses_prepare_docket_revision_test.ts`; keep the wording duplicated in the two
producers rather than abstracting it.
MLB pack routing is untouched (`makesafes@` / finance@ invoice path). Client-send
gate kinds match the skill table exactly: `report_invoice`, `report`, `photo`,
`invoice` in `makesafe_send_pack.ts` (`checkSesClientSendRouteGate`). Route
order lives in `ses_release_route_shape.ts`. Apply
`20260804090000_ses_release_report_invoice_route_kind.sql` before the matching
`ops-api` (widens `route_kind` and allows two-route `commit_ses_release_revision_v1`).
Wiki skill `secureworks-makesafe-reporting` references
(`email-routing-and-approval.md`, `path-board.md`, `close-out-contract.md`) must
stay aligned with `ajsPackCc()` — code is authoritative for what actually sends.

MLB physical (Captain 2026-08-05 / Maylands): three routes, two destinations —
`report` / `photo` / `invoice` order. **Locked design** is report+photo as
replies on the ses@ group intake thread (`intake_thread_id` via
`ses_mlb_thread_reply.ts`); `invoice` is the billing pack to `makesafes@`
(report + AUTHORISED invoice + SWMS, finance@ cc). Thread coordinate authority
is unchanged: case_sources first; empty sources may recover via approved draft
→ emails; corroboration not recency. AJS shape is untouched. Report-only MLB
families keep the legacy non-threaded split.

**TEMPORARY CAPTAIN EXCEPTION (2026-08-05):** Microsoft marks
`conversationThread: reply` as Application: Not supported, so app-only Graph
403s on group-thread reply (Maylands first live failure). While
`MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1` is true in `ses_mlb_thread_reply.ts`,
report and photo use ordinary admin@ `Mail.Send` (draft → send → Sent Items proof
by `x-secureworks-ses-operation`), same transport as Munster/invoice. Routes stamp
`mlb_transport: ordinary_mail_send_captain_exception_v1` and keep intended thread
ids as audit-only. Optional RFC `In-Reply-To` is best-effort only — never block
send. This is **not** the silent default; flip the flag false to restore locked
thread-reply once a supported auth model exists. A stuck `unknown` route_send
effect is exact-once (reconcile only, never redispatch); a new release revision
gets a new operation_key. Do not soften `graph_outcome_unknown`.

Photo (and any multi-attachment) volume is guarded **before the first Graph
call** by `ses_photo_mail_volume_guard.ts` — named
`photo_mail_volume_exceeds_graph_limit`. Documented ceilings: Exchange Online
default **35 MB** message size; group-post / direct attach **under 3 MB** per
file; user-mailbox upload session **3–150 MB** per file (group thread replies
have no upload session and inline base64). Per-file ceilings compare RAW bytes;
the 35 MB message ceiling compares the **base64-encoded** total on BOTH
transports, because mail travels MIME-encoded — comparing raw there passed the
measured 51-photo / 33.5 MB pack (~42.6 MiB encoded) that Exchange would reject.
AJS photo uses the sequential per-file `uploadAttachment` loop in
`ses_graph_mail_gateway.ts`; MLB photo is one group-thread reply in the locked
shape, and rides the same user-mailbox loop while the ordinary-mail Captain
exception above is on. Transport is resolved from the route that will actually
send (`resolveSesMailTransport` on the post-`applyMlbThreadReplyToRoute` route,
`resolveSesMailTransportForPrepare` at prepare), so prepare and SEND IT can
never disagree about the per-file ceiling.
**Never cull, downscale, or re-encode photos to fit** —
a pack over the ceiling is an honest blocker/refusal, not a shortened pack.
Multi-email split is a Captain recommendation only, not implemented here.
Evidence + measure script: `docs/evidence/ses-photo-mail-volume-guard-2026-08-05.md`,
`scripts/ses-photo-mail-volume-measure.ts`.

**Ordinary-mail subject = exact original WO subject (inbox grouping only):** Under
the exception, report/photo subjects are the **verbatim** original work-order
email subject — never reconstructed. Preferred store is `emails.subject` for a
PROVEN intake `post_id` (the resolved thread anchor, else the primary case's own
story sources, else that case's own source rows); fallbacks are
`makesafe_intake_drafts.subject` then `jobs.metadata.builder_email_subject`.
Each tier must resolve to exactly ONE distinct string — several distinct
candidates refuses, and recency is never a tiebreak, because a wrong WO subject
groups builder mail into the WRONG conversation while an ungrouped email is
merely plain. Provenance is likewise never invented: an unrecognised stored
source stamps `subject_source: null`, not `emails_subject`.
Plumbed on the manifest as `routing.intake_email_subject` /
`routing.intake_email_subject_source`, and stamped on the route as
`subject_source` / `original_work_order_subject`. Do
**not** add or strip a leading `Re:` — exact match is the point. Missing,
ambiguous or unreadable original never blocks prepare or send: keep the
generated pack subject and stamp `subject_source: generated_fallback`. The
subject reads are additive, chunked by URL budget, and degrade rather than
refuse a prepare — only the pre-existing empty-`case_sources` thread recovery
stays fatal. This is **not** real mail threading (messages
will not appear as replies on the WO conversationThread); mail clients only group
by subject. Invoice route is unchanged. Helpers:
`pickIntakeWorkOrderEmailSubject` / `mlbOrdinaryMailSubject` in
`ses_mlb_thread_reply.ts`. In-process tests prove wiring only — zero Graph calls;
a green suite does not prove any mailbox groups the result.

Closeout proof hashes are a **set**, not a route-kind-ordered array: apply
`20260805010000_ses_closeout_proof_hash_set_compare.sql` before the matching
`ops-api` so `commit_ses_release_closeout_v1` compares ledger and payload with
the same `ORDER BY proof_hash`. Ordering by `route_kind` on one side and hash
text on the other refused fully proved AJS releases (AJBR-70487 class). The
cockpit must never stay `SEND_READY` once route proofs exist —
`classifySesReleaseSendProgress` in `ses_review_cockpit.ts` yields
`RELEASED` / `CLOSEOUT_PENDING` / `PARTIALLY_RELEASED` and disables SEND IT.
Do not resend on a closeout-proof mismatch; re-run execute only after the set
compare is deployed (confirmed effects are exact-once, no Graph redispatch).

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

## The Portal Observer Writes Evidence Only, And Only When Asked

The observer's dry-run default, single-card opt-in write boundary, append-only
egress, producer-trust seam, and captain-gated backfill boundary are owned by
`docs/evidence/ses-f7-portal-capture-writer-2026-08-02.md`. Keep this pointer
current if the owner document moves; do not duplicate its detailed contract
here. The implementation is
`scripts/ses-f7-prime-portal-observer.ts` and its end-to-end proof is
`supabase/functions/ops-api/ses_portal_capture_writer_test.ts`.

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

The 2026-08-03 trade crew/detail payload, named-lead contract, visibility
narrowing, diagnosis, and deployment caveats are owned by
`docs/evidence/trade-crew-visibility-lead-2026-08-03.md`; consult it before
changing `trade_job_detail`, `set_job_lead`, or the lead/schema gate.

Trade multi-person allocation must preserve one assignment row per crew member:
when the representative row is reassigned to a person already on that job/date,
return the existing target row idempotently rather than collapsing the crew or
surfacing a raw uniqueness error. Diagnosis and the response contract live in
`docs/evidence/trade-allocation-collision-2026-08-03.md`.

## Every SES Measurement Names Its Denominator And Its Generation

Two small modules carry plan v2's write-safety rule D.0/3, and every SES harness
must consume them rather than hand-writing the equivalent:

- `scripts/ses-board-population-contract.ts` is the named, versioned board
  population. Never hand-write the `cancelled/lost` + makesafe/restoration/detail
  predicate again; call `sesBoardPopulationPredicate()`. The default
  `active-v1` is a DEFAULT, NOT A RULING — Captain decision C.5 (407 active vs
  440 including the 33 cancelled) is open, so `describeSesBoardPopulation()`
  renders a "not the whole board" caveat and nothing may claim board-completeness
  until C.5 lands. When it does, add a NEW version and switch the export; never
  edit a version in place, or past artifacts stop being attributable.
- `scripts/ses-measurement-generation.ts` emits `generation_id`, `snapshot_at`,
  both contract versions and a per-card `input_hash`, so a later apply can skip a
  card that moved underneath it. Two inversions are load-bearing: the
  `generation_id` is CONTENT-derived (a rerun over unchanged state reproduces it —
  that is how a second agent independently verifies a batch), and the per-card
  hash covers card INPUT facts only, never the ruler's verdict, so bumping
  `SES_EVIDENCE_CONTRACT_VERSION` does not read as board-wide drift. Free-text
  `detail` provenance is deliberately outside the hash.

`scripts/ses-stage-parity-harness.ts` runs the legacy ladder and M1 over one set
of read-only production reads, reads the corrected engine from the board row's
published advisory fields, and is the only tool that answers "did the
divergence move?". It imports the real legacy ladder (`_deriveMakesafeBoardStage`
via the read model) and `computeMakesafeStatus`, and must never reimplement
either. The current frozen baseline is documented in
`docs/evidence/ses-e1-stage-engine-v2-shadow-2026-08-02.md`; its committed
artifact and verification contract are
`scripts/ses-e1-stage-baseline-v1.json` and
`scripts/ses-stage-baseline-contract.ts`.

Pin a contract version literal in ONE place only — the owning module's own suite.
A second suite restating it is what turned the correct `c1-po-ruling-v2` →
`c1-unlinked-invoice-v3` bump into a red baseline; consumers import the constant.

## The Corrected Stage Engine Is A Shadow, And Stays One

`ses_stage_engine_v2.ts` is the one corrected evidence-derived stage engine that
will eventually replace BOTH the legacy ladder and `computeMakesafeStatus`. It
has no authority today. `canonical_stage` is still the legacy ladder plus the
existing overlay resolver, `projectOpsMakesafeBoard` still buckets on it alone,
and everything v2 returns is published as advisory `derived_stage_v2*` keys.
There is deliberately no flag that promotes it; the authority flip is Release 12
of `data/ses-f10-stage-engine-v2-design-v1/report.md` and has to be written, not
thrown. Do not add one, and do not let the advisory value into the trade
allow-list.

Two boundaries are structural, not documented: `SesStageV2Input` OMITS
`displayedStatus` (the read model builds the evidence input without it and
appends it only for M1's own call, ending the circular "display determines
computation" path), and `sesStageV2OverlayCandidate` only SIMULATES the overlay
resolver with the same three guards. Real overlay binding is untouched — nine of
the 46 rows would unbind under a corrected derivation and five reverse the
captain's own archive rulings, which is Release 9's job.

The evidence half of the ladder lives ONCE, in `makesafe_computed_status.ts`'s
`deriveMakesafeEvidenceStage`, and both engines call it. The terminal half
deliberately differs: v2 runs one common clock (`sesStageCompletedStage`) on
every terminal path, rejects a missing trusted completion time instead of
guessing, and refuses the raw complete/completed/closed shortcut unless an
issued invoice corroborates it. A raw terminal claim with no supporting evidence
is `decision_required`, and `sesStageCutoverGate` makes such a card STOP a
cutover rather than be dropped into a plausible column. Never resolve such a
card in code — resolve it by recording the ruling as EVIDENCE and letting the
engine derive from it.

The worked ruling and its producer analysis, parity evidence, and
manual-back-end-completion linkage observations are owned by
`docs/evidence/ses-261059-captain-signoff-2026-08-02.md`.

`scripts/ses-stage-parity-harness.ts` remains the only tool that answers "did
the divergence move?"; it reads v2's published value rather than recomputing it.
`scripts/ses-e1-freeze-stage-baseline.ts` + `ses-e1-stage-baseline-v1.json`
freeze the certified 407-card / 71-dispute manifest with a CONTENT-derived
generation id, so an independent rerun reproduces it. That freeze is an identity
manifest, not a pinned count: growth is reported, a vanished certified identity
or a changed adjudication fails. Never re-snapshot it to make a drifted run
green. Measured blast per release and the standing numbers:
`docs/evidence/ses-e1-stage-engine-v2-shadow-2026-08-02.md`.

## Readiness gate ruling

The 2026-08-03 captain ruling is: drop the unsatisfiable readiness precondition,
never assert readiness, and stop at recording approval. The authoritative
diagnosis, migration scope, execution boundary, and proofs live in
`data/ses-readiness-gate-drop-v1/report.md`; the regression/control test is
`supabase/functions/ops-api/ses_readiness_precondition_drop_test.ts`.

## Temporary-Fencing Pricing Has A Reader And No Producer

`ses_prepare_docket_revision.ts` prices `temporary_fencing` from `panel_count`,
`base_count` and (hire basis) `star_picket_count`, and the adapter resolves each
from `pricing.*`, `checklist.*` and six structured-source aliases. **Nothing in
`supabase/functions/` ever WRITES any of them.** Grep each name and every hit is
the reader or the blocker. `hours_per_trade` is NOT in that set: no key of that
name is written either, but the trade submit path writes its fourth alias
`checklist_json.labour_hours`, so the hours fact does have a producer — see "An
SES Labour Line Is A Floor, Not A Price You Can Set".

So `pricing_evidence_missing` on a temporary-fencing card is a permanent floor,
not a stale blocker to re-test: no rerun clears it, and it will block every
future temporary-fencing card. The separate AJS/AJBR existing-fence star-picket
carve-out is documented below and does not manufacture these temporary-fencing
inputs. Building the producer needs a trade-app capture change plus a captain
sign-off on the pricing inputs. Measured population and the other three
residual classes (`routing_evidence_missing`, `swms_generation_facts_missing`,
`swms_generation_template_unavailable`) are in
`data/ses-run-skill-batch5-packs-v1/report.md` §7.

Related: never make one of these classes pass by supplying a plausible quantity
or a carried-over crew — that puts invented content on a money document and on a
safety document respectively.

## AJS Existing-Fence Star Pickets Are A Narrow Physical-Shaped-Family Material

`makesafe_existing_fence_pickets.ts` is the shared server classifier for the
captain's existing-fence carve-out. On an AJS/AJBR card of a physical-shaped
family it may derive one money-only star-picket count from the current trade
report's explicit `materials_used` quantity when the work narrative proves the
pickets support an existing fence. `isSesPhysicalShapedFamily()`
(`ses_family_matrix.ts`) is the ONE predicate for that set — physical make-safe
plus the sealed repair and restoration recipes, deliberately not temporary
fencing — and it must never be narrower than the pricing side it feeds
(`invoice_basis === "ajs_labour_materials"`), or the builder is under-billed
with no line and no blocker. The assembler prices that line at $13.50 ex each.
Bare or ambiguous pickets hold, and any evidenced panel, block/base, tie/clip, hire,
retrieval-material or temporary-fence signal preserves the picket refusal.
Fixing/consumable lines remain separately refused without erasing an otherwise
valid picket line. Unquantified checklist template labels are not material-use
facts and must never become invoice lines. Current curated reports persist their
exact scope narratives beside the render hash so the invoice decision need not
promote raw checklist prose. The Bertram acceptance and refusal controls are
pinned in `ses_assembler_input_adapter_test.ts`,
`ses_prepare_docket_revision_test.ts`, and `makesafe_invoice_obligation_test.ts`.

## MLB Physical Materials Must Never Silently Drop Off The Invoice

`standard_labour_materials` (MLB physical / repair / restoration, and other
non-AJS builders on that basis) used to emit a complete-looking labour-only
proposal whenever `facts.materials` lacked priced unit lines — even when the
trade had recorded `materials_used` that the report still printed. That silent
omission cost real money (Munster, Morley, labour-floor-only draft batches).

There is **no** authoritative general materials unit-price list in this system
for physical make-safe consumables. Do not invent unit prices on a builder
invoice. The AJS existing-fence star-picket $13.50 rate is a different, sealed
carve-out and is not a materials catalogue.

Guard (Captain 2026-08-05): `ses_materials_charge_guard.ts` +
`localInvoiceProposal` in `ses_prepare_docket_revision.ts`. When trade
`materials_used` has real entries (not `None` / `Other / none` placeholders)
and the proposal would have zero materials charge lines, refuse with
`materials_charge_figure_required` naming the materials and asking for **one**
ex-GST figure. Never raise labour hours or the sealed rate to cover materials.

The card carries a standing materials-charge DECISION with three states, and
the operator moves between them on the OPERATOR surface, never by rewriting
trade evidence: the `materials_charge` body field of
`prepare_ses_docket_revision`, single-card selections only.

- **UNSET** — nobody answered. Materials recorded → the blocker above.
- **SET** — `{schema: secureworks.makesafe.materials-charge-figure/v1,
  amount_ex_gst, authorised_by, authorised_at, decision_key, reason}` → one
  charge line naming the materials.
- **NONE** — body `null`, or `amount_ex_gst: 0` with the same authority fields
  (which records who decided it) → labour only, decision recorded on the
  proposal. That is an explicit answer, not the silent omission this guard
  exists to prevent.

Typed priced `materials[]` lines remain a valid answer. Both decided states are
folded into the docket input hash, so two different decisions can never collide
on one revision id; UNSET wraps nothing and churns no existing hash.

The Captain answers ONCE, in both directions. SET and NONE are both stamped as
the `materials_charge` marker on the revision the prepare commits — on the
proposal when one is produced, on the refusing blocker's `facts` when one is
not (`materialsChargeDecisionMarker`) — so a decision taken while the card was
blocked for an unrelated pricing reason is just as durable. A prepare that
OMITS the body key inherits the NEWEST marker of either kind
(`resolvePriorMaterialsCharge` → `materialsChargeDecisionFromRevision` →
`carriedMaterialsChargeDecision`) and changes nothing; a withdrawal can
therefore never be overtaken by the figure it withdrew. Only an explicit body
value moves the decision. An inherited SET is rebuilt byte-identically, so the
inheriting revision reproduces the same input hash — and, for the same
`idempotency_key`, the same revision id and output hash, since
`revisionIdentityHash` folds that key in.

Inheritance is bounded by the materials the decision names and by the basis: a
re-attendance whose `materials_used` differs was never decided on, and a card
reclassified off `standard_labour_materials` inherits nothing, so neither can
bill nor block on a stale decision. That read is docket-side only — trade
attendance evidence is never read for the decision and never written. A
supplied figure is never discarded either: nothing recorded, materials already
priced, or a basis with no charge line each refuse with
`materials_charge_figure_unsupported`, and every such refusal names the
no-charge path so the instruction is always one the operator can follow. The
invoice line the builder reads is `<ref> - Materials used: <labels>` — trade
wording only, and label normalisation replaces underscores but keeps hyphens.

**Families changed:** `standard_labour_materials` only (non-AJS builder x
physical-shaped family). That is also the exact scope of the adapter's
`materials_used` surfacing onto `hours_and_materials` — it is inside the docket
input hash, so widening it to AJS, temporary fencing or report-only cards would
re-key those revisions and drop their Docs Ready signoff for no pricing effect.
**AJS/AJBR (`ajs_labour_materials`) still silently omit non-picket materials** —
same class of defect, out of this slice; only the picket carve-out bills
materials there. Temporary-fence hire bases are unchanged. Regression:
`ses_materials_charge_guard_test.ts` and the silent-labour-only case in
`ses_prepare_docket_revision_test.ts`.

## Docs Ready Is A Queue, Not A Board Column

Count Docs Ready from `ops-api?action=list_ses_docs_ready_reviews`, not by eye
off the board. A card whose job finished more than seven days ago derives
`canonical_stage: archive`, so a ready pack on an older card is invisible in the
board's live columns — in the 2026-08-03 batch-5 run, 30 of 35 ready cards sat
in `archive`. Also note board rows key on `id`, while the review queue keys on
`job_id`; joining them on the wrong field silently reports zero overlap.

Persisting a new docket revision on a card whose `pack.state` is already `sent`
re-opens it as `needs_review` and invalidates the previous signoff tick. Check
`pack.state` before treating such a card as reachable work.

## A Curated Bind Does Not Retroactively Trust An Existing Docket Revision

`bind_current_cycle_curated_makesafe_report` writes provenance onto the
`job_documents` row, never onto an already-persisted docket. The pack read
boundary validates the PERSISTED ARTIFACT's own stamp, so a revision assembled
before the bind keeps refusing `curated_source_missing` /
`independent_source_kind_missing` (`source_kind: null`) even after the bind
returns 200 — and its stored bytes may be a different render from the bound
ones. That refusal is correct; do not widen the read to consult the document's
current provenance. Clear it the sanctioned way: `prepare_ses_docket_revision`
(`dry_run` first to confirm `supporting_report_plan.metadata.mode ==
curated_report_artifact_recovery`, then `dry_run: false`). Proved live on
SWMS-261065, 2026-08-04: after the new revision the pack went from one blocker
and a suppressed `supporting_report_pdf` to zero blockers, and its signed URL
served the bound raw SHA-256 exactly.

## Previously Committed PDF Is Restorable, Not Complete

`inspectSesSupportingReportProof` (`ses_supporting_report_trust.ts`) is check 8
for the served supporting report: independent provenance / no self-vouching.
Same-cycle `previously_committed_pdf` (`evidence_source:
current_cycle_curated_makesafe_report`) requires a bind-time
`report_input_hash` — without it the refusal is
`independent_completeness_proof_missing`. Content-hash self-match and docket
lineage alone must never establish completeness; restorable bytes (Tuart Hill
`SWMS-261015` / raw `933d83bd…`) are not a complete pack. Sibling-bundle
evidence is a different independence model and is exempt at the trust function
only: a sibling bundle is evidence from another job, so check 8 fails on a pack
certifying its OWN completeness, never on cross-job evidence. That exemption has
no place in `physicalReportSourceForCycle` — a bundle-stamped artifact names a
sibling-job `report_document_id` and the snapshot loads `job_documents` per job,
so such a candidate dies at `!document` first. Sibling re-selection runs
`resolveBundledPhysicalReportProof` over the SIBLING's own snapshot instead.
Selection requires the hash unconditionally, and bounds the 8 MB budget itself
(`SES_SUPPORTING_REPORT_MAX_BYTES`, the one definition, imported by every
supporting-report byte check) because the completeness refusal is raised before
the size check. A `report_input_hash` is a coordinate for the DOCUMENT's bytes
whichever side stamped it, so when the document's own
`curated_source_expected_raw_sha256` / `report_render_hash` names different
bytes than the artifact, the candidate is refused regardless of hash source —
otherwise a re-bind's coordinate certifies stale, thinner bytes (Maylands
`SWMS-261017`, ~32 kB artifact against a ~2.38 MB document report). That rule is
`sesSupportingReportDocumentBinding`, the ONE implementation, and it binds both
sides: selection refuses `diverged`, and `verifyStoredSupportingReport` re-reads
the bound `job_documents` row so the served pack, the cockpit and Captain signoff
refuse the same shape (`source_document_bytes_diverged`) instead of handing out a
signed URL. An unreadable or absent bound document is likewise a refusal, not a
pass. Persist-side refusal alone is not enough — legacy rows already carry
unbound coordinates. The trust guard is only live where the read selects `id`;
keep `id` on every `makesafe_docket_artifacts` select that feeds
`inspectSesSupportingReportProof`. Do not relax this to bulk-pass incomplete
packs.

The same run pins the Docs Ready gate empirically. `docsReady()` returns on
`invoiceQualifiesAsCurrentDraft` before any other term, and preparing the
obligation does not supply it — `prepare_ses_invoice_obligation` yields a local
proposal with `xero_identity: null`. Minting the linked Xero DRAFT ACCREC is the
separate `create_ses_invoice_draft` step, the sanctioned SES-native mint owned by
`docs/project-knowledge/sync-layer.md`. So a card can hold a fully trusted pack,
zero docket blockers and still sit in `trade_report_in` until that mint runs;
that is the money fence working, not a defect. Prove such a claim by running
the real `docsReady()` against the live evidence shape and flipping only the
invoice term, rather than reading the ladder by eye.

When you build that evidence shape, do NOT read `report_pack` off the published
board — the key is absent from EVERY `makesafe_board` row (0 of 447 on
2026-08-04), so a parse returns "missing", not the server's value. It is an
internal seam: `makesafePipeline` synthesises `packForBoard` from the CURRENT
docket revision (grep the `packForBoard` initialiser in `index.ts`; the line
number drifts every release) and sets `review_state: 'READY'` whenever
`pre_xero_docs_ready` is true, with no `makesafe_report_packs` row required. A
card with ZERO rows in that table therefore still has `packState: READY`.
Treating the absent key as null makes `docsReady()` fall to its legacy `!pack`
branch and invents a second, non-existent blocker — which happened on
SWMS-261109 before it was caught.

Pack HONESTY is a strictly parallel channel, never a derivation input.
`presentSesPackHonesty` (`ses_pack_presentation.ts`) is the one producer, and
its kinds are **ready / refused / incomplete / sent / none** — never collapse
them; a refusal names its fact (an honest stop, not a green tick and not a
send-pipeline failure). Its output rides on `pack_presentation` (additive,
top-level) plus `report_pack.presentation_kind` / `presentation_reason` /
`legacy_pack_status`, and `get_ses_reviewable_pack` returns it under its own
`presentation` key. It must NEVER be written into `report_pack.status`,
`review_state` or `blockers`: those are what the stage ladder, the SENT chip and
M1 read, and a presentation string there moves columns. Likewise never mint a
`report_pack` object for a card with no pack row and no docket — M1's `!pack`
short-circuit is load-bearing, and kind `none` stamps nothing at all so
`pack_status` stays null on every packless New/Allocated card. Board
`pack_status` stays a STRING; changing its type needs a
`MAKESAFE_BOARD_CONTRACT_VERSION` bump. The current docket is always an input to
the presentation even when the legacy row is sent/authorised-not-sent; that gate
belongs to derivation only.

## Curated Bind Materials Are A Subset Of The Service Report, Never A Super-Set

`assertCurrentWikiSourceEvidence` (ops-api curated bind) accepts report
`materials_evidence.items` as a multiset **subset** of the current-cycle
service report's `materials_used`. Verbatim equality was wrong: the renderer
strips blank/default ticks, and forcing them onto the PDF is the Munster-class
false-materials defect. The reverse stays absolute — a report item absent from
the service report still refuses `curated_bind_materials_source_mismatch`.

Omissions are not silent: every service-report item missing from the report is
recorded on both `job_documents.data_snapshot_json.materials_source_accounting`
and the `ses_curated_report_source_bind_validated` audit event
(`excluded[].reason = omitted_from_report_materials_evidence`). Do not loosen
the renderer to print raw ticks, and do not bind verbatim defaults. Tests:
`makesafe_render_report_action_test.ts` (materials subset / super-set).

## Curated Report Content Supersession Is Gate-Full Re-Bind, Not A Patch

An already-bound current-cycle `makesafe_report` with a durable curated identity
may be re-bound when the **same document** is still cycle-bound, the new trusted
snapshot **differs**, and **all eight** curated evidence gates pass again
(materials, photos, contact, photo SHA-256, exact served-byte match, input hash,
authoritative renderer constants, independent curation identity). The prior
snapshot is archived on the audit event (`prior_data_snapshot_json`,
`supersedes_prior_bind`); PDF bytes are never rewritten by the bind itself —
overwrite storage first via `attach_makesafe_document` on the same
`file_name`/document id, then re-bind. Supersession audit ids are content-scoped
over the WHOLE trusted identity (bytes, curation identity, input hash), not the
bytes alone, so a re-curation of the same PDF is not refused forever as a
reservation conflict. Do not clear curated markers by hand or weaken a gate to
force a material correction. Tests:
`makesafe_render_report_action_test.ts` (`trusted content supersession…`).

That audit event is also the supersession LEDGER. A docket revision keeps its
own consistent copy of the bytes it was assembled from, so artifact
self-verification alone cannot see the correction and a signed-off pack would
keep serving the superseded (e.g. asbestos) report. `verifyStoredSupportingReport`
therefore reads the job's `ses_curated_report_source_bind_validated` events and
refuses any supporting report whose stamped source document + superseded stamp
matches, as `curated_source_superseded` — visible on the pack (suppressed
artifact + blocker), the cockpit HOLD, the Docs Ready signoff, and the send-time
signoff wall (`assertSesDocketsSignedOffForSend`). An unreadable ledger is
untrusted, never "no supersession". Scoping is exact: only the artifact's own
source document and only the superseded stamp, never the currently bound one,
so no other card, cycle or document is reached, and a re-bind that changed only
renderer constants marks nothing. The prior revision and its signoff are
retained as audit history and nothing auto-re-prepares — the operator's next
step is `prepare_ses_docket_revision` (`dry_run`, then `dry_run: false`) plus a
fresh signoff. Pure logic and both regression directions:
`ses_supporting_report_trust.ts`, `ses_reporting_actions_regression_test.ts`.

## An SES Labour Line Is A Floor; Commercial Quantity Is A Separate Seam

Default path: `prepare_ses_invoice_obligation` copies lines VERBATIM from
`docket.local_invoice_proposal.line_items`. Upstream,
`hoursPerTrade = Math.max(reportedHoursPerTrade, minimum)`
(`ses_prepare_docket_revision.ts`) raises short attendances to the sealed
builder floor and **never lowers a longer one**. AJS/AJBR floor is **2h** at
$80; MLB is **3h** at $85. Do **not** change those floors for a one-off card.

`hours_per_trade` resolves from four aliases nested inside the one
`job_service_reports.checklist_json` row (`ses_assembler_input_adapter.ts`).
**Never edit recorded trade hours to make a price come out** — that falsifies
attendance evidence. Charge-in (trade → us) and charge-out (us → builder) are
different commercial facts (`ses_prepare_docket_revision.ts`).

**Captain-authorised commercial quantity above the sealed schedule** (per card,
not a schedule change): optional body
`commercial_quantity_override` on `prepare_ses_invoice_obligation`
(`ses_commercial_quantity_override.ts`). Hosts on disposition
`priced_with_line_override` (existing DB CHECK — no migration). Default
`evidence.override_kind = commercial_quantity_not_rate`: labour unit price must
stay the sealed schedule rate; only quantity and separate materials lines may
change. Provenance (authorised_by / authorised_at / decision_key / trade
reported hours / sealed floor) stamps the proposal. api_key/routine or
Captain/admin JWT only.

**Card-scoped Captain labour rate override** (optional
`labour_rate_override` on the same body): when the Captain explicitly names a
different labour unit price for one card (e.g. after hours), supply
`sealed_unit_price_ex_gst`, `authorised_unit_price_ex_gst`, and `reason`. Lines
then stamp `override_kind = commercial_rate_override` with both rates. The
shared sealed schedule matrix is never changed; a sealed stamp that does not
match the U4 sealed rate refuses. Without `labour_rate_override`, a non-sealed
labour unit price still refuses (no quiet rate fakery to force a total).
MLB after-hours labour bills **$110/h** (Captain standing rule 2026-08-06),
applied through this per-card instrument — the sealed $85 schedule matrix stays
unchanged. Worked example: Mosman Park SWMS-261147 / INV-1152 DRAFT
`data/mosman-doc-integrity-f01-f02-v1/report.md` (supersedes the $100 remint in
`data/mosman-park-remint-v1/report.md`).

Billing **fewer** hours than the trade recorded is still unreachable without an
honest reduction instrument (quantity credit/discount). Do not invent one via
rate fakery.

Worked example: SWMS-261109 / AJBR-70271, trade reported 2 x 3 hours ($750 ex /
$825 inc) against an owner-chosen 2 x 2.5 hours ($670 / $737); six candidate
paths checked, all closed, obligation left unwritten and trade evidence
unaltered. Evidence lives OUTSIDE this repository, deliberately — task reports
never enter the shared project repo — at
**`<firstmate-home>/data/bertram-live-bind-v1/report.md`**. Do not look for it
under this repo's `data/`; its absence here is intended, not a missing artifact.

## Xero Optional-Field `.Contains` Needs A Null Guard

Xero refuses `Field.Contains(...)` on optional fields without a preceding null
guard (`QueryParseException: Operations on optional fields must be preceded by
a null guard`). Builders live in
`supabase/functions/ops-api/xero_where_clause.ts` — use
`xeroAccrecReferenceContainsWhere` / `xeroContactNameContainsWhere` (or
`xeroOptionalContains`) and never re-inline unguarded `Reference.Contains` /
`Name.Contains` in a `where:`. Equality comparisons (`Type=="ACCREC"`,
`Name=="..."`) do not need the guard; do not widen them. The mint path
(`readSesXeroInvoicesByToken` → SES `reconcileCreate`) is load-bearing. Ops-api
tests mock external services, so assert the generated where-clause string
(`xero_where_clause_test.ts`); a green pipeline alone does not prove Xero
accepts the query.

## Make-Safe Report Prose Is Short Paragraphs, Not Form Blurbs

Builder-facing make-safe report wording (scope / findings / works / materials)
must be short explanatory paragraphs of complete sentences, not bullet
fragments or `Damage:` / `Work:` form dumps. The pure contract and trade-
evidence composer is `makesafe_report_prose.ts` (`report-prose-paragraphs/v1`);
draft-pack prompts import the same style rules, and `draftPackReportPayload`
uses the composer when Claude leaves a field empty or still a raw checklist
dump. Honesty is load-bearing: never invent findings, materials, quantities,
measurements, or hazard classifications; when evidence is thin, write less.
No em dashes. Existing bound curated reports do not change until re-bound
(attach same `file_name` → curated supersession → prepare). Do not re-prepare
packs whose money/signoff is held for Captain decision.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
