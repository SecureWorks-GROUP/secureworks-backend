# SES C3 tranche 3 — the invoice-link backfill collides with the write-once money seal

**Date:** 2026-08-01 · **Mode:** strict read-only against live production ·
**Backend HEAD:** `73685b4` (`feat(ses): adjudicate and backfill C3 tranche 2 work orders (#469)`)

Tranche 3 was dispatched to "re-link the 52 double-verified issued invoices to
their cards" by setting `xero_invoices.job_id`, on the basis that the write is
"routine, reversible, no comms, no Xero mutation".

The cohort half of that is sound and is delivered here. The apply half cannot be
built as specified: **linking an ACCREC invoice to an SES card is exactly what
the write-once SES money seal refuses**, and every candidate target carries an
explicit seal. This document records the derivation, the collision, and the
options — it does not perform the write.

## 1. What was delivered

`scripts/derive-ses-c3-invoice-link-cohort-v1.ts` re-derives the cohort from live
production, read-only, through the Management API with the C2 measure script's
own `assertReadOnlySql` / `assertNoPiiColumns` guards. Result:
`scripts/ses-c3-invoice-links-t3-v1.cohort.json`.

| Measure | Value |
| --- | ---: |
| Jobs scanned (full table) | 2,383 |
| SES board cards | 440 |
| Unlinked issued ACCREC invoices | 175 |
| **Card-unique cohort** | **51** |
| **Cohort value** | **$27,782.70 inc** |
| Invoice status split | 47 PAID, 4 AUTHORISED |
| Excluded, with reason | 28 |

Both guards from `data/codex-po-invoice-verify-v1/report.md` are applied:

- **Guard A** — exactly one unlinked issued ACCREC candidate names the card's
  builder reference, matched on **whole digit runs of ≥5 digits**, never as a
  substring (the tranche-2 failure mode: `BWCWA6771` is a substring of unrelated
  five- and six-digit numbers).
- **Guard B** — the matched digits are owned by exactly one job across the
  **full** jobs table. Codex refuted "one invoice candidate" as sufficient
  because 13 cards share a builder claim with a sibling, so the candidate set
  alone does not prove which card should receive the foreign key.

A third guard is added here: an invoice claimed by two cards is dropped from
both rather than arbitrated (`invoice_claimed_by_multiple_cards`).

### 51 here vs 52 in the Codex report

The delta is a deliberate strictness difference, not a contradiction. Guard B is
applied **symmetrically**: where two cards contest a builder reference, both are
excluded. The exclusion list reproduces every ambiguous pair Codex named
(`SWMS-26428`/`26663`, `261024`/`261025`, `261059`/`26606`, and the ten
`SWMS-2610xx`/`SWMS-264xx` pairs) and adds two Codex did not list —
`AJBR 67005`/`SWMS-261102` and `SWMS-26416`/`SWMS-26937`. Also, references whose
digit run is shorter than five digits (the `BWCWA-6760` shape) contribute no
identity here at all.

Treat 51 as the reproducible floor. The exact figure must be re-derived at apply
time regardless — the discovery report's own caveat, and the reason this script
exists.

## 2. The collision

**Every one of the 51 target cards carries an explicit write-once money seal.**
Not inferred from job type — the column is set:

```
cohort_jobs=51  with_money_seal=51  with_seal_source=51
ses_money_seal_source = 'job_spine_backfill'  (51/51)
board-wide: board_cards=440  sealed=440
```

`classifySealedSesJob` therefore returns `sealed: true, matched_by: "job_seal"`
for all 51 — the first and strongest branch of
`supabase/functions/_shared/sealed_ses_money_fence.ts`.

The seal covers linking explicitly. Its own refusal text
(`sealed_ses_money_fence.ts:116`) reads:

> This SES make-safe job is sealed. Legacy {action} is refused because its
> invoice may only be created, authorised, changed, **linked**, or sent through
> the approved SES release flow.

And the seal's owning document, `docs/project-knowledge/sync-layer.md:29-34`:

