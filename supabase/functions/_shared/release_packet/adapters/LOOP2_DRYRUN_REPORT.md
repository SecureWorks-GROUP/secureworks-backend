# V2 Loop 2 Dry-Run Report — 2026-05-01 (rev 2 after Codex shape audit)

> **Rev 2 corrections** (2026-05-02 after Codex stop-time review flagged adapter
> misreads): the prior draft of this report misread the actual production
> fence shape and the Quick Quote dispatch discriminator. Both have been
> corrected against deeper schema audits run on 2026-05-01.
>
> Specifically:
> - **Quick Quote dispatch:** production rows carry `jobs.type='patio'` AND
>   `pricing_json.source='quick_quote'`, NOT `jobs.type='general'`. Dispatch
>   now uses `pricing.source` as the primary discriminator. There is no
>   `general` type in production for Quick Quote.
> - **Fence runs construction details** live in `scope_json.job.runs[]` with
>   keys `id, name, length, sheetHeight, panels, neighbourId, extension, slope`,
>   NOT `pricing_json.runs[]` with `lineal_m, height_mm, run_label, type, infill,
>   finish, demo, gates`.
> - **Fence per-run attributes** (type, infill, finish, demo, gates) live in
>   `scope_json.job` top-level (`profile, colour, supplier, removal, gates`).
> - **Fence per-run pricing items** live in `pricing.runs[].items[]` with the
>   V1 `run_line_items` shape (`unit_price_ex, line_total_ex, allocation,
>   split_pct, client_amount_ex, neighbour_amount_ex, sort_order`), NOT in a
>   top-level `pricing.line_items[]` with `run_label`/cross-references.
> - **Fence per-contact totals** are pre-computed in `pricing.runs[].totals`
>   (`client_share_ex, neighbour_share_ex, run_total_ex, run_total_inc`).
> - **Fence pricing.internal** is a flat object of scalars
>   (`commission: number, cost: number, labour: number, margin: number`),
>   NOT a nested object with sub-fields.

> Loop 2 (P1) of the Full Release Packet V2 plan
> (`~/.claude/plans/cap0-full-release-packet-v2.md`).
>
> **Local-only, soft-warn only. No production write path. No deploy.**
>
> This report is the Loop 2 stop gate: it documents what each scoping-tool
> path captures today, what's GAP, what's partial — so Loop 3 can apply the
> migration + enable the V2 write path without surprising scoper UX.

## 1. What landed in P1

| File | Purpose |
|---|---|
| `_shared/release_packet/adapters/_extract.ts` | Shared helpers (`asObject`, `asArray`, `asNumber`, etc.) used by all adapters |
| `_shared/release_packet/adapters/patio_adapter.ts` | Reads `jobs.scope_json.patios[0]` + `jobs.pricing_json` for patio releases |
| `_shared/release_packet/adapters/fence_adapter.ts` | Reads `jobs.pricing_json.runs[]` + `neighbour_splits` + `scope_json.scopeMedia` for fence releases |
| `_shared/release_packet/adapters/quick_quote_adapter.ts` | Reads `jobs.pricing_json.line_items` + `job_description` for Quick Quote releases |
| `_shared/release_packet/adapters/dispatch.ts` | Maps `jobs.type` → V2 `scope.kind`; runs the right adapter |
| `_shared/release_packet/adapters/adapters_test.ts` | 27 integration tests (5 dispatch + 6 patio + 6 fence + 4 quick_quote + 3 soft-warn validation + 3 presence reports) |

All three adapters implement the `BuildScopeBlock` contract from P0. Dispatch maps `jobs.type` values currently in production to V2 kinds:

```
patio    → patio
fencing  → fence
general / misc / quick_quote → quick_quote
decking → decking      (P4 — adapter not yet registered)
gate     → gate         (P4 — adapter not yet registered)
repair / make_safe / roof_repair → repair    (P4 — adapter not yet registered)
```

## 2. Production schema audit (sampled 2026-05-01)

Real production keys observed across `jobs.scope_json` and `jobs.pricing_json`:

