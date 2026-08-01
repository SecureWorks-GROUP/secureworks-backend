# SES Phase C3 tranche 2 — adjudicating and re-attaching the 30 reference/subject-matched work orders

**Date:** 2026-08-01 · **Run label:** `ses-c3-wo-backfill-tranche2-v1`
**Project:** `kevgrhcjxspbxgovpmfl` (production)
**Owning code:** `scripts/apply-ses-c3-wo-backfill-v2.ts`
**Closed card set:** `scripts/ses-c3-wo-backfill-v2.fixture.txt`
**Adjudication record:** `scripts/ses-c3-wo-backfill-v2.adjudication.json`
**Committed evidence:** `scripts/ses-c3-wo-backfill-v2.{c1-before,dry-run,apply-ledger,c1-after,verify}.json`

## What this tranche did

Tranche 1 (`docs/evidence/ses-c3-wo-backfill-tranche1-2026-08-01.md`) closed the 26
cards whose missing builder work order was reachable from the card's OWN intake
case and identity-verified server-side. It deliberately left the 30 cards the C2
sweep matched only on reference digits or source-email subject, because those are
not case-bound and MLB routinely issues several purchase orders against one claim.

This tranche adjudicated all 30 of those cards, one at a time, against the
candidate PDF's own extracted text — and then re-attached only the ones that
earned it.

**Result: 26 ATTACH, 4 SKIP. 26 of 26 applied, 0 skipped at apply time, 0
failures.** Board cards with no work-order PDF went **36 → 10**.
`builder_wo_doc` moved `false → true` on all 26 as measured by the shipped C1
ruler. **No board card changed stage — not the 26, and not any of the other 381.**

## Re-deriving the work list

The C2 report (`data/ses-c2-evidence-measure-v1/report.md`) is a scout deliverable
held in the firstmate workspace and is not in this repository, so the work list was
re-derived read-only from production rather than taken on trust:

| Step | Method | Result |
|---|---|---|
| Board cards with no typed `work_order` document | `scripts/ses-c2-measure-board-evidence.ts` over all 407 board cards | 36 (exactly the 62 − 26 tranche 1 left behind) |
| Of those, with a work-order-shaped PDF still in `makesafe-emails` | read-only candidate sweep on reference digits, attachment name and email subject | **30** — the tier-B/C set, matching the C2 count |
| With no artifact anywhere | — | 6 (`SWMS-26001`, `SWMS-26507`, `SWMS-26965`, `SWMS-261124`, `MS191469`, `SWMS-TEST-0611`) |

## The adjudication rule

Applied uniformly, recorded per card in the adjudication file, and asserted by
`scripts/test/apply-ses-c3-wo-backfill-v2_test.ts`:

1. A candidate must be a work-order-shaped PDF in `makesafe-emails`, status
   `uploaded`, not `pii_purged`, with its storage object still resolving.
2. Its extracted text must name the card's own builder reference **in the work
   order's own job / work-order-number field**, matched on **digit boundaries**.
   A four-digit reference is a substring of unrelated five- and six-digit job and
   purchase-order numbers, so a substring hit is not a reference agreement — this
   is what rejected the false positives below.
3. Candidates are grouped by `sha256`. Duplicate transport rows (the Graph group
   post and its mailbox twin) are one artifact; the earliest row is selected.
4. ATTACH needs **at least two independent agreements** drawn from {builder
   reference, street number + street word, locality, policyholder name token} and
   **no contradiction** on any of them.
5. When more than one content group survives, the card must additionally be
   discriminated by a **card-bound recorded fact**: a purchase-order token named
   in the card's OWN stored documents, or exactly one candidate whose work-order
   issue date falls inside the card's creation window. Scope-word similarity and
   selection-by-exhaustion are inferences and explicitly do **not** qualify.
6. Anything less is a SKIP. Nothing here discovers a card and nothing is guessed.

Agreement counts across the attach set: four agreements on 14 cards, three on 11,
two on one (`SWMS-26692`, whose stored address holds only the locality, so the
street-number agreement could not be asserted). Every ATTACH row records zero
contradictions.

### Substring false positives the rule caught

