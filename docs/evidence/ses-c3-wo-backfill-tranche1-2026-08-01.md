# SES Phase C3 tranche 1 — re-attaching the 26 identity-verified work orders

**Date:** 2026-08-01 · **Run label:** `ses-c3-wo-backfill-tranche1-v1`
**Project:** `kevgrhcjxspbxgovpmfl` (production)
**Owning code:** `scripts/apply-ses-c3-wo-backfill-v1.ts`
**Closed card set:** `scripts/ses-c3-wo-backfill-v1.fixture.txt`
**Committed evidence:** `scripts/ses-c3-wo-backfill-v1.{c1-before,dry-run,apply-ledger,c1-after,verify}.json`

## What this tranche did

The C2 whole-board sweep found 62 board cards with no stored builder work-order
PDF, and traced 56 of them to an artifact still sitting in the private
`makesafe-emails` bucket. Of those, **26 are recoverable class A**: the
attachment is reachable from the card's OWN `makesafe_intake_cases` →
`makesafe_intake_case_sources.attachment_refs` chain, and its extracted PDF text
contains the card's own `builder_wo_canonical` digits. This tranche re-attaches
exactly those 26.

The other 30 recoverable cards (C2 tiers B and C — matched on reference digits,
filename shape or source-email subject) are **deliberately out of scope**. They
are not case-bound, several have up to nine candidate artifacts, and MLB
routinely issues several POs against one claim, so each needs per-card
adjudication after the Captain rulings. Nothing in this tranche discovers a
card: the fixture is closed and hand-adjudicated, and the script has no
discovery step.

Result: **26 of 26 applied, 0 skipped, 0 failures.** Board cards with no
work-order PDF went 62 → 36. `builder_wo_doc` moved `false → true` on all 26 as
measured by the shipped C1 entrypoint. **No card changed board stage.**

## Re-verification before acting (task step 1)

The C2 tier-A claim was not taken on trust. Every leg was recomputed from
production read-only before the fixture was written, and again inside the dry
run and the apply re-check:

| Leg | Check | Result |
|---|---|---|
| Board membership | card still on the make-safe board population | 26/26 |
| Gap still real | zero `job_documents` rows of type `work_order` | 26/26 (20 cards had no documents at all; 6 held only our own report/invoice `general` rows) |
| Case binding | attachment id is in `attachment_refs` of a source of a case whose `job_id` is this card | 26/26 |
| Identity | `email_attachments.pdf_extraction_text` contains the case's `builder_wo_canonical` digits | 26/26 |
| Servability | `storage_path` resolves to a live object in `makesafe-emails`; `status='uploaded'`; `pii_purged_at` NULL | 26/26 |

### Multi-candidate adjudication

Six of the 26 cards had two case-bound attachments each. None of them is the
"several POs against one claim" case that the duplicate-card rule warns about,
and both sub-cases were settled on content, not on filename:

- **SWMS-261079, SWMS-261081, SWMS-261113, SWMS-261114, SWMS-261116** — the two
  rows are **sha256-identical** (same name, same size, two transport rows: the
  Graph group post and its mailbox twin). One content hash is one artifact, per
  the duplicate-transport dedupe invariant in `AGENTS.md`.
- **AJBR 66933** — two rows with different sha256 but identical byte size
  (337,178) and **identical extracted PDF text** (same md5, 3,079 chars) from two
  different source emails. Same document, re-delivered; the bytes differ only in
  PDF-level metadata.

The selection rule in the fixture is deterministic: group candidates by
`(size_bytes, md5(pdf_extraction_text))`, require exactly one content group per
card, and take the earliest-created attachment in it. A card that ever presents
two genuinely different work orders produces two content groups and is left out
of the fixture rather than guessed at.

## How the write was made

One transport per job, and each is the narrowest one available:

- **Reads** — Supabase Management API `POST /database/query` with
  `read_only: true`. A read physically cannot mutate.
- **The attach** — the sanctioned ops-api action
  `attach_email_attachment_to_job` (`job_id`, `email_attachment_id`,
  `type: work_order`, `file_name`). It downloads the private bytes with the
  service key, uploads a **copy** to the public `job-documents` bucket, then
  delegates to `attachMakesafeDocument`, so the typed row, idempotency key
  (`job_id` + `type` + `file_name`), trade visibility and `job_events` /
  `business_events` ledger rows are identical to every other typed attach.
  The source `email_attachments` row and its `makesafe-emails` object are never
  moved, renamed or deleted.
  After the attach, the returned document is read back and provenance is
  authorized only when its version is exactly 1, proving this invocation
  created the row. A higher version records
  `attach_updated_preexisting_document` and is not counted as applied.
