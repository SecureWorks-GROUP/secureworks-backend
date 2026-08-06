# Why SWMS-261015 and SWMS-261021 are not in Docs Ready — 2026-08-07

Evidence key: `docsready-placement-gap-two-cards`

**This PR is PARKED and unmergeable BY CAUSE** — it touches only `docs/evidence/**`,
which matches no path filter in `.github/workflows/pr-check.yml`, so the required
check never registers (Mode A below). That is a deliberate decision, not a failed
or abandoned change: the diagnosis is committed and readable, which is the value.

Read-only diagnosis against production. **No production write was made.** The
conclusion is that the Release 12 recipe refuses both cards **correctly**, and
that the board publishes the **wrong reason** for the refusal.

## Summary

| | |
|---|---|
| Cards investigated | SWMS-261015 (Tuart Hill), SWMS-261021 (Floreat) |
| Board stage today | `trade_report_in` on both (`declared`, `derived_stage_v2` and `canonical` all agree) |
| Premise in the brief | "a complete pack with a **qualifying draft**" |
| Measured | the pack is complete; **there is no qualifying draft** |
| Placement defect in the engine | **none found** — the engine derives correctly from the evidence it has |
| Real defect found | the board reports `missing_invoice` for two cards whose invoice **does exist** in the Xero mirror under the card's own reference |

## The two cards, precisely

Both dockets are healthy: `state=ready`, `stage=pre_xero`,
`pre_xero_docs_ready=true`, **zero blockers**, 38 and 39 artifacts. So
`packState` reaches the engine as `READY` (`packForBoard.review_state` is set
from `docket.pre_xero_docs_ready`, `index.ts:16331`). The pack half of the
recipe is satisfied on both.

The money half is not, and it fails **twice**.

### Term 1 — the invoice is invisible to the board

Both cards have a Xero DRAFT ACCREC carrying the card's own builder reference:

| card | `makesafe_job_details.external_ref` | invoice | invoice reference | `job_id` |
|---|---|---|---|---|
| SWMS-261015 | `MLB-26658PO-56313` | INV-1115 DRAFT | `MLB-26658PO-56313` | **NULL** |
| SWMS-261021 | `MLB-27037` | INV-1116 DRAFT | `MLB-27037PO-56459` | **NULL** |

`xero_invoices.job_id` is NULL on both, so the invoice is never seen. Two closed
doors, either of which alone is sufficient:

1. `supabase/functions/ops-api/index.ts:16161-16169` — the board loads
   `xero_invoices` **chunked by `job_id`**, so an unlinked row is never fetched.
2. `supabase/functions/ops-api/makesafe_docs_ready_invoice.ts:207` —
   `currentMakesafeReceivableInvoicesByJobId` skips any row with no `job_id`
   (`if (!jobId) continue;`).

The refusal then propagates through the existing recipe unchanged:

3. `makesafe_docs_ready_invoice.ts:110` — `qualifyMakesafeCurrentDraftInvoice`
   with no invoice returns `{ qualifies:false, reason:"missing_invoice" }`.
4. `makesafe_computed_status.ts:381` — `docsReady()` returns `false`: neither
   `qualifiesDraft` nor `authorisedAwaitingSend` holds.
5. `ses_stage_engine_v2.ts:562` — `sesStageDocsReady`'s first gate is
   `if (!docsReady(...))`, so the card cannot be Docs Ready.

Neither draft was minted through the SES-native path. Both carry
`ses_external_token: null`, both have `updated_at` (the Xero
`UpdatedDateUTC`, 00:53 and 00:58) **earlier** than `created_at` (the mirror
insert at 01:04:01 on 2026-08-05) — the signature of an invoice typed directly
into Xero and later imported by `xero-sync`. Corroborated: both
`makesafe_invoice_obligations` rows are still `status=open`, both dockets carry
`xero_binding = null`, and there are **zero** `ses_external_effects` rows for
either job. `create_ses_invoice_draft` never ran.

### Term 2 — no invoice artifact exists, and this is what actually holds them

`ses_stage_engine_v2.ts:604-608`, the physical-make-safe branch of
`sesStageDocsReady`:

```ts
if (
  String(input.evidence?.invoiceStatus || "").toUpperCase() !== "DRAFT" ||
  !(input.evidence?.documents?.invoice === true || pack?.invoice_doc_id)
) {
  missing.push("the draft invoice");
}
```

The second half requires a durable invoice artifact. Neither card has one **in
any location**: no `job_documents` row of `type='invoice'`, no
`makesafe_report_packs.invoice_doc_id` (both pack rows are
`status=failed, failed_step=draft_pack`), and no docket `xero_binding`.

This term is not exotic and not a dead requirement: **31 `general_makesafe`
cards on this board carry a typed `invoice` document**, attached routinely as
part of the draft step. These two cards simply never had that step run.

### Proof that Term 1 alone does not place either card

The real Release 12 engine (`deriveSesStageV2`) run against SWMS-261015's live
facts, varying only the two terms:

