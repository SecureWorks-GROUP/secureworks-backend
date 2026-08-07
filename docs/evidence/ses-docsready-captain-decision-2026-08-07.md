# Captain decision — two cards, one word each — 2026-08-07

Two make-safe cards are complete and held out of Docs Ready. Each needs **one
word** from you. Nothing below requires you to read the diagnosis first; the
full working is in `ses-docsready-placement-gap-2026-08-07.md`.

| card | your word |
|---|---|
| Tuart Hill **SWMS-261015** | `VOID` or `LINK` |
| Floreat **SWMS-261021** | `VOID` or `LINK` |

- **`VOID`** — void the hand-typed Xero draft and let the docket path mint a
  proper linked invoice. **This is the only word that reaches Docs Ready.
  Recommended for both.**
- **`LINK`** — keep the hand-typed draft and have us build a guarded per-card
  action to bind it to the card. **`LINK` does NOT move either card. Both stay
  in `trade_report_in`.** It is a choice about which money is bound, not a way
  to place the card. **Read the three notes under option B first.**

The two words are not symmetric. Only `VOID` unsticks a card.

The Xero figures and card states below are read-only production reads, taken
and re-read unchanged on 2026-08-07. How they were obtained and how to re-verify
each one is in the provenance section of
`ses-docsready-placement-gap-2026-08-07.md`.

You can answer differently per card. Neither word is actioned tonight.

---

## Why they are stuck (one paragraph)

Both cards have a finished pack — docket `ready`, zero blockers, report and
photos in. Neither has an invoice the system can see. A Xero draft **does**
exist for each, typed straight into Xero on **5 August** and imported by
`xero-sync`; it carries no job link and no docket binding, so as far as the
board is concerned there is no invoice at all. The board therefore says
`missing_invoice`, which is misleading — see the separate defect item.

**The chronology is the point.** Those hand-typed drafts predate **your own
2026-08-06 materials rulings**, and both rulings are already recorded on the
dockets with your decision keys. The drafts and your rulings disagree about
money.

---

## Option A — `VOID` (recommended)

Void the hand-typed draft; the docket path mints a linked draft, attaches the
invoice artifact, and the card lands in Docs Ready by the normal recipe. No new
code, no seal exception, no backfill.

**What it produces is your 2026-08-06 ruling, exactly:**

| card | labour | second line | total inc |
|---|---|---|---|
| Tuart Hill | 1 trade x 3.5 h @ $85 = $297.50 ex | materials/disposal **$70 ex** — your key `tuart-hill-261015-disposal-70` | **$404.25** |
| Floreat | 1 trade x 3 h @ $85 = $255.00 ex | materials **$60 ex** — your key `captain-materials-proposal-2026-08-06-floreat-60` | **$346.50** |

## Option B — `LINK`

Keep the hand-typed draft and bind it to the card. **Three things you should see
before choosing this.**

**B0 — `LINK` does not place the card.** Both cards stay in `trade_report_in`
after it. Binding the money answers the link question and nothing else: the
Docs Ready recipe's invoice term
(`supabase/functions/ops-api/ses_stage_engine_v2.ts:604-608`) asks for a DRAFT
status **and** a durable invoice ARTIFACT — `documents.invoice` or
`pack.invoice_doc_id` — and neither card has one in any location. The artifact
is the binding constraint, not the link. This is proved in the companion
diagnosis (`ses-docsready-placement-gap-2026-08-07.md`, Term 2): running the
real `deriveSesStageV2` with the unlinked draft made visible, but still no
invoice document, derives `trade_report_in`.

To actually place the card an invoice artifact has to exist, which means the
docket mint and bind that attaches the invoice document
(`create_ses_invoice_draft` then `execute_ses_invoice_revision`) — exactly the
machinery `VOID` routes through. So `LINK` is a choice about which money is
bound and about accounting correctness, not a route into Docs Ready.