Two cards had a candidate that matched only because the card's four-digit
reference is a substring of an unrelated number, and both were rejected on
contradiction rather than counted:

- **SWMS-26692** (`BWCWA6771`) — an AJ Building `Works Order.pdf` for job
  **67713**. Different builder, claim, locality and policyholder.
- **BWCWA6773** — two transport rows of a Prime work order **PO-56773** against a
  different claim, address and locality.

A digits-anywhere matcher would have attached both. Requiring the reference in the
document's own job-number field, plus a second independent agreement, did not.

## The four SKIPs

A skip here is the correct outcome, not a shortfall.

| Card | Claim | Reason |
|---|---|---|
| `SWMS-26844` | MLB-25769 | Three genuinely different work orders (assessment-and-quote, roof report, fencing make-safe). All three agree with the card on every identity dimension, so those dimensions cannot discriminate; no purchase-order token in the card's own documents and no candidate in its date window. All three are already the `work_order` of a sibling card on the claim. |
| `SWMS-26864` | MLB-25897 | Four genuinely different work orders. Three are already sibling cards' work orders, which would leave one unclaimed — but selecting by exhaustion is an inference, not a card-bound fact. |
| `SWMS-26871` | MLB-26364 | Two genuinely different work orders, both already held by sibling cards, neither selectable. |
| `BWCWA6773` | BWCWA6773 | Two genuinely different work orders remain after the PO-56773 rejections (PO20858 and a later PO20919 make-safe-and-report), **and** the card's stored street disagrees with the street both work orders name and with the card's own stored report. A card whose own address record is wrong cannot supply a second independent agreement. |

`BWCWA6773`'s address disagreement is a real card-data defect worth its own
follow-up; it is recorded here and deliberately not fixed by a work-order backfill.

### Multi-candidate cards that WERE written, and what selected them

Three cards had more than one content group and are written only because a
card-bound fact names one:

- **`SWMS-26663`** (`AJBR 67217-R`) — two AJ work orders for builder job 67217,
  dated 03 Jun and 17 Jun, with extracted text differing only in those dates. The
  03 Jun order is already the `work_order` of `SWMS-26428` (reference
  `AJBR 67217`); this card is the `-R` re-attend round, created 17 Jun, and only
  the 17 Jun order falls inside its window.
- **`SWMS-26898`** (MLB-26371) — the 24 Jun assessment order is already
  `SWMS-26779`'s; only the 02 Jul make-safe order falls inside this card's window,
  and its instruction category matches the card's `physical_makesafe` family.
- **`SWMS-26956`** (MLB-26369) — the card's OWN stored SWMS and invoice documents
  name `MLB-26369PO-54588`, which selects exactly one candidate; the competitor is
  a roof report already held by `SWMS-26795`.

### Own-copy provenance

Six of the 26 artifacts arrived on the SecureWorks own domain rather than from the
builder: `SWMS-26446`, `SWMS-26668`, `SWMS-26679`, `SWMS-26692`, `SWMS-26693` and
`WB68792`. For the two pre-archive-window cards the Captain named
(**`SWMS-26446`**, **`SWMS-26668`**) the inbound builder email does not exist at
all; the surviving transport row is our own copy, which is accepted provenance per
the Captain's earlier acceptance. Both met the two-agreement bar on their own
merits (four agreements each). The disposition is recorded per card in the
adjudication file as `transport: own_domain_copy`.

## How the write was made

Identical transport split to tranche 1, and each transport is the narrowest
available:

- **Reads** — Supabase Management API `POST /database/query` with
  `read_only: true`. A read physically cannot mutate.
- **The attach** — the sanctioned ops-api `attach_email_attachment_to_job` action
  (`job_id`, `email_attachment_id`, `type: work_order`, `file_name`). It copies
  the private bytes server-side into the public `job-documents` bucket, then
  delegates to `attachMakesafeDocument`, so the typed row, idempotency key
  (`job_id` + `type` + `file_name`), trade visibility and ledger rows match every
  other typed attach. The source `email_attachments` row and its `makesafe-emails`
  object are never moved, renamed or deleted. After the attach the returned
  document is read back and provenance authorized only when its version is exactly
  1, proving this invocation created the row.