| scenario | derived stage |
|---|---|
| today — invoice invisible, no invoice document | `trade_report_in` |
| unlinked DRAFT made visible, still no invoice document | **`trade_report_in`** |
| visible DRAFT **and** an invoice document | `report_ready` |

So closing the invoice-visibility gap is necessary but **not sufficient**. The
binding constraint is the artifact, and the artifact does not exist.

## Do the two cards fail for the same reason?

**At terms 1-5, yes — identically.** They diverge at the *remedy*, because the
existing card-unique matcher can only rescue one of them:

- **SWMS-261015** — reference digits `26658` and `56313` are each owned by
  exactly one job in the full `jobs` table, and INV-1115 names both. It is
  card-unique and would match under
  `deriveSesUnlinkedInvoiceMatches`' three guards.
- **SWMS-261021** — its `external_ref` is the bare claim `MLB-27037`, which
  **three** Floreat cards share (SWMS-261019, SWMS-261020, SWMS-261021). Guard 2
  (`builder_reference_shared_with_other_job`) excludes all three, symmetrically.
  The discriminator exists in the data but not where the matcher looks: each
  card carries a distinct `jobs.metadata.builder_po_number`
  (`PO-56395` / `PO-56397` / `PO-56459`) and a PO-suffixed
  `jobs.metadata.external_ref`. INV-1116's reference `MLB-27037PO-56459` names
  SWMS-261021's PO exactly. `makesafe_invoice_reference_match.ts` reads only
  `makesafe_job_details.external_ref`, while the sibling module
  `makesafe_docs_ready_invoice.ts:44-52` already treats
  `job.metadata.external_ref` and `job.metadata.builder_po_number` as card
  identity. The two modules disagree about what a card owns.

## Is it a class?

**The invisible-unlinked-DRAFT class is exactly these 2 cards.** Production
carries only **3** unlinked DRAFT ACCREC rows in total; the third (INV-0525,
reference `PRIVATE Ardross`) has no digit run of 5+ and belongs to no SES card.

The wider class — cards with a READY, unsent docket that are **not** in Docs
Ready — is **10**, and the other 8 are refused for substantively different and
correct reasons:

| reason | cards |
|---|---|
| unlinked DRAFT invisible (this finding) | 2 — SWMS-261015, SWMS-261021 |
| no invoice exists anywhere | 4 — SWMS-261029 Midland, and roof cards SWMS-261019 / SWMS-261079 / SWMS-261116 Floreat/Morley |
| invoice already raised (`wrong_status`) | 3 — SWMS-261028, SWMS-261034, SWMS-261131 |
| prior-cycle commercial | 1 — SWMS-261025 Koondoola (out of scope by instruction) |

Note the control: the two cards **in** Docs Ready today (SWMS-261114 White Gum
Valley, SWMS-261081 Mindarie) are both `roof_report`, which takes the other
branch of `sesStageDocsReady` and owes no invoice artifact. **No
`physical_makesafe` card is in Docs Ready right now.**

## What this means

The engine is not lying and is not disagreeing with itself. `declared_stage`,
`derived_stage_v2` and `canonical_stage` all read `trade_report_in` on both
cards, and that is the honest answer to the evidence on the card: the docket is
at `pre_xero`, no invoice is bound, no invoice artifact exists.

What is wrong is the **published reason**. The board tells an operator
`missing_invoice`. The truth is that an invoice for this card exists in Xero
under the card's own reference but is not bound to it. Those imply opposite
actions, and the wrong one is money-adjacent: acting on `missing_invoice` by
minting produces a **second** live draft against work that already has one.

Placing either card requires an invoice artifact that does not exist. Creating
it means running the SES-native mint/bind (`create_ses_invoice_draft` →
`execute_ses_invoice_revision`) — a production money write. Removing the artifact
term would weaken the completeness gate. Neither is available here, so the
refusal stands and is recorded as the finding.

## The two hand-typed drafts contradict the Captain's own later rulings

Worth knowing before anyone proposes binding them. The labour line is identical
on both sides (same hours, same sealed $85 rate); only the second line differs,
and the hand-typed drafts were written on **5 August**, the day *before* the
Captain ruled these materials figures on **6 August**. Both rulings are already
recorded on the dockets with his decision keys
(`tuart-hill-261015-disposal-70`, `captain-materials-proposal-2026-08-06-floreat-60`).

| card | hand-typed draft (5 Aug) | docket proposal / ruling (6 Aug) |
|---|---|---|
| SWMS-261015 | disposal-and-tip line $125 ex → **$464.75 inc** | materials $70 ex → **$404.25 inc** |
| SWMS-261021 | materials $45 ex → **$330.00 inc** | materials $60 ex → **$346.50 inc** |

So the two available paths produce different money, in opposite directions.
Voiding and re-minting produces the ruled figures; binding the existing drafts
supersedes those rulings.

## Provenance of the numbers in this document