**B1 — it collides with your own seal.** Your 2026-08-01 ruling was to leave the
money mirror alone and fix this on the read side instead;
`linked` is one of the write-once sealed verbs
(`_shared/sealed_ses_money_fence.ts:130`), and all 440 SES cards carry an
explicit `ses_money_sealed_at`. Your earlier word to link **INV-1116** covers
the Floreat card and contradicts that seal. Choosing `LINK` means consciously
cutting a per-card exception through a seal you set six days earlier — that is
fine if it is what you want, but it should be a decision, not a repeat.

**B2 — it bills your pre-ruling figures.** The hand-typed drafts were written
the day *before* you ruled the materials charges, and the labour line is
identical on both sides. Only the second line differs:

| card | hand-typed draft (5 Aug) | your ruling (6 Aug) | effect of `LINK` |
|---|---|---|---|
| Tuart Hill | disposal / tip fee **$125 ex** → **$464.75 inc** | $70 ex → $404.25 inc | bills **$60.50 inc more** than you ruled |
| Floreat | materials **$45 ex** → **$330.00 inc** | $60 ex → $346.50 inc | bills **$16.50 inc less** than you ruled |

Choosing `LINK` bills those amounts and supersedes your 2026-08-06 decisions for
these two cards.

---

## Per-card evidence

### Tuart Hill — SWMS-261015 (`MLB-26658PO-56313`)

**In Xero:** INV-1115, DRAFT, ACCREC, dated 2026-08-05, $464.75 inc. Reference
`MLB-26658PO-56313` — an exact match for the card's own reference.

**Not in the system:** `xero_invoices.job_id` is NULL; no docket
`xero_binding`; the invoice obligation is still `open`; there are **zero**
`ses_external_effects`, so `create_ses_invoice_draft` never ran; and there is no
invoice artifact anywhere — no `job_documents` row of `type='invoice'`, no
`makesafe_report_packs.invoice_doc_id`.

**Ready otherwise:** docket `ready` / `pre_xero`, `pre_xero_docs_ready=true`,
zero blockers, 38 artifacts, report and SWMS documents present.

**`VOID` produces:** $404.25 inc, linked, artifact attached, card in Docs Ready.
**`LINK` produces:** $464.75 inc bound to the card, plus a seal exception. The
card does **not** move — still `trade_report_in`, still short an invoice
artifact.

### Floreat — SWMS-261021 (`MLB-27037`)

**In Xero:** INV-1116, DRAFT, ACCREC, dated 2026-08-05, $330.00 inc. Reference
`MLB-27037PO-56459`.

**Not in the system:** identical to Tuart Hill — `job_id` NULL, no docket
binding, obligation `open`, zero mint effects, no invoice artifact.

**Ready otherwise:** docket `ready` / `pre_xero`, `pre_xero_docs_ready=true`,
zero blockers, 39 artifacts, report present.

**One extra wrinkle, and it is why `LINK` here needs your explicit per-card
word:** three Floreat cards share the bare claim reference `MLB-27037`
(SWMS-261019, SWMS-261020, SWMS-261021). They are only told apart by the
purchase order each carries — `PO-56395`, `PO-56397` and `PO-56459`
respectively. INV-1116 names `PO-56459`, so it is SWMS-261021's, but no
automatic matcher will agree: the card-unique matcher reads only the bare claim
reference and correctly refuses all three as contested. A human has to name this
one.

**`VOID` produces:** $346.50 inc, linked, artifact attached, card in Docs Ready.
**`LINK` produces:** $330.00 inc bound to the card, plus a seal exception and a
hand-adjudicated match. The card does **not** move — still `trade_report_in`,
still short an invoice artifact.

---

## What happens after your word

- **`VOID`** — void in Xero, then run the normal docket mint. No code ships.
- **`LINK`** — we build the guarded per-card link action first (it does not
  exist today); it would be API-key-only, dry-run by default, exact-invoice
  guarded, and would need the seal exception recorded against your ruling. The
  card still would not be in Docs Ready afterwards.

---

**This card was corrected before it reached you.** An automated review caught
that the `LINK` option implied an outcome it does not deliver — it read as a
second way to unstick a card when it places neither. The defect was in this
decision artefact, not in any code: the thing you would have acted on was
itself misleading. It was fixed before you saw it.

Nothing in this file changes any card. No production write has been made.