- **The provenance stamp** — one guarded compare-and-set UPDATE per created row,
  recording the run label, the source bucket, the source attachment id and sha256,
  the adjudicated extracted-text md5 and the builder reference.

The file name is the artifact's own name, so the forward intake path
(`ensureIntakeWorkOrderEvidence`) hits the same idempotency key and cannot create a
duplicate later.

### The tranche-2 identity guard

Tranche 1 could re-prove identity from the card's own intake case. These artifacts
are not case-bound — that is what made them tier B/C — so the runtime guard is a
different pair, both recomputed from production on the bulk read AND on the fresh
single-card read taken immediately before each write:

1. the card's own builder reference digits are still present in the artifact's
   `pdf_extraction_text` **as a whole number token** — a digit-boundary regex,
   not a `position()` substring, so the guard can reject exactly the candidates
   the adjudication rejected; and
2. `md5(pdf_extraction_text)` still equals the value the adjudication was made
   against.

(2) is the load-bearing half. A human adjudicated the document's **content**, so
pinning the exact adjudicated text means a re-extraction, replacement or any drift
refuses the write (`adjudicated_pdf_text_drift`) instead of silently attaching a
document nobody read. The artifact `sha256` and `name` are pinned as well, and
`verify` re-asserts the text md5 is unchanged after the run.

## Safety properties

- **Skip, never force.** `evaluateEligibility` refuses on twelve distinct
  conditions and is evaluated — together with a field-by-field
  `stateMatchesBaseline` comparison against the dry-run baseline — on a fresh
  single-card read taken immediately before that card's write. The bulk read is
  only a pre-pass and never authorizes a write. Both functions are pure and
  unit-tested.
- **No discovery step.** The fixture is closed and hand-adjudicated; the test
  asserts it is exactly the adjudication file's attach set and that no skipped
  card leaks into it.
- **Crash-truthful ledger.** The ledger is flushed after every card, and a failure
  is recorded and flushed *before* the run aborts. `--resume` can re-stamp only
  the exact document id a prior ledger recorded, under eight named refusals.
- **No second status engine.** Nothing here touches `jobs`,
  `makesafe_job_details.substatus`, `makesafe_board_status_applications`,
  assignments, invoices or communications.

## Verification

`--mode verify --check-bytes` re-reads every card and asserts, per card: exactly
one `work_order` row, matching document id and file name, non-blank `storage_url`
resolving to a live `job-documents` object, `run_label` stamped,
`visible_to_trades` true, `builder_wo_doc` present in the C1 measurement, board
stage / computed stage / display overlay unchanged, `jobs.status`, `jobs.archived`
and `jobs.updated_at` unchanged, the status-application ledger count unchanged, and
the source artifact still in place with an unchanged sha256 and extracted text. It
also fetches each published copy and re-hashes it.

Because the measurement entrypoint here is the board-wide sweep, `verify`
additionally compares the stage triple of **every** board card before and after:

```
mode: verify   cards: 26   ok: 26   board_stage_drift: 0   failures: 0
```

The committed `verify.json` was **regenerated after the identity guard was
hardened** from a substring test to the digit-boundary token test, and came back
byte-identical to the pre-hardening result. That is the useful part: the stricter
read re-proves all 26 attachments against production, so the tranche satisfies the
stronger invariant and not merely the weaker one it was applied under. The
`dry-run`, `apply-ledger` and C1 `before`/`after` files are historical records of
the applied tranche and are deliberately NOT regenerated; a dry run today
correctly reports all 26 as `work_order_already_present`, writing nothing, with
the identity reference and the adjudicated text md5 still matching on 26/26. The
tranche is idempotent by refusal, not by overwrite.

Independent read-only cross-checks run outside the script:

| Check | Result |
|---|---|
| Board cards with no work-order PDF | 36 → **10** (exactly 26 closed) |
| `job_documents` rows carrying this run label | 26 rows, 26 jobs, all `work_order`, all `version = 1` (fresh inserts, no update path), all with a URL, all trade-visible, all carrying the source attachment id and the adjudicated text md5 |
| Any other `job_documents` created in the window | **0** |
| `job_events` in the window | 26, all `makesafe_document_attached` |
| `jobs` rows with `updated_at` in the window | **0** |
| `makesafe_board_status_applications` written in the window | **0** |
| Source `email_attachments` still `uploaded` and unpurged | 26/26 |
| Published copy sha256 vs intake-recorded source sha256 | matches on 26/26 |
| Board-wide C1 verdict changes | **0** |