| Path | Sample size | scope_json keys | pricing_json keys |
|---|---|---|---|
| Patio | 199 rows scope / 341 rows pricing | `_pricing_json`, `client`, `complexity`, `config`, `customer`, `job_costs`, `notes`, `patios`, `pricing`, `savedAt`, `siteDetails`, `tool`, `verification`, `version` | `client_notes`, `commissionCostEstimate`, `deposit`, `generated_at`, `gst`, `internal_notes`, `items`, `job_costs`, `job_description`, `job_type_label`, `labourCostEstimate`, `line_items`, `margin_pct`, `materialCostEstimate`, `patios`, `payment_terms`, `reference`, `shared_costs_total`, `source`, `totalCostEstimate`, `totalExGST`, `totalIncGST`, `valid_days`, `version` |
| Fencing | 204 rows scope / 981 rows pricing | `job` (with deep keys: `_addressComponents, _latlng, _materialOverrides, _placeId, _poApproved, _pricing_json, address, checklist, client, clientFirstName, clientLastName, colour, date, email, gates, gatesRequired, installation, materialVerification, neighbours, neighboursRequired, phone, pricePerMetre, profile, quote, ref, removal, runs, scoper, siteNotes, suburb, supplier, supplierNotes`), `savedAt`, `scopeMedia`, `tool`, `version` | `commissionCostEstimate`, `deposit`, `generated_at`, `gst`, `internal` (flat scalars: `commission, cost, labour, margin`), `job_description`, `labourCostEstimate`, `line_items`, `margin_pct`, `materialCostEstimate`, `neighbour_splits`, `runs` (with per-run keys: `default_split_pct, items, neighbour_address, neighbour_id, neighbour_name, run_label, run_name, totals`), `source`, `subtotal`, `totalCostEstimate`, `totalExGST`, `totalIncGST`, `version` |
| Quick Quote (`type='patio'` + `pricing.source='quick_quote'`) | n/a — created by ops-api, no scope_json | `client_notes`, `internal_notes`, `job_description`, `job_type_label`, `line_items`, `payment_terms`, `reference`, `source`, `totalExGST`, `gst`, `totalIncGST`, `valid_days`, `version` |

**Fence per-run construction keys** (in `scope_json.job.runs[]`):
`extension, id, length, name, neighbourId, panels, sheetHeight, slope`

**Fence per-run pricing items** (in `pricing.runs[].items[]`):
`allocation, allocation_note, client_amount_ex, description, line_total_ex, neighbour_amount_ex, quantity, sort_order, split_pct, unit, unit_price_ex`

**Fence per-run totals** (in `pricing.runs[].totals`):
`client_share_ex, client_share_inc, neighbour_share_ex, neighbour_share_inc, run_total_ex, run_total_inc`

## 3. Field presence per adapter — what's captured today vs GAP

### 3.1 Patio adapter

| V2 field | Source today | Status |
|---|---|---|
| `scope.structure_type` | `jobs.scope_json.patios[0].config.structure_type` | **CAPTURED** (most rows) |
| `scope.dimensions.width_m / depth_m / height_m` | `…patios[0].config.dimensions` | **CAPTURED** |
| `scope.roof_sheet_colour / post_type / footings / gutter / fascia` | `…patios[0].config.*` | **CAPTURED** |
| `scope.electrical_yes_no / demo_yes_no` | `…patios[0].config.*` | **CAPTURED** |
| `scope.package_lines[]` | `…patios[0].package_lines` | **CAPTURED** |
| `pricing_public.line_items[]` | `jobs.pricing_json.line_items` | **CAPTURED** |
| `pricing_public.totals` | `jobs.pricing_json.totalExGST/gst/totalIncGST` | **CAPTURED** |
| `internal_cost.line_costs[].unit_cost` | `jobs.pricing_json.line_items[].cost_price` | **PARTIAL** (often blank) |
| `internal_cost.line_costs[].supplier_name` | `jobs.pricing_json.line_items[].supplier_name` | **PARTIAL** (often blank — known V1 gap) |
| `internal_cost.cost_estimates` | `jobs.pricing_json.materialCostEstimate / labourCostEstimate / commissionCostEstimate` | **CAPTURED** |
| `internal_cost.margin.pct` | `jobs.pricing_json.margin_pct` | **CAPTURED** |
| `qa.council_status` | `jobs.scope_json.siteDetails.council_status` | **GAP** — patio-tool doesn't structurally capture this; defaults to `unknown` (validator hard-fail) |
| `qa.customer_facing_summary` | adapter reconstructs from `pricing.job_description` + structure/dimensions | **PARTIAL** — usable but not curated |
| `site.access.{chips,notes}` | `jobs.scope_json.siteDetails.*` ad-hoc | **GAP** — no structured chip set today |
| `site.constraints.{chips,notes}` | n/a | **GAP** |
| `site.handover_instructions` | `jobs.notes` (free-form) | **PARTIAL** |
| `media[]` | `job_media` rows joined upstream | **CAPTURED** but **`sha256` column does not exist on job_media** |
| `media[].sha256` | not computed | **GAP** — hard-blocker `media.sha256_format` will fail |
| `documents.quote_pdf.sha256` | not computed | **GAP** — must compute at upload time |
| `documents.email.html_sha256` | not computed | **GAP** — must hash rendered HTML at send time |
| `provenance.tool_name + tool_version` | `jobs.scope_json.tool` + `version` | **PARTIAL** — combined not split |
| `provenance.pricing_engine_version` | `jobs.pricing_json.version` | **CAPTURED** but conflated with tool version |
| `provenance.scoper_user_id / scoper_name` | `jobs.created_by` | **PARTIAL** — sometimes null |

