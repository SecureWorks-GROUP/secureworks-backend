# The deterministic SWMS renderer was built, never bound — 2026-08-02

Owner document for the `swms_generation_capability_unavailable` blocker and its
repair. Read this before changing anything about how U4 obtains a SWMS.

## The finding, corrected

The defect was reported as "a capability that was never built". **That is wrong,
and the correction matters**, because it changes the fix from a design decision
into a one-line binding.

`renderSesSwmsPdf` (`supabase/functions/ops-api/ses_swms_render.ts`) is a
complete, sealed, deterministic four-page SWMS renderer. It was built in
**PR #432** (`fa20669`, 2026-07-28) together with the sealed control templates
(`ses_swms_template.ts`) and its own determinism tests
(`ses_swms_render_test.ts`, three tests, green on the parent commit).

What #432 did **not** do was bind it. It added the import to the runtime
dependency factory:

```
+import { renderSesSwmsPdf } from "./ses_swms_render.ts";
```

…but never added the matching `renderSwmsArtifact:` entry to the object
`createSesAssemblerRuntimeDependencies` returns. The import was therefore unused,
and **PR #433** (`9c247bb`) removed it as lint debris — erasing the last trace
that the wiring had been intended at all.

Two independent things then kept it invisible for five days:

1. `renderSwmsArtifact` is an **optional** dependency, so an absent binding is a
   runtime blocker, not a type error.
2. Every preparer test stubs it. The default `dependencies()` helper in
   `ses_prepare_docket_revision_test.ts` supplies a fake renderer, so the whole
   SES suite stayed green while production refused every SWMS-required card.

The result in production: `prepare_ses_docket_revision` reached
`deps.renderSwmsArtifact ? … : null` (`ses_prepare_docket_revision.ts:2308`),
found `undefined`, and emitted
`swms_generation_capability_unavailable` — "The deterministic SWMS renderer is
unavailable." That is a true statement about the runtime and a false statement
about the codebase.

## The design question, and why it does not arise

The brief asked whether the system intends (A) generating its own SWMS or
(B) accepting the staff-attached PDF as a source artifact. **The system already
answered A, in writing, and rejected B by name.** PR #432's own commit message:

> Rejected: Reuse staff-attached SWMS PDFs | stale attachments violate the
> current-cycle input contract

The vestigial `resolveSwmsArtifact` dependency is the superseded Option B path.
It is declared (`ses_prepare_docket_revision.ts:168`), implemented in the
factory, and **consumed by nothing**. The repo had already noticed and pinned
that as a documented defect
(`docs/evidence/ses-test-repair-tranche-a-mutation-proof-2026-08-02.md`, and the
`DEFECT DOCUMENTATION: stored-but-unrecoverable SWMS is indistinguishable from
absent SWMS` test). This change deliberately does **not** remove it — that is a
separate product tranche, and its pinned test depends on it — but it is now
commented as superseded so no one re-enables the rejected trust model.

So: wire it, do not redesign it.

## What changed

One binding, in `createSesAssemblerRuntimeDependencies`:

```ts
renderSwmsArtifact: renderSesSwmsPdf,
```

Bound **directly** rather than wrapped, so the bytes the docket hashes and
persists are byte-for-byte the renderer's own output, with the renderer's own
`render_hash` and provenance. Nothing else in the SWMS path moved.

### What deliberately did NOT change

- **`swmsDecision`** (`ses_prepare_docket_revision.ts:446`) is untouched, so the
  requirement scope is identical before and after. Per the captain's ruling,
  SWMS is MLB make-safe and fencing only: `swms_policy` is `always` only for
  `builder_key === "MLB"`, `builder_waiver_unless_hrcw` for AJS, and
  `hrcw_only` for everyone else (`ses_family_matrix.ts:229-234`). A non-MLB
  physical make-safe still needs no SWMS and still sails through. **This change
  cannot start demanding a SWMS on a card that did not already require one** —
  it only supplies the renderer for cards where `swms.required` was already
  true.
- **`buildSesSwmsGenerationPlan`** is untouched. It remains the fact gate, and
  it runs *before* the renderer is ever reached.

## The safety line

A SWMS names the people who were actually there. That guarantee is not something
this change adds; it is something this change must not weaken, and does not.

`buildSesSwmsGenerationPlan` (`ses_swms_template.ts:776-797`) requires eight real
facts — builder reference, site address, task activity, works date, arrival time,
**crew**, site contact, trade-report submission time — each resolved through
`sourcedText`, which takes the first non-empty candidate and records **which
source it came from** in `provenance.job_fact_sources`. There is no default, no
placeholder and no carry-over from another card. If any fact is absent the
function returns `swms_generation_facts_missing` and the preparer emits a
blocker; `deps.renderSwmsArtifact` is never called.