- **The provenance stamp** — one guarded compare-and-set UPDATE per created row
  (`WHERE id = <document id> AND job_id = … AND type = 'work_order' AND
  run_label IS NULL`), setting `run_label` and merging a `metadata` object that
  names the C2 measurement, the source bucket, the source attachment id and
  sha256, the intake case id and the canonical WO. A zero-row result is retried
  and then recorded as an explicit resumable outcome rather than passing
  silently.

The file name is the artifact's own name, not a synthesised one, so the forward
intake path (`ensureIntakeWorkOrderEvidence`) hits the same idempotency key and
cannot create a duplicate later.

## Safety properties

- **Skip, never force.** `evaluateEligibility` refuses on any of eleven distinct
  conditions, and the apply evaluates it — plus a field-by-field
  `stateMatchesBaseline` comparison against the dry-run baseline — on a **fresh
  single-card read taken immediately before that card's write**, so drift that
  appears part-way through the tranche is still caught. The bulk read is only a
  pre-pass and never authorizes a write. Both functions are pure and
  unit-tested.
- **Case binding is to the card's OWN case.** The state read matches
  `c.id = <fixture case_id> AND c.job_id = <fixture job_id>`, not merely any
  intake case on the same job. An attachment reachable from a different case of
  the same job is refused.
- **Recovery is identified, never inferred.** If an attach succeeds but the
  provenance stamp does not, the ledger records a resumable outcome. A later
  `--resume <ledger.json>` may re-stamp **only** the exact document id that
  ledger recorded, and only when the live row still matches on id, job, type,
  file name, storage URL and an unset `run_label`; `authorizeResumeStamp` is
  pure and returns a distinct reason for each refusal
  (`resume_no_prior_ledger_entry`, `resume_document_row_missing`,
  `resume_document_id_mismatch`, `resume_document_wrong_job`,
  `resume_document_wrong_type`, `resume_document_already_stamped`,
  `resume_document_file_name_changed`, `resume_document_storage_url_changed`).
  The `--resume` recovery path never selects a row by shape, so a pre-existing
  or concurrently created same-name work order cannot be stamped with this
  tranche's provenance. The normal attach path uses the version-1
  creation-ownership check above.
  With no `--resume` ledger, a card that already has a work-order row is simply
  skipped.
- **Crash-truthful ledger.** The ledger is flushed after every card, and a
  failure is recorded and flushed *before* the run aborts.
- **No second status engine.** Nothing here touches `jobs`,
  `makesafe_job_details.substatus`, `makesafe_board_status_applications`,
  assignments, invoices or communications.

## Verification (task step 3)

`--mode verify` re-reads every card and asserts, per card: exactly one
`work_order` row, matching document id and file name, non-blank `storage_url`
resolving to a live `job-documents` object, `run_label` stamped,
`visible_to_trades` true, `builder_wo_doc` present in the C1 measurement, board
stage / computed stage / display overlay unchanged, `jobs.status`,
`jobs.archived` and `jobs.updated_at` unchanged, the status-application ledger
count unchanged, and the source artifact still in place. With `--check-bytes` it
also fetches each published copy and re-hashes it.

```
mode: verify   cards: 26   ok: 26   failures: 0   published_byte_check: true
```

The committed `verify.json` was **regenerated after the guards were hardened**
and came back byte-identical to the pre-hardening result. That is the useful
part: the stricter read — exact `case_id` binding rather than any case on the
same job — re-proves all 26 attachments against production, so the tranche
satisfies the stronger invariant and not merely the weaker one it was applied
under. The `dry-run`, `apply-ledger` and C1 `before`/`after` files are
historical records of the applied tranche and are deliberately NOT regenerated;
re-running a dry run today correctly reports all 26 as already attached.

Independent read-only cross-checks run outside the script:

| Check | Result |
|---|---|
| Board cards with no work-order PDF | 62 → **36** (exactly 26 closed) |
| `job_documents` rows carrying this run label | 26 rows, 26 jobs, all `work_order`, all `version = 1` (fresh inserts, no update path), all with a URL, all with the provenance note, all trade-visible |
| Any other `job_documents` created in the window | **0** |
| `job_events` in the window | 26, all `makesafe_document_attached` |
| `jobs` rows with `updated_at` in the window | **0** |
| `makesafe_board_status_applications` written in the window | **0** |
| Published copy vs private original object size | identical on 26/26 |
| Published copy sha256 vs intake-recorded source sha256 | matches on 26/26 |