### 3.2 Fence adapter (rev 2 — corrected source paths)

| V2 field | Source today | Status |
|---|---|---|
| `scope.runs[].run_label` | `scope_json.job.runs[].name` | **CAPTURED** |
| `scope.runs[].lineal_m` | `scope_json.job.runs[].length` | **CAPTURED** |
| `scope.runs[].height_mm` | `scope_json.job.runs[].sheetHeight` | **CAPTURED** |
| `scope.runs[].panels` | `scope_json.job.runs[].panels` | **CAPTURED** |
| `scope.runs[].posts` | not captured per run today | **GAP** |
| `scope.runs[].type` | `scope_json.job.profile` (job-wide, applied per-run) | **CAPTURED** (job-wide) |
| `scope.runs[].infill` | `scope_json.job.colour` (job-wide) | **CAPTURED** (job-wide) |
| `scope.runs[].finish` | `scope_json.job.supplier` (job-wide) | **CAPTURED** (job-wide) |
| `scope.runs[].demo` | `scope_json.job.removal` (job-wide flag) | **CAPTURED** but **per-run granularity is a GAP** |
| `scope.runs[].gates[]` | `scope_json.job.gates` (job-wide); per-run gate assignment is a GAP | **PARTIAL** |
| `scope.boundary_plan_attached` | `scope_json.scopeMedia.drawings.length > 0` | **CAPTURED** when the tool pins drawings |
| `pricing_public.line_items[]` | `pricing_json.runs[].items[]` (canonical, V1 `run_line_items` shape) | **CAPTURED** |
| `pricing_public.line_items[].allocation` | `pricing_json.runs[].items[].allocation` | **CAPTURED** |
| `pricing_public.line_items[].split_pct` | `pricing_json.runs[].items[].split_pct` | **CAPTURED** |
| `pricing_public.line_items[].per_contact[]` | derived from `runs[].items[].client_amount_ex/neighbour_amount_ex` + `runs[].neighbour_id` | **CAPTURED** |
| `pricing_public.per_contact_totals[]` | derived from `pricing_json.runs[].totals.client_share_ex/neighbour_share_ex` (pre-computed!) | **CAPTURED** |
| `internal_cost.cost_estimates.material_total` | `pricing_json.internal.cost` scalar (with top-level fallback) | **CAPTURED** |
| `internal_cost.cost_estimates.labour_total` | `pricing_json.internal.labour` scalar | **CAPTURED** |
| `internal_cost.cost_estimates.subcontract_commission_total` | `pricing_json.internal.commission` scalar | **CAPTURED** |
| `internal_cost.margin.pct` | `pricing_json.internal.margin` scalar | **CAPTURED** |
| `internal_cost.line_costs[].supplier_name` | `runs[].items[].supplier_name` per-line OR `scope_json.job.supplier` job-wide fallback | **PARTIAL** (per-line often blank, job-wide present) |
| `qa.council_status` | `scope_json.job.council_status` | **GAP** — fence-designer doesn't structurally capture this; defaults to `unknown` |
| `contacts[].authority.{can_view,can_accept,pays}` | derived from `job_contacts.contact_type` + `assigned_runs` | **GAP** — no structured authority field today |
| `media[].sha256` | not computed | **GAP** — `job_media` has no `bytes_sha256` column |
| `documents.email.html_sha256` | not computed | **GAP** — must hash rendered HTML at send time |
| `provenance.tool_name + tool_version + pricing_engine_version` | `scope_json.tool` + `scope_json.version` (combined) | **PARTIAL** — not split into three fields |