> an ACCREC invoice that … **would link to a sealed make-safe job**, is refused
> by `ops-api`, `xero-sync`, `reporting-api`, and the legacy `send-quote`
> invoice route rather than being created, changed, sent, or auto-linked through
> those paths. The refusal is typed and **leaves the invoice unlinked**.

The only runtime writer of this column, `linkContactInvoicesToJob`
(`xero-sync/index.ts:138-181`), routes every candidate through
`sealedSesXeroLinkRefusal`, which re-reads the target seal from the database
(`inspectXeroLinkTarget`, `:78-91`) precisely so a caller cannot supply a job
shape to get around it. All 51 links would be refused.

**So brief step 3 — "APPLY via the sanctioned invoice-link path" — has no
referent.** For sealed SES cards there is no sanctioned link path; the sanctioned
behaviour is refusal. The two approved release families
(`sync-layer.md:80-89`) are the invoice **void** sequence
(`prepare`/`approve`/`execute_ses_invoice_void_revision`) and the three-route
**delivery** release (`…_ses_release_revision`). Neither links an existing
invoice to a card.

## 3. Two premises in the dispatch that the evidence does not support

- **"No Xero mutation" is true but not the operative question.** The seal is not
  a Xero-API fence; it fences the local money mirror. `job_id` on
  `xero_invoices` is the attribution key behind per-job revenue
  (`sync-layer.md:26`), the digest's financial sections, `reporting-api`, and the
  C1 ruler's invoice cell. Writing it is a money-model change even with Xero
  untouched.
- **"No comms" is true for this cohort, but by luck rather than by design.**
  `daily-digest:3115` gates the deposit chase SMS on `dep.job_id` being set, so
  linking is the switch that turns an unsendable chase into a sendable one. It
  is scoped by `reference ilike '%DEP%'`, and this cohort has
  **`deposit_shaped_references: 0`** — verified, not assumed. Any future tranche
  with a DEP-shaped reference would carry real comms risk.

The authority chain is also worth flagging. The captain's quoted ruling —
"backfill the evidence when it's needed… prime co links, things from the work
order" — authorised tranches 1 and 2, which wrote **`job_documents` evidence
rows**: additive, outside the money fence. A money-mirror foreign key inside an
explicitly write-once seal is a different class of object, and the original hold
said so: *"the SES money and outbound seal is write-once and owned by
`docs/project-knowledge/sync-layer.md`. Explicit authority is needed."* That
owner document says sealed SES work "must use the approved release actions
instead", and no approved release action links.

## 4. Options

- **A — Read-side fix (recommended; no money write at all.)** The goal is that
  the C1 ruler's invoice cell stops failing. That can be achieved without
  touching `xero_invoices` by teaching the ruler's invoice reader to also accept
  a *card-unique, unlinked, issued* ACCREC that names the card's own builder
  reference — exactly the 51 bindings derived here, exactly the guards above.
  It is a read-only evidence change, squarely inside what the captain's
  evidence-backfill ruling authorised, entirely outside the seal, and trivially
  reversible. The money mirror stays untouched and the FK question stays open on
  its merits.
- **B — Captain releases the seal for this backfill.** Requires a new audited
  ops-api action (bulk link under the release ledger), a migration, and a
  privileged key. Largest blast radius; genuine money-model change; needs the
  Captain, not firstmate.
- **C — Raw SQL write bypassing the fence.** Not recommended and not built. It
  contradicts the seal and the repo's own backfill pattern, which writes through
  a typed ops-api action rather than raw SQL
  (`scripts/apply-ses-c3-suburb-backfill-v1.ts`).

Independent of the choice: no `SW_API_KEY` or service-role key is present in
this lane, so no apply path could have been executed here in any case.

## 5. Reproducing

```bash
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
  --allow-write scripts/derive-ses-c3-invoice-link-cohort-v1.ts \
  --out=scripts/ses-c3-invoice-links-t3-v1.cohort.json
```

Read-only by construction: non-`SELECT`/`WITH` statements and client-identifying
columns are refused before transport. Two queries per run. The committed JSON
carries no client name, phone, email or street address — job number, builder
reference, invoice number/reference/amount/status only.
