# SES Phase C1 — the deterministic evidence ruler

**Date:** 2026-08-01 (Australia/Perth)
**Status:** the ruler is built and tested. The contract it encodes is still a
DRAFT: nine Captain questions were open at the time of writing, so the ruler
measures but does not yet adjudicate.
**Superseded in part, 2026-08-01:** the Captain ruled `po_floor` ("of course
every card needs a po"). The PO cell is now REQUIRED in all 49 rows, eight
questions remain open, and the contract version is
`ses-evidence-requirements/c1-po-ruling-v2`. This document is the C1 record as
built; the ruling and its measured board effect are in
`docs/evidence/ses-c3-po-ruling-and-suburb-backfill-2026-08-01.md`.
**Gate cleared before this ticket:** the Phase A/B certificate
(`docs/evidence/ses-ab-certificate-2026-08-01.md`, PR 464).

## 1. What C1 delivers

C1 is the ruler, not the measuring. Three artifacts:

| Artifact | Path | Role |
| --- | --- | --- |
| Requirement matrix + pure reader | `supabase/functions/ops-api/makesafe_evidence_requirements.ts` | 49 family x display-stage rows, the nine Captain questions, and `readSesCardEvidence` |
| Unit tests | `supabase/functions/ops-api/makesafe_evidence_requirements_test.ts` | every draft row asserted from an independent transcription |
| Read-only measure entrypoint | `scripts/ses-measure-card-evidence.ts` (+ `scripts/test/ses-measure-card-evidence_test.ts`) | inventories ONE production card and prints the verdict |

C1 wrote nothing to production. No backfill, no stage move, no status
application, no communication.

## 2. Input contract

The codified table is the draft evidence-requirements contract at
`/Users/marninstobbe/kun-agent-workspace/data/codex-evidence-ruler-draft-v1/report.md`
(backend `351f9e93`, wiki `83a48e28`). Sections 4.1-4.7 are the 49 rows;
section 6 is the nine Captain questions.

Families use the existing `SesFamilyId` vocabulary
(`ses_family_matrix.ts`) minus `unknown`, and the stage enum is imported from
`makesafe_computed_status.ts` rather than restated, so the ruler cannot drift
from the board's own stage vocabulary. `unknown` is a refusal outcome, not a
family: a card whose family authority is unknown is refused, never measured
against a guess.

## 3. The two rules the rest of Phase C depends on

1. **A QUESTION cell is never guessed.** Where the governing sources conflict or
   are silent, the cell stays `question`, the reader returns
   `unresolved_question` for that item, and the card's verdict degrades to
   `undetermined`. Promoting a cell requires a Captain ruling that answers the
   named question, not a code change.
2. **Only a real shortfall fails a card.** A `missing` on a `required` cell
   produces `fail`. A card short only on question cells is `undetermined`.

Verdict precedence: `fail` if any item is `missing`; else `undetermined` if any
item is `unresolved_question`; else `pass`.

## 4. The nine Captain questions

Named constants in the module, each carrying the question text and the draft's
evidence anchors. Three have since been ruled (struck through below) and carry a
`resolution`; the other six remain open. The code derives both views from
`SES_ALL_CAPTAIN_QUESTIONS`, so that module is the count of record:

| Id | Blocks |
| --- | --- |
| `po_floor` | ~~every PO cell of all five defined families, at every stage~~ — RULED 2026-08-01, all 49 PO cells are now REQUIRED |
| `ghl_equivalence` | whether a GHL object can satisfy a Prime obligation |
| `report_ready_authority` | the artifacts `report_ready` trusts without rechecking |
| `terminal_evidence` | what `completed`/`archive` must retain, and the legacy-orphan exception |
| `report_only_swms` | assessment at every stage; roof from `report_ready` onward |
| `own_document_roof_report_in` | the own-document roof `trade_report_in` proof |
| `repair_recipe` | ~~every repair cell~~ — RULED 2026-08-02, repair takes the physical-shaped table |
| `restoration_recipe` | ~~every restoration cell~~ — RULED 2026-08-02, restoration takes the physical-shaped table |
| `cancelled_floor` | every non-N-A `cancelled` cell |

`ghl_equivalence` is the one question that is not a cell verdict. It qualifies
how the `prime_link` item may be satisfied at all, so it lives on the item
(`SES_EVIDENCE_ITEM_STANDING_QUESTIONS`). A card whose only portal evidence is
GHL-shaped reads `unresolved_question`, never `missing` and never `present` —
at required AND optional cells, because an optional cell would otherwise record
"not required" for a card that does hold portal-shaped evidence.

## 5. Deliberate modelling decisions

- **Temporary fencing inherits the physical row exactly** (asserted). Its
  fence-specific completed-fence photographs and panel/hire facts sit OUTSIDE
  the seven evidence columns and are deliberately not folded into
  `photos_media`; the draft records them as blockers the ruler does not yet see.
- **The `trade_report` column is the SecureWorks roof PDF for
  `own_template_roof`.** Same slot, different artifact.
- **`photos_media` for assessment is the typed Prime photo-schedule capture**,
  not a local photo pack, per the binding assessment recipe.
- **The matrix is cumulative** across non-terminal stages: once an item is
  REQUIRED it stays REQUIRED at a later non-terminal stage unless that later
  cell is explicitly QUESTION. Asserted rather than computed, because the draft
  states it as a reading rule and the tables already encode it.
- **`report_ready` substates.** The Captain's `Docs Ready: needs review` /
  `Docs Ready: signed off` split is not in the seven-value Ops stage enum. The
  ruler follows the draft and treats both as `report_ready`; splitting them is
  part of answering `report_ready_authority`.

## 6. The measure entrypoint

```bash
SUPABASE_URL='https://kevgrhcjxspbxgovpmfl.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY="$(supabase projects api-keys --project-ref kevgrhcjxspbxgovpmfl -o json | jq -er '.[] | select(.name == "service_role") | .api_key')" \
deno run --allow-env --allow-net --allow-read \
  scripts/ses-measure-card-evidence.ts --job SWMS-261055
```

Options: `--stage <ops stage>` pins the stage instead of deriving it, `--json`
emits the machine model C2 batches over, `--strict` exits non-zero on `fail`.

Safety properties:

- the Supabase client is wired through the shared `readOnlyFetch` from
  `scripts/ses-evidence-stage-checker.ts`, which rejects every HTTP method
  except GET/HEAD before a request can leave the process;
- every read is scoped to the single resolved job id;
- `jobs` is read with an explicit column list, never `select('*')`, so
  `scope_json` never enters the process. `makesafe_job_details` IS read with
  `*` on purpose: it is one small blob-free row whose column set has drifted
  across migrations, so `*` is the drift-proof read there;
- every read checks `error` and throws. A wrong column name returns a 400 with
  `data: null`, which would otherwise read exactly like "this card has no
  evidence";
- the rendered output passes the same privacy guard the board checker uses. No
  client name, address, phone or email is selected or printed.

Stage selection is reported, never implied. With no `--stage` the measured
stage is the M1 computed status (`makesafe_computed_status.ts`) evaluated under
the card's applied display overlay from `makesafe_board_status_applications`;
`stage_source` on the result records which of the three paths was taken.

## 7. Missing versus lost in transit

The reader carries a `signal` alongside status. `lost_in_transit` means a
submission or upload record exists for evidence whose artifact does not. It is
a signal, not an excuse: a required item still reads `missing` and the card
still fails.

Cheap detections implemented here (full transit forensics is C2's job):

| Item | Lost-in-transit heuristic |
| --- | --- |
| `builder_wo_doc` | a typed `work_order` `job_documents` row exists but no qualifying row has a non-blank `storage_url` |
| `photos_media` | a `job_media` row with a blank `storage_url`, or a submitted current-cycle service report with zero completion photos |
| `trade_report` | a non-draft current-cycle service report that is not submitted/approved |
| `swms` | a qualifying typed/filename SWMS row exists but has no stored artifact, or the pack references a `swms_doc_id` with no qualifying document row |
| `invoice` | the pack references an `invoice_doc_id` with no qualifying ledger invoice |

## 8. Evidence sourcing

Derivations reuse production truth rather than restating it: doc booleans come
from ops-api's own `makesafeDocBooleans`, cycle scoping from
`makesafe_cycle_evidence.ts`, the completion-photo floor and the M1 stage from
`makesafe_computed_status.ts`, and PO recovery from
`makesafe_builder_work_order_identity.ts`.
Document evidence deliberately adds a non-blank `storage_url` requirement on
top of ops-api's `makesafeDocBooleans`; the production close-out gate remains
unchanged while this ruler measures lost-in-transit evidence.

One measurement decision the ruler itself does not make: `invoice` presence is
stage-aware in the entrypoint. At `new`..`report_ready` any live ACCREC invoice
counts (the draft's DRAFT-invoice reading); at `completed`/`archive`/`cancelled`
only an `AUTHORISED`/`SUBMITTED`/`PAID` invoice does, per the draft's
issued-ledger-invoice reading. Voided and deleted invoices are never evidence.

## 9. Verification

```text
deno check --config deno.jsonc \
  supabase/functions/ops-api/makesafe_evidence_requirements.ts \
  supabase/functions/ops-api/makesafe_evidence_requirements_test.ts \
  scripts/ses-measure-card-evidence.ts \
  scripts/test/ses-measure-card-evidence_test.ts
  -> clean

deno check --config deno.jsonc supabase/functions/ops-api/index.ts
  -> clean (unchanged baseline)

deno test --allow-env --allow-net=127.0.0.1 --allow-read \
  supabase/functions/ops-api/makesafe_evidence_requirements_test.ts
  -> 20 passed, 0 failed

deno test --allow-env --allow-net=127.0.0.1 --allow-read \
  scripts/test/ses-measure-card-evidence_test.ts
  -> 19 passed, 0 failed

deno test --no-check ... supabase/functions/ops-api/
  -> 2644 passed, 20 failed
  baseline without the new module: 2624 passed, 20 failed
  (the same 20 pre-existing failures; the new module adds 20 passes and no
   failure. The pre-existing TS2322 in myjobs_all_means_all_test.ts is also
   unchanged and unrelated.)
```

### Live read-only proof

The entrypoint was run against production on 2026-08-01 for two cards. Both runs
were GET/HEAD only and wrote nothing.

- `SWMS-261055` — `physical_makesafe`, M1 stage `completed`, no display overlay.
  Verdict `undetermined`: the invoice cell is `required` and `present` (PAID),
  and every terminal-retention cell is honestly unresolved pending
  `terminal_evidence`. Observed 23 current-cycle completion photos, 0 without a
  stored artifact.
- `SWMS-261118` — `physical_makesafe`, stage `archive` under an applied display
  overlay. Verdict `fail`: the required close-out invoice is missing. This is
  exactly the signal C2 batches for; the ruler does not treat an archived
  display stage as its own proof.

## 10. What C1 deliberately did NOT do

- It did not answer, soften or work around any of the nine Captain questions.
  (`po_floor` was subsequently answered by the Captain, not by C1.)
- It did not measure the live board. C2 owns batching this entrypoint.
- It did not promote the draft contract to a versioned source of truth. The
  contract version is `ses-evidence-requirements/c1-draft-v1` precisely so a
  promoted ruler gets a new version rather than silently replacing this one.
- It did not touch `makesafe_computed_status.ts`, the board read model, or any
  status engine. The ruler is a second, read-only opinion; it is not a second
  status engine and must not become one.