### 3.3 Quick Quote adapter (rev 2 — discriminator corrected)

**Production reality:** Quick Quote rows carry `jobs.type='patio'` (legacy from `createMiscJob`'s default) AND `pricing.source='quick_quote'`. Dispatch uses `pricing.source` as the primary discriminator regardless of `jobs.type`. There is no `general` type for Quick Quote in production.

| V2 field | Source today | Status |
|---|---|---|
| `scope.label` | `pricing_json.job_type_label` | **CAPTURED** when caller supplies it |
| `scope.description` | `pricing_json.job_description` | **CAPTURED** |
| `pricing_public.line_items[]` | `pricing_json.line_items[]` (keys: `cost_price, description, quantity, total, unit, unit_price`) | **CAPTURED** |
| `pricing_public.line_items[].category` | not present in `createMiscJob` line input | **GAP** — adapter currently defaults to `'extra'`, which means `pricing.material_lines_have_supplier` validator does NOT fire for Quick Quote (no material lines). This is technically correct but means supplier-name capture is a non-issue for Quick Quote until line categorization is added |
| `pricing_public.totals` | `pricing_json.totalExGST/gst/totalIncGST` | **CAPTURED** |
| `internal_cost.line_costs[].unit_cost` | `pricing_json.line_items[].cost_price` | **PARTIAL** (caller-optional) |
| `internal_cost.line_costs[].supplier_name` | not captured by `createMiscJob` | **GAP** but *non-blocking* given the category default — see above |
| `internal_cost.cost_estimates.*` | not captured by Quick Quote | **PARTIAL** — adapter sums per-line costs and emits zeros for the rest |
| `internal_cost.commission.rule` | not captured | **CAPTURED** by adapter as `'other'` (Quick Quote default) |
| `media[]` | not captured today | **GAP** — Quick Quote has no scoping-tool media flow |
| `provenance.tool_name + tool_version` | `createMiscJob` doesn't record tool | **GAP** |
| `qa.customer_facing_summary` | reconstructed from `job_description + job_type_label` | **PARTIAL** |
| `qa.council_status` | not captured; adapter defaults to `'not_required'` | **CAPTURED** (default) |
| `site.lat / lng` | not captured by `createMiscJob` | **GAP** |

## 4. Hard-blocker impact assessment

When Loop 4 (P3) flips the validator from `mode='warn'` to `mode='enforce'`, every release with an unfilled hard-blocker gets refused. Here's what would refuse on today's data without scoping-tool capture changes:

| Hard-blocker | Patio | Fence | Quick Quote | Mitigation |
|---|---|---|---|---|
| `customer.email_set` | OK (jobs.client_email captured) | OK | OK | — |
| `customer.mobile_set` | mostly OK | mostly OK | mostly OK | Override (allowlisted) for the rare refusal |
| `qa.customer_facing_summary_min_length` | adapter reconstructs ≥40 chars | ≥40 chars | ≥40 chars when description present | OK in soft-warn; structured capture in patio-tool/fence-designer for clean hard-mode |
| `qa.council_status_known` | **MOST FAIL** (council_status not captured) | **MOST FAIL** | OK (default 'not_required') | **Need patio-tool + fence-designer capture for council enum** |
| `pricing.reconciles` | OK | OK | OK | — |
| `pricing.totals_consistency` | OK | OK | OK | — |
| `pricing.material_lines_have_supplier` | **PARTIAL FAIL** (often blank) | **PARTIAL FAIL** (per-line blank, but `scope_json.job.supplier` is a job-wide fallback the adapter consults) | OK — Quick Quote line items have no `category`, so they default to `'extra'` and the rule doesn't fire. Adding line categorization to `createMiscJob` later would surface this. | **Need per-line supplier_name capture in scoping tools** |
| `internal_cost.margin_override_required_when_breached` | OK when margin floor not breached | OK | OK | — |
| `qa.overrides_operator_allowed` | n/a (no overrides yet) | n/a | n/a | — |
| `send.recipients_present` | OK | OK | OK | — |
| `documents.quote_pdf_hashed` | **ALL FAIL** (sha256 not computed) | **ALL FAIL** | **ALL FAIL** | **Need sha256 computation at PDF upload time in send-quote / ops-api** |
| `media.sha256_format` | **ALL FAIL** when media present | **ALL FAIL** | n/a (Quick Quote has no media) | **Need `job_media.bytes_sha256` column + compute at upload** |
| `patio.structure_type_set` | OK | n/a | n/a | — |
| `patio.dimensions_positive` | OK | n/a | n/a | — |
| `fence.at_least_one_run` | n/a | OK | n/a | — |
| `fence.run_lineal_m_positive` | n/a | OK | n/a | — |
| `quick_quote.label_set` | n/a | n/a | OK | — |
| `quick_quote.description_set` | n/a | n/a | OK | — |

## 5. Capture work needed before Loop 4 (P3) enforces hard mode

Sequenced by what unblocks the most ground:

### 5.1 Per-asset sha256 — secureworks-site only (smallest, biggest unlock)
- Add `bytes_sha256 text` column to `job_media`. Compute at upload time in any code path that inserts media.
- Compute sha256 at quote PDF upload (in `prepare_quote` ghl-proxy action and any direct Storage upload).
- Hash the rendered email HTML in send-quote / ops-api before Resend dispatch.

This single slice unlocks `documents.quote_pdf_hashed` + `media.sha256_format` for all three adapters. **Can ship as one PR in `secureworks-site` without touching scoping tools.**

### 5.2 Council status capture — patio-tool + fence-designer
- Add structured council-status selector to patio-tool's `siteDetails` block (`not_required` / `required_pending` / `required_approved`).
- Add same to fence-designer's `scope_json.job` block.
- Default value `unknown` triggers the hard-blocker as designed.

This unlocks `qa.council_status_known` for the typical case. Marnin/Shaun overrides handle the council-unresponsive edge per §9.

### 5.3 Supplier name capture — patio-tool + fence-designer
- Each material line item should have a non-empty `supplier_name` when sent.
- Most tools already capture this in dropdown; verify it persists to `pricing_json.line_items[].supplier_name`.
- For Quick Quote, add a supplier-name field to `createMiscJob` line input (or accept that Quick Quote needs override per item).

### 5.4 Customer-facing summary — patio-tool + fence-designer
- Add a structured `customer_facing_summary` field (≥40 chars, single textarea) to both tools.
- Adapter currently reconstructs from `job_description` + structure/run details. The reconstruction is good but unstructured — explicit capture is cleaner for Cap 1 readiness.

### 5.5 Provenance fields — patio-tool + fence-designer + ops-api
- Distinguish `tool_name` from `pricing_engine_version`. Today `jobs.scope_json.version` and `jobs.pricing_json.version` exist but are conflated.
- Send `tool_name` + `tool_version` + `pricing_engine_version` as distinct fields when calling send-quote / ops-api.

### 5.6 Per-contact authority for fence — fence-designer
- Add a per-contact authority selector during scoping (who can_accept, who pays).
- Persist to `job_contacts.authority_can_view / can_accept / pays` (new columns) or as a single `authority_jsonb` field.

## 6. Recommended Loop 3 (P2) sequencing

Given the GAP audit, Loop 3 should:

1. **Apply migration `20260501130000_quote_revisions_v2.sql`** (the P0 draft) — adds the V2 jsonb columns + extended trigger.
2. **Ship § 5.1 (sha256 capture)** as part of Loop 3 — it's purely server-side and unblocks two hard-blockers immediately.
3. **Wire the V2 write path** in `recordReleasedQuoteRevision` (send-quote + ops-api inline copy):
   - Build full V2 envelope via `buildFullReleasePacket`.
   - Run validator in **`mode='warn'`** initially (logs warnings, doesn't refuse). Production sends keep flowing with V1-shape rows; V2 rows ship in parallel with the new columns populated.
   - INSERT both V1 columns (existing) AND V2 columns into the same `quote_revisions` row.
   - Upload `manifest_canonical_text` + `internal_cost_canonical_text` as separate hash-keyed objects.
4. **Ship the synthetic Q-V2-1 probe** to verify end-to-end shape.
5. **Stop gate.** Marnin reviews production rows from §5.2/§5.3/§5.4 capture state; once GAP fields are reliably captured by scoping tools, Loop 4 flips to `mode='enforce'`.

## 7. What this report does NOT cover

- **Real production probe.** This report is based on schema audit + adapter behaviour against realistic-shape fixtures. Loop 3 will dry-run against actual recent jobs once the write path is wired.
- **Cap 1 Job Readiness Engine integration.** That's T6's lane and consumes V2 outputs once Loop 3 ships.
- **T5 Job Dossier integration.** That's Loop 4 and consumes V2 via `get_release_packet_v2(...)`.
- **Customer-facing dossier.** Deferred per V2 plan §9.
- **Lifecycle checkpoints (Acceptance/Invoice/WO/Completion).** Loop 5 (P4).

## 8. Sentinel pattern + reserved synthetic contact ids (final PR #21 state)

Three Codex stop-time review rounds shaped the per-contact handling in fence releases. Each round caught a real bug:

| Round | Bug | Fix | Why it matters |
|---|---|---|---|
| 1 | Adapter wrote literal `'primary'` as `contact_id` for shared-line client share | Refused synthetic literals; fall back to real UUID lookup | Downstream (T5 Job Dossier, JARVIS, future T7 evidence spine) cannot dereference `'primary'` against `job_contacts` — silent broken reference |
| 2 | Refusing the synthetic literal caused the adapter to **silently drop the client share** when the primary couldn't be resolved | Preserve the share but mark it with a sentinel id | Customer's portion vanishing from `pricing_public.line_items[].per_contact[]` and `per_contact_totals[]` is undetectable downstream — `per_contact_totals.sum() ≠ subtotal_ex_gst` was the only structural tell |
| 3 (final) | Need a structural integrity rule that hard-blocks any release containing the sentinel | Non-overridable validator rule `pricing.per_contact_ids_resolved` + reserved-id whitelist | Sentinel preserves financial info; validator refuses to ship; the bug surfaces as a structured error at send time and CANNOT escape into a sealed `quote_revisions` row |

### The sentinel pattern (final architecture)

```ts
// manifest_v2_types.ts
export const UNRESOLVED_PRIMARY_CONTACT_ID = '__unresolved_primary_contact__'

export const RESERVED_SYNTHETIC_CONTACT_IDS: ReadonlySet<string> = new Set([
  UNRESOLVED_PRIMARY_CONTACT_ID,
  'primary',     // historical bug — see commit 4efe23c
  'neighbour',   // defensive
  'client',      // defensive
  'unknown',     // defensive
  '',            // empty string is not an id
])
```

**Adapter behaviour** (fence): when the primary contact cannot be resolved from `supplemental.contacts` AND the line carries a non-zero client share, the adapter writes the share with `UNRESOLVED_PRIMARY_CONTACT_ID` rather than (a) dropping it or (b) fabricating a literal. Same rule applies to `pricing_public.per_contact_totals[]`.

**Validator behaviour**: the envelope rule `pricing.per_contact_ids_resolved` walks every `per_contact[]` entry and every `per_contact_totals[]` entry and refuses the release if any `contact_id` matches a reserved synthetic value.

**Critically: this rule is NOT overridable.** Even an allowlisted operator (Marnin or Shaun) cannot grant permission to ship a release containing the sentinel. It is a structural integrity rule, not a business judgment call. Releases with unresolved primary contacts CANNOT ship — operators see a structured error pointing them at the missing contact data, fix it, retry.

### Why this pattern is required for downstream evidence/JARVIS correctness

The sealed `quote_revisions` row + canonical-text manifest + `manifest_hash` are the **raw evidence source** for everything downstream:

- **T5 Job Dossier** assembles operational truth by joining `quote_revisions` + `business_events` + per-contact data. Synthetic / dropped contact references break the dossier's integrity guarantees.
- **JARVIS** queries the dossier for natural-language responses (e.g. "what did neighbour B agree to pay on the Rear run?"). A sentinel that escaped or a missing share would produce confidently wrong answers — far worse than a refusal.
- **Future T7 evidence spine** (see § 10 below) will treat each released revision as a citeable raw evidence source. Anything written to `quote_revisions` becomes evidence forever. The cost of letting a dirty row escape is unbounded — no future cleanup pass can know whether `'primary'` was a real id or a bug.

The sentinel pattern guarantees a **single invariant**: any row that survives the validator and lands in `quote_revisions` has a fully-resolved per-contact financial picture. The downstream surface can trust the evidence.

## 9. Status (final PR #21)

- **Loop 1 / P0** — PR #18 open, mergeable, 54 tests (was 48, +6 bypass regression after Codex fix).
- **Loop 2 / P1** — PR #21 stacked on #18. Initial 27 adapter integration tests + dry-run report; **+13 regression tests across 3 Codex rounds** (shape misreads, synthetic ids, missing-primary liability preservation).
- **Total V2 test count: 110/110 PASS** (54 P0 + 40 P1 + 16 V1 shared regression-clean).
- **Final PR #21 commits:**
  - `2abeef8` initial Loop 2 / P1 adapters + dry-run report (had misreads)
  - `3e21b56` Codex shape-misread fix (fence runs construction; Quick Quote dispatch via `pricing.source`)
  - `4efe23c` Codex synthetic-id fix (no literal `'primary'`)
  - `8b3cbdd` Codex liability-preservation fix (sentinel + non-overridable validator rule)

Stop gate for Loop 2: Marnin reviews this report + the four adapter modules + decides which § 5 capture work happens before Loop 3 vs after.

Once approved, Loop 3 (P2) applies the migration and wires the V2 write path in soft-warn mode.

## 10. Loop 3 / P2 alignment requirement — T7 evidence spine consumability

V2 release packets must become a clean raw evidence source for the future T7 evidence spine. The Loop 3 write path must satisfy three properties so T7 can consume it without rework:

1. **Citeable via `evidence_refs`.** Each released `quote_revisions` row must be addressable by a stable identifier the future evidence spine can use. The `release_id` UUID + `manifest_hash` together form that identifier; the write path must persist both inline (already in the V2 envelope's `release_id` and the `manifest_hash` column) and ensure they cannot mutate post-release.
2. **Emit or be indexable as a quote-release evidence event.** Loop 3's V2 write path must either:
   - emit a canonical `business_events` row with `event_type='quote.release_packet.v2.sealed'` (or similar — exact name TBD with T7) carrying `{quote_revision_id, manifest_hash, internal_cost_hash, release_id, version}` in the payload, OR
   - leave a stable, append-only index on `quote_revisions` that T7's later read path can scan in chronological order without ambiguity.
3. **No V2 path that T7 cannot consume.** Loop 3 MUST NOT introduce shapes that are read-only via Cap 0–internal helpers. Anything sealed in `quote_revisions` (the V2 jsonb columns) and anything referenced by `manifest_url` / `internal_cost_url` must be reachable by a future T7 reader using service-role auth + the documented read primitive (`get_release_packet_v2`).

T7 itself is **out of scope** for Loop 3. We do not build the evidence spine, the spine reader, or the citation API in this loop. We only ensure the V2 write path is shaped so T7 can plug in later without a Cap 0 redesign.

This is a forward-compatibility constraint, not a build target. Failing to satisfy it during Loop 3 means re-engineering the V2 write path when T7 starts — exactly the kind of rework the V2 envelope was designed to prevent.

## 11. Merge readiness (PR #18 → main → PR #21 → main)

Sequencing constraint:

- **PR #18 (Loop 1 / P0) must merge to `main` first.** PR #21 currently targets `cap0-v2-p0-contract` (PR #18's branch) because it depends on the V2 types/validator/builder shipped there.
- **After PR #18 merges**, GitHub will automatically retarget PR #21 to `main`. The PR diff will then show only Loop 2 / P1 changes. If GitHub doesn't auto-retarget cleanly, manually `git rebase --onto main cap0-v2-p0-contract cap0-v2-p1-adapters` and force-push.
- **Re-run V2 test sweep + deno check after rebase** to confirm zero regression. Both should remain green.

No deploy. No migration applied. No production write path. PR #18 + #21 are pure local artefacts — types, validator, adapters, tests, dry-run report, draft migration in `_drafts/`.
