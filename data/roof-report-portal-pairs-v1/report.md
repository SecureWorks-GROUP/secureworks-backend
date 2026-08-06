# Roof-report portal pairs v1

**Date:** 2026-08-06  
**Branch:** `fm/roof-report-portal-pairs-v1`  
**Mode:** operations only (no product code, no migration, no send, no approve, no authorise, no void)  
**Privacy:** suburb + job / builder reference only. No client names, phones, emails, or street addresses in this report.

Captain asked for five roof-report family cards, each as a **pair**: Primeeco portal screenshot (filled/submitted) **and** our Xero **DRAFT** invoice.  
**Fewer honest pairs beat five padded ones.** This run delivers **three clean pairs**. The rest of the live roof-report portal population is named below as blockers (expired share links, form not submitted, or claim-only sibling already holding money).

No send. No approve. No authorise. No void. No photo cull. No trade-evidence edit. No money-fence or bind-gate weaken.

---

## CAPTAIN — WA delivery list (act on these three)

| # | Job number | Suburb | Builder ref | Invoice | Total inc GST | Portal screenshot | Invoice PDF |
|---:|---|---|---|---|---:|---|---|
| 1 | **SWMS-26980** | Gwelup | MLB-26567PO-56164 | **INV-1015** DRAFT | **$385.00** | `screenshots/SWMS-26980-portal.png` | `invoices/SWMS-26980-INV-1015.pdf` |
| 2 | **SWMS-261114** | White Gum Valley | RR-26836 | **INV-1144** DRAFT | **$385.00** | `screenshots/SWMS-261114-portal.png` | `invoices/SWMS-261114-INV-1144.pdf` |
| 3 | **SWMS-261081** | Mindarie | MLB-27100 (grain `MLB:PO-56960`) | **INV-1145** DRAFT | **$385.00** | `screenshots/SWMS-261081-portal.png` | `invoices/SWMS-261081-INV-1145.pdf` |

What you are approving on each pair: **the portal is locked/submitted** (screenshot) **and** the Xero **DRAFT** is the right double-storey roof-report charge (**$350 ex / $385 inc**). Authorise and SEND remain **your** next steps — this run does not do either.

---

## Bottom line

- **3 honest pairs** with live locked Primeeco pages and chargeable DRAFT PDFs.
- **3 further cards** have live locked portals but **must not be minted** (claim-only sibling already holds an invoice for the same builder reference).
- **Most other roof-report share links are expired** or still show an open Submit form — those are named blockers, not padded greens.

---

## What this run did

1. **Census:** Management API read-only list of `roof_report` family board cards with `primeeco.tech/share/` links (61+ rows; 74 share URLs after expand). Excluded owned/forbidden suburbs and job numbers from the brief.
2. **Portal observation:** `chrome-devtools-axi` open → classify locked/submitted vs expired vs open form. Screenshot only when locked/submitted.
3. **Mint path (SES-native only):**  
   `mark_makesafe_portal_report_done` (portal-truth stamp for current cycle) →  
   `prepare_ses_docket_revision` →  
   `prepare_ses_invoice_obligation` →  
   `create_ses_invoice_draft` (**full live ACCREC** scan before create).  
   Legacy `create_makesafe_draft_invoice` is retired (HTTP 410) and was not used.
4. **Invoice PDFs:** `get_invoice_pdf` (sealed-money **read** exemption; operator api_key). PDF bytes stored under `invoices/`; base64 stripped from proof JSON.
5. **SWMS-261081 only:** scoped `makesafe_state_seed_scoped` (cycle bind; spine already complete) + F7 `record_ses_portal_capture_evidence` so U4 could see portal capture for the current cycle. No stage/money authorise/send.

---

## Green pairs (detail)

### 1) SWMS-26980 — Gwelup — MLB-26567PO-56164 — INV-1015 $385.00

| Field | Value |
|---|---|
| Family | `roof_report` / ordinary roof portal |
| Storeys | double (invoice line: double-storey roof report) |
| Portal | Locked: “This form has been locked and is no longer available for editing or submission” |
| Portal screenshot | `data/roof-report-portal-pairs-v1/screenshots/SWMS-26980-portal.png` |
| Invoice | **INV-1015** DRAFT **$385.00** (pre-existing; not reminted) |
| Invoice PDF | `data/roof-report-portal-pairs-v1/invoices/SWMS-26980-INV-1015.pdf` |
| Sibling note | Separate Gwelup card holds a different PO (`…PO-56773` AUTHORISED). This card’s own PO-scoped DRAFT is clean. |
| Mint this run | **No** — DRAFT already existed; only PDF fetch |

### 2) SWMS-261114 — White Gum Valley — RR-26836 — INV-1144 $385.00

| Field | Value |
|---|---|
| Family | `roof_report` / ordinary roof portal |
| Storeys | double → **$350 ex / $385 inc** fixed roof schedule |
| Portal | Locked (live + prior capture ledger `done`) |
| Portal screenshot | `data/roof-report-portal-pairs-v1/screenshots/SWMS-261114-portal.png` |
| Portal stamp | `mark_makesafe_portal_report_done` → `portal_verified_cycle=2` |
| Docket | `prepare_ses_docket_revision` ready (`dry_run` then live) |
| Obligation | new revision `ddcd08aa-…` superseding stuck prior revision |
| Mint | `create_ses_invoice_draft` → **INV-1144** DRAFT $385 |
| ACCREC scan | **`scanned_accrec: 1169`**; `invoice_create_dispatched: true`; `send_dispatched: false` |
| Invoice PDF | `data/roof-report-portal-pairs-v1/invoices/SWMS-261114-INV-1144.pdf` |
| Prior stuck effect | Older `invoice_create` effect was `unknown` with portal-truth failure and **null** `external_id` (no Xero create). Fresh obligation revision got a new operation key; mint succeeded. |