`email_attachments.size_bytes` reads a few hundred bytes larger than the stored
object on every row. That is the Graph-reported attachment size including
transport encoding overhead, recorded at intake; it is **not** a copy defect —
the stored object sizes and the sha256 digests match exactly.

## Per-card outcomes

All 26 applied. Stage before = stage after on every card. `builder_wo_doc` went
`missing → present` on every card.

| Stage (unchanged) | Cards |
|---|---|
| `allocated` | 5 — SWMS-261079, SWMS-261081, SWMS-261113, SWMS-261114, SWMS-261116 |
| `archive` | 21 — AJBR 66933, AJBR 67172, AJBR 67178, AJBR 67205, AJBR 67260, SWMS-26430, SWMS-26671, SWMS-26672, SWMS-26673, SWMS-26678, SWMS-26680, SWMS-26681, SWMS-26682, SWMS-26683, SWMS-26684, SWMS-26686, SWMS-26687, SWMS-26688, SWMS-26689, SWMS-26690, SWMS-26691 |

Ruler verdict movement, for information only — no verdict was a target of this
tranche:

- `fail → undetermined` ×5 — the five live `allocated` cards. The missing work
  order was their only `fail`; what remains is open Captain questions.
- `fail → fail` ×12 and `undetermined → undetermined` ×9 — archived cards whose
  remaining gap is the invoice cell (the separate 104-card class) or open
  question cells. Out of scope here.

Five of the 13 live ruler failures the C2 report identified are now closed. The
other eight are SWMS-26965 (no artifact anywhere) and the seven tier-B cards
awaiting adjudication.

## Reproduction

```sh
export SUPABASE_ACCESS_TOKEN=...          # Management API (reads + the stamp)
export SW_API_KEY=...                     # production ops-api (the attach)
export SUPABASE_URL=https://kevgrhcjxspbxgovpmfl.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...      # read by the C1 measure entrypoint

D=scripts/apply-ses-c3-wo-backfill-v1.ts
deno run -A $D --mode measure  --output scripts/ses-c3-wo-backfill-v1.c1-before.json
deno run -A $D --mode dry-run  --output scripts/ses-c3-wo-backfill-v1.dry-run.json
deno run -A $D --mode apply    --baseline scripts/ses-c3-wo-backfill-v1.dry-run.json \
                               --ledger   scripts/ses-c3-wo-backfill-v1.apply-ledger.json
deno run -A $D --mode measure  --output scripts/ses-c3-wo-backfill-v1.c1-after.json
deno run -A $D --mode verify --check-bytes \
  --baseline scripts/ses-c3-wo-backfill-v1.dry-run.json \
  --ledger   scripts/ses-c3-wo-backfill-v1.apply-ledger.json \
  --before   scripts/ses-c3-wo-backfill-v1.c1-before.json \
  --after    scripts/ses-c3-wo-backfill-v1.c1-after.json \
  --output   scripts/ses-c3-wo-backfill-v1.verify.json --overwrite-output
```

To finish a tranche whose attach landed but whose provenance stamp did not, add
`--resume <the partial apply ledger>` to the `apply` invocation. Recovery is
never implicit: without that flag an already-attached card is skipped.


A re-run of `--mode apply` against the same baseline was executed after the
verification above and skipped all 26 with
`state_changed_since_dry_run:work_order_docs,work_order_docs_with_url`, writing
nothing. The drift check fires before the eligibility check, so the stronger
signal — the card is no longer in the state the plan was made against — is the
one reported. The tranche is idempotent by refusal, not by overwrite.

## Input provenance and open follow-ups

The C3 work-list is the C2 report,
`data/ses-c2-evidence-measure-v1/report.md` §3.3, produced by the read-only C2
sweep on 2026-08-01 against backend HEAD `cf26dcd`. That report is a scout
deliverable held in the firstmate workspace and is **not** in this repository;
its board sweep script (C2 Appendix A) is likewise uncommitted. Everything this
tranche relied on has been re-derived from production and is reproduced in the
committed evidence here, so this document does not depend on it.

Still open, and deliberately untouched:

- The 30 tier-B/C cards need per-card adjudication before any attach.
- SWMS-26965 is the one live-stage card with no recovery route anywhere.
- `legacy-wo-evidence-acceptance` should be re-put to the Captain: 50 of the 55
  "permanently evidence-absent" legacy cards had a recoverable artifact, and 21
  of them are now closed by this tranche.
- The invoice gap (104 cards) and the Prime capture wiring gap are separate
  work items, not backfills of this shape.