## Per-card outcomes

All 26 applied. Stage before = stage after on every card. `builder_wo_doc` went
`missing → present` on every card.

| Stage (unchanged) | Cards |
|---|---|
| `archive` | 20 — AJBR 67005, AJBR 67170, BWCWA6781, SWMS-26440, SWMS-26441, SWMS-26442, SWMS-26443, SWMS-26444, SWMS-26445, SWMS-26446, SWMS-26447, SWMS-26448, SWMS-26449, SWMS-26450, SWMS-26668, SWMS-26674, SWMS-26679, SWMS-26692, SWMS-26693, WB68792 |
| `allocated` | 3 — SWMS-26738, SWMS-26858, SWMS-26956 |
| `completed` | 2 — SWMS-26655, SWMS-26663 |
| `new` | 1 — SWMS-26898 |

**No ruler verdict moved, on this set or anywhere on the board**, and that is the
expected result rather than a disappointment. `builder_wo_doc` is a `question` cell
carrying `terminal_evidence` at these stages, so filling it cannot by itself clear
a card. What remains required-and-missing on the 26 after the tranche:

- 12 cards — the ruler still refuses to measure them at all (`canonical family
  authority is unknown`); the work-order evidence is now stored regardless.
- 8 cards — `po` only.
- 6 cards — `invoice` and `po`.

Both remaining gaps are the separate Captain-PO and invoice work items, not
backfills of this shape.

## Reproduction

```sh
export SUPABASE_ACCESS_TOKEN=...          # Management API (reads + the stamp)
export SW_API_KEY=...                     # production ops-api (the attach)

D=scripts/apply-ses-c3-wo-backfill-v2.ts
deno run -A $D --mode measure  --output scripts/ses-c3-wo-backfill-v2.c1-before.json
deno run -A $D --mode dry-run  --output scripts/ses-c3-wo-backfill-v2.dry-run.json
deno run -A $D --mode apply    --baseline scripts/ses-c3-wo-backfill-v2.dry-run.json \
                               --ledger   scripts/ses-c3-wo-backfill-v2.apply-ledger.json
deno run -A $D --mode measure  --output scripts/ses-c3-wo-backfill-v2.c1-after.json
deno run -A $D --mode verify --check-bytes \
  --baseline scripts/ses-c3-wo-backfill-v2.dry-run.json \
  --ledger   scripts/ses-c3-wo-backfill-v2.apply-ledger.json \
  --before   scripts/ses-c3-wo-backfill-v2.c1-before.json \
  --after    scripts/ses-c3-wo-backfill-v2.c1-after.json \
  --output   scripts/ses-c3-wo-backfill-v2.verify.json --overwrite-output
```

`--mode measure` shells out to `scripts/ses-c2-measure-board-evidence.ts`, which
batches the shipped C1 ruler (`scripts/ses-measure-card-evidence.ts` over
`supabase/functions/ops-api/makesafe_evidence_requirements.ts`) across the whole
board through the Management API. That is the same ruler as the single-card
entrypoint, needs only `SUPABASE_ACCESS_TOKEN` rather than a service-role key, and
gives `verify` the whole-board stage comparison it asserts. Re-running the dry run
today correctly reports all 26 as already attached.

## Still open

- The 4 SKIPs above. `SWMS-26844`, `SWMS-26864` and `SWMS-26871` need a Captain
  ruling on whether a claim's unclaimed work order may be assigned by exhaustion;
  `BWCWA6773` needs its card address corrected first.
- The 6 cards with no artifact anywhere, including `SWMS-26965` (the one live-stage
  card with no recovery route) and `SWMS-26001` (no builder reference at all).
- `legacy-wo-evidence-acceptance` should be re-put to the Captain: with tranches 1
  and 2 applied, 52 of the 62 "permanently evidence-absent" board cards now hold
  their builder work order.
- The `po` and `invoice` cells remain the board's dominant required-and-missing
  evidence, and are separate work items.