**Every production figure here is a read-only production read.** The
no-mistakes pipeline cannot independently reach production — the
`SUPABASE_ACCESS_TOKEN` available to it returns `Unauthorized` against the
Management API — so inside CI these claims are **unverified by construction**.
That is a limit of the pipeline's reach, not a weakness in the claims.

What was actually done, and nothing more: the reads were taken read-only
against production on 2026-08-07 during the investigation, using credentials
from `~/.config/secureworks/env`, and every one of them was re-read and
reproduced unchanged at the end of that session. No third party and no
independent party verified them.

**The load-bearing logical claim is not a production claim.** That closing the
invoice-visibility gap alone leaves both cards in `trade_report_in`, and that
only the invoice artifact reaches `report_ready`, is engine behaviour. It was
independently reproduced in-pipeline by running the real `deriveSesStageV2`
against the card facts recorded above, and it stands on its own. Only the
**data snapshot** depends on production.

Re-verification, per production-dependent claim. Database claims are a
`read_only: true` SELECT through the Supabase Management API
`/database/query`; board claims are
`GET ops-api?action=makesafe_board&fields=full&include_diagnostics=1&include_archive=1`
with the `x-api-key` header.

| claim | how to re-verify |
|---|---|
| INV-1115 / INV-1116 status, reference, total, and `job_id` NULL | SELECT on `xero_invoices` where `invoice_number in ('INV-1115','INV-1116')` |
| unlinked ACCREC population: 158 PAID, 18 AUTHORISED (176 issued), 3 DRAFT | SELECT count grouped by `status` on `xero_invoices` where `type='ACCREC'` and `job_id is null` |
| docket, obligation, `ses_external_effects` and invoice-document state of both cards | SELECT on `makesafe_docket_revisions`, `makesafe_invoice_obligations`, `ses_external_effects` and `job_documents` (`type='invoice'`), each filtered to the two `job_id`s |
| 31 `general_makesafe` cards carrying a typed `invoice` document | SELECT distinct `job_id` count on `job_documents` where `type='invoice'`, joined to the SES board population |
| three-engine agreement on `trade_report_in` for both cards | board GET above; compare `declared_stage`, `derived_stage_v2` and `canonical_stage` on the two cards |
| the 10-card wider class, and the two-member `report_ready` column | board GET above; filter to READY unsent dockets, and read the `report_ready` column members |
| the `materials_charge` rulings recorded on both dockets | SELECT on `makesafe_docket_revisions` for the two `job_id`s, reading the `materials_charge` decision marker and its decision key |

These are live values and they move. A re-read may legitimately differ; the
correct response to a difference is to **re-derive**, never to edit a figure
recorded here.

## Two CI failure modes that look identical and have opposite remedies

From outside, both look the same: a PR stuck at `BLOCKED` with nothing to read.
The remedies are opposite, and applying the wrong one to the wrong branch costs
hours. Read this before diagnosing a stuck PR in this repo.

**THE DISTINGUISHING SIGNAL: registered-but-zero-steps means no runner arrived;
never-registered means no path match.** Check `statusCheckRollup` first — empty
means Mode A, present means Mode B — then check the starved job's step count.

### Mode A — NEVER REGISTERED

The diff matches no entry in the workflow's `paths:` filter, so no workflow run
is created at all and the required status never appears.

- **Symptoms:** PR `mergeStateStatus` `BLOCKED`; `statusCheckRollup` **EMPTY**
  (zero checks); no run object; nothing to cancel, because nothing exists.
- **It waits forever. Patience never helps.**
- **Remedy:** widen the path filter, or change the shape of the PR.
- **Instances:** THIS PR (three files, all `docs/evidence/*.md`); previously the
  watchdog-only PR; and PR #509, measured at 68 files under `data/` plus
  `AGENTS.md`, with `mergeStateStatus` `BLOCKED` and `statusCheckRollup` 0.
- **The trap that causes it:** `*` does not match `/`, so the filter's `*.md`
  entry covers only the tracked **root** markdown files and does **not** pull in
  `docs/**`.

### Mode B — REGISTERED BUT NO RUNNER ARRIVED

The diff matches, the run is created and the checks **do** register, but a job
never gets a runner.

- **Symptoms:** checks present and `QUEUED`; run object exists; the starved job
  reports **ZERO STEPS** — typically ending cancelled at about fifteen minutes —
  with no logs. The cancel endpoint may 502.
- **Remedy:** a fresh run when machines free. Transient, but it recurs whenever
  jobs contend.
- **Instance:** measured 2026-08-06 on another branch, PR 630, run 31121700604 —
  `deno-check` completed/success with 16 steps while `ses-proof-harness`
  completed/cancelled with 0 steps after 15m52s. The required check had already
  passed; only the second job starved.

## Follow-ons

- `ses-docsready-captain-decision-2026-08-07.md` — the staged one-word-per-card
  decision, with per-card evidence and the seal collision on the link option.
- `ses-missing-invoice-signal-defect-2026-08-07.md` — the wrong-signal defect
  this investigation exposed, written up as its own fixable item.
