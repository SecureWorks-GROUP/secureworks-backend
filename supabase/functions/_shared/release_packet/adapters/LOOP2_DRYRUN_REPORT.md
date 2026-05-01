# V2 Loop 2 Dry-Run Report — 2026-05-01

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
| Fencing | 204 rows scope / 981 rows pricing | `job`, `savedAt`, `scopeMedia`, `tool`, `version` | `commissionCostEstimate`, `deposit`, `generated_at`, `gst`, `internal`, `job_description`, `labourCostEstimate`, `line_items`, `margin_pct`, `materialCostEstimate`, `neighbour_splits`, `runs`, `source`, `subtotal`, `totalCostEstimate`, `totalExGST`, `totalIncGST`, `version` |
| Quick Quote (`type='general'`) | n/a — created by ops-api, no scope_json | `client_notes`, `internal_notes`, `job_description`, `job_type_label`, `line_items`, `payment_terms`, `reference`, `source`, `totalExGST`, `gst`, `totalIncGST`, `valid_days`, `version` |

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

### 3.2 Fence adapter

| V2 field | Source today | Status |
|---|---|---|
| `scope.runs[]` | `jobs.pricing_json.runs[]` | **CAPTURED** |
| `scope.runs[].run_label / type / height_mm / lineal_m / panels / posts / infill / finish` | `…runs[].*` | **CAPTURED** |
| `scope.runs[].demo` | `…runs[].demo` | **CAPTURED** |
| `scope.runs[].gates[]` | `…runs[].gates` | **CAPTURED** when present |
| `scope.boundary_plan_attached` | derived from `jobs.scope_json.scopeMedia.drawings` | **PARTIAL** — depends on tool actually pinning to scopeMedia |
| `pricing_public.line_items[]` | `jobs.pricing_json.line_items` | **CAPTURED** |
| `pricing_public.line_items[].allocation` (client/shared/neighbour) | `jobs.pricing_json.line_items[].allocation` | **CAPTURED** |
| `pricing_public.line_items[].split_pct` | `jobs.pricing_json.line_items[].split_pct` | **CAPTURED** |
| `pricing_public.line_items[].per_contact[]` | derived from `pricing_json.neighbour_splits` + supplemental contacts | **CAPTURED** when neighbour_splits present |
| `pricing_public.per_contact_totals[]` | derived from above | **CAPTURED** |
| `internal_cost.line_costs[].supplier_name` | `pricing_json.line_items[].supplier_name` | **PARTIAL** (often blank) |
| `qa.council_status` | `jobs.scope_json.job.council_status` | **GAP** |
| `contacts[].authority.{can_view,can_accept,pays}` | derived from `job_contacts.contact_type + assigned_runs` | **GAP** — no structured authority today; need scoper-set field |
| `media[].sha256` | not computed | **GAP** |
| `documents.email.html_sha256` | not computed | **GAP** |
| `provenance.tool_name+version` | `jobs.scope_json.tool` + `version` | **PARTIAL** |

### 3.3 Quick Quote adapter

| V2 field | Source today | Status |
|---|---|---|
| `scope.label` | `jobs.pricing_json.job_type_label` | **CAPTURED** when caller supplies it |
| `scope.description` | `jobs.pricing_json.job_description` | **CAPTURED** |
| `pricing_public.line_items[]` | `jobs.pricing_json.line_items[]` | **CAPTURED** |
| `pricing_public.totals` | `jobs.pricing_json.totalExGST/gst/totalIncGST` | **CAPTURED** |
| `internal_cost.line_costs[].unit_cost` | `jobs.pricing_json.line_items[].cost_price` | **PARTIAL** |
| `internal_cost.line_costs[].supplier_name` | not captured by `createMiscJob` | **GAP** — Quick Quote rarely captures supplier; hard-blocker `pricing.material_lines_have_supplier` will fail unless overridden by Marnin/Shaun |
| `media[]` | not captured today | **GAP** — Quick Quote has no scoping-tool media flow |
| `provenance.tool_name + tool_version` | not captured (createMiscJob doesn't record tool) | **GAP** |
| `qa.customer_facing_summary` | reconstructed from `job_description + job_type_label` | **PARTIAL** — usable but unstructured |
| `qa.council_status` | n/a — defaults to `not_required` | **CAPTURED** (default) |
| `site.lat / lng` | not captured | **GAP** |

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
| `pricing.material_lines_have_supplier` | **PARTIAL FAIL** (often blank) | **PARTIAL FAIL** | **MOST FAIL** for Quick Quote | **Need supplier-name capture in scoping tools + ops-api** |
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

## 8. Status

- **Loop 1 / P0** — PR #18 open, mergeable, 54 tests (was 48, +6 bypass regression after Codex fix).
- **Loop 2 / P1** — this PR. 27 adapter integration tests + dry-run report. Builds on PR #18.
- **Total V2 test count:** 97/97 PASS (54 P0 + 27 P1 + 16 V1 shared regression-clean).

Stop gate for Loop 2: Marnin reviews this report + the three adapters + decides which §5 capture work happens before Loop 3 vs after.

Once approved, Loop 3 (P2) applies the migration and wires the V2 write path in soft-warn mode.