### 3) SWMS-261081 — Mindarie — MLB-27100 — INV-1145 $385.00

| Field | Value |
|---|---|
| Family | `roof_report` / ordinary roof portal |
| Identity grain | `MLB:PO-56960` (intake); invoice reference `MLB-27100` |
| Storeys | double → **$350 ex / $385 inc** |
| Portal | Locked live |
| Portal screenshot | `data/roof-report-portal-pairs-v1/screenshots/SWMS-261081-portal.png` (F7 evidence-frame capture) |
| Portal stamp | `mark_makesafe_portal_report_done` → cycle 1 verified |
| Cycle bind | `makesafe_state_seed_scoped` run_key `roof-report-portal-pairs-v1-261081-seed` → attendance cycle created + bound (`attendance_cycles_created: 1`) |
| Portal capture ledger | F7 observer `--commit` → `submitted_locked` **written** (1 production evidence write; 0 stage moves) |
| Docket / obligation | ready → obligation revision `9ca0cdd4-…` |
| Mint | `create_ses_invoice_draft` → **INV-1145** DRAFT $385 |
| ACCREC scan | **`scanned_accrec: 1170`**; `invoice_create_dispatched: true`; `send_dispatched: false` |
| Invoice PDF | `data/roof-report-portal-pairs-v1/invoices/SWMS-261081-INV-1145.pdf` |

---

## Named blockers (not padded greens)

### A) Claim-only sibling holds the invoice — portal locked, **do not mint**

| Job | Suburb | Builder ref | Portal | Why mint is closed |
|---|---|---|---|---|
| **SWMS-261116** | Morley | MLB-27387 | Locked screenshot `screenshots/SWMS-261116-portal.png` | Sibling **SWMS-261115** already has **INV-1128 AUTHORISED** on the same reference |
| **SWMS-261079** | Floreat | MLB-27148 | Locked screenshot `screenshots/SWMS-261079-portal.png` | Sibling **SWMS-261080** already has **INV-1126 AUTHORISED** on the same reference |
| **SWMS-261019** | Floreat | MLB-27037 | Locked screenshot `screenshots/SWMS-261019-portal.png` | Sibling **SWMS-261020** already has **INV-1127 AUTHORISED** on the same reference (also unlinked DRAFT INV-1116 on a PO-scoped ref) |

These match the standing rule: **do not mint for a claim-only sibling where another card already holds the invoice**. Open Captain decision — not worker mint.

### B) Known seed card checked

| Job | Suburb | Notes |
|---|---|---|
| **SWMS-261116** Morley | (above) | Confirmed genuine roof-report + portal; mint blocked by sibling AUTHORISED, not by missing portal |

### C) Live share open but **not submitted**

| Job | Suburb | Portal state |
|---|---|---|
| **SWMS-261123** | Cottesloe | Form open with **Submit** — not locked |
| **SWMS-261146** | Mosman Park | Form open with **Submit** — not locked |
| **SWMS-26928** | Balga | Form open with **Submit** — not locked |

### D) Share link **expired** / inactive (sample of observed)

Includes ready_to_invoice / DRAFT-bearing cards that **cannot** form a portal pair without a submitted page:  
SWMS-26735 Glen Iris (INV-0871 DRAFT), SWMS-26736 Usher (INV-0873 DRAFT), SWMS-26759 Myalup (INV-0877 DRAFT), SWMS-26709 / 26754 Karrinyup DRAFTs, SWMS-26803 Innaloo DRAFT, SWMS-26848 Dianella DRAFT, SWMS-26934 Seville Grove (historical capture `done` but link now expired), SWMS-26957 Kardinya, and most older complete/AUTHORISED share links.

**Rule applied:** expired or open-form pages are blockers — not screenshots of something else.

### E) Excluded by brief (not touched)

Swanbourne AJBR-70554, Attadale AJBR-70499, Koondoola SWMS-261025, Mosman Park SWMS-261147; Maylands, Bertram, Munster, Queens Park; Gidgegannup / Ballajura / Woodvale / Carine cards.

---

## Census notes (portal-first)

- Roof-report cards with any Primeeco URL: **~61** (board-active, non-cancelled).
- Share-style portal URLs after expand: **74** (many rows are CDN/logo pollution typed `builder_portal` — filter is `primeeco.tech/share/`).
- Live **locked/submitted** among shortlisted observe set: **6** (3 clean mint/PDF + 3 claim-sibling blocked).
- Materials three-state: **not applicable** — roof portal family prices **storey-fixed** ($350/$385 double here). No silent materials omission path on these cards.

---

## Proof index

| Artifact | Path |
|---|---|
| Mint summary (ACCREC counts) | `proof/mint-summary.json` |
| 261114 mint response | `proof/SWMS-261114-mint2.json` |
| 261081 mint response | `proof/SWMS-261081-mint2.json` |
| 261081 seed + F7 | `proof/SWMS-261081-seed-live.json`, `f7-261081/` |
| Portal stamps | `proof/SWMS-261114-portal-done.json`, `proof/SWMS-261081-portal-done.json` |
| Screenshots | `screenshots/*-portal.png` |
| Invoice PDFs | `invoices/*.pdf` |

---

## Hard boundaries respected

- DRAFT only; **no** send / approve / authorise / void  
- Full live ACCREC duplicate guard on every mint (`scanned_accrec` 1169 / 1170)  
- Claim-sibling money not reminted  
- No photo cull; no trade evidence rewrite  
- No migration required  
- Local-only branch; no push / PR  