Crew specifically resolves from four candidates in precedence order:
`checklist_json.crew_name`, `checklist_json.crew`, `job_assignments.crew_name`,
then the user record joined to that **same assignment row**
(`job_assignments.users.name`, added by `cf23e28`). The fourth is a fourth place
to look, not an invention — it is the exact provenance the Ops board already
displays via `makesafeCrew`.

## Production measurement

Read-only, Supabase Management API `/database/query` with `read_only: true`,
SELECT only, no client-identifying column named in any statement.

**Deployed-version check first.** The measurement is only meaningful against a
production running `cf23e28` (the crew fix) or later. That is proven, not
assumed, by the persisted blocker transition on the same three cards:

| Card | 15:09 UTC blockers | 15:37-15:38 UTC blockers |
|---|---|---|
| SWMS-261017 | `swms_generation_facts_missing` | `swms_generation_capability_unavailable` |
| SWMS-261065 | `spine_missing_lineage`, `swms_generation_facts_missing` | `spine_missing_lineage`, `swms_generation_capability_unavailable` |
| SWMS-261020 | `spine_missing_lineage`, `swms_generation_facts_missing` | `spine_missing_lineage`, `swms_generation_capability_unavailable` |

`swms_generation_capability_unavailable` is only reachable when the fact gate
**passes**, so the facts blocker could not have cleared on the older deploy.

**Fact availability.** Denominator named explicitly: MLB cards
(`makesafe_job_details.requesting_company_slug = 'mlb'`) whose `jobs.status` is
not `cancelled/lost/completed/complete/closed/archived`.

- 195 MLB non-terminal cards.
- **32** of those carry a submitted `job_service_reports` row. Only these reach
  the render branch at all; the other 163 block earlier on
  `swms_generation_trade_report_missing`, correctly.
- Of those 32: builder reference 32/32, suburb 32/32, task activity 32/32,
  arrival 32/32, submission time 32/32, works date 27/32, **crew 30/32**.
- Across all 195, crew resolves on 142 — 51 from `job_assignments.crew_name`,
  142 including the assigned-user join — and **53 have no assignment row at
  all**, so their crew is genuinely unrecorded and must keep blocking.

So the binding converts roughly 27-30 of the 32 report-bearing MLB cards from a
capability refusal into a generated SWMS, while the remainder keep blocking on a
named absent fact. Two caveats, stated rather than buried:

- The works-date count is an upper bound; `isValidDateValue` is stricter than
  the SQL non-empty test.
- **Site address and site contact were not measured.** Both are
  client-identifying and the probe refuses to name those columns. Their presence
  is instead proven by the three cards above, which reached
  `swms_generation_capability_unavailable` in production — a state only
  reachable when all eight facts, those two included, resolved.

## Tests

Both new tests exercise the **real factory**, not a stub — that is the whole
point, since stubbing is what hid the defect.

`ses_assembler_input_adapter_test.ts`:

1. **`ops-api runtime dependencies supply the deterministic SWMS renderer`** —
   regression. An MLB physical make-safe card with complete facts and crew
   recorded *only* as the assigned user runs non-dry through
   `createSesAssemblerRuntimeDependencies`. Asserts the binding exists, no
   `swms_generation_capability_unavailable`, the docket binds a
   `generated:ARTIFACTS/SWMS…` artifact whose bytes and `content_hash` equal the
   renderer's own output, the PDF is four pages, and `plan.job.crew` is the
   recorded crew sourced from `job_assignments.users.name`.

   **Verified to fail on the old shape.** Reverting only the adapter binding and
   re-running gives
   `AssertionError: createSesAssemblerRuntimeDependencies must supply renderSwmsArtifact`.
   With that first assert temporarily disabled, the same test fails one step
   later with `renderer must be available, got: swms_generation_capability_unavailable`
   — the exact production blocker, reproduced in a test.

2. **`CONTROL: a card with genuinely no recorded crew still blocks, renderer or
   not`** — same card with no crew in any of the four sources. Asserts
   `swms_generation_facts_missing` with `crew` in `missing_facts`, no
   `swms_artifact` artifact bound, and the manifest item blocked.

   **The control passes on both the old and the new shape.** That is what a
   control is for: it proves the refusal survives the fix, and that wiring the
   renderer cannot manufacture a crew. Its guarantee comes from the fact gate
   running before the renderer, so the renderer's presence is irrelevant to it.

## Verification

```sh
deno check --config deno.jsonc supabase/functions/ops-api/index.ts   # clean
deno fmt --check / deno lint  on both changed files                  # clean
deno test --allow-env --allow-net=127.0.0.1 --allow-read \
  supabase/functions/ops-api/ses_assembler_input_adapter_test.ts     # 40 passed / 0 failed
deno test … supabase/functions/ops-api/                              # 2878 passed / 18 failed
```

The parent shape scores **2876 passed / 18 failed** on the same command, and the
two failure sets are **identical** (diffed by test name). The 18 are pre-existing
and none is in a file this change touches; the delta is exactly the two new
tests.
