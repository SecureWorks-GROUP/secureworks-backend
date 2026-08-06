# Captain pre-shutdown send batch — resume state (2026-08-06)

**Nothing has been sent. No invoice has been authorised. No builder has received anything.**

This worker secured the prior run's evidence (commit `7d33c0d`) and verified live
money state read-only. It could not proceed to mint/authorise/send: **`SW_API_KEY`
is not present in this environment**, and every remaining step is an api-key-only
ops-api action.

## Verified live invoice state (read-only, via SecureSuite ops-api, 2026-08-06)

| Card | Job id | Invoices | Live? |
|---|---|---|---|
| Mosman Park | `762ebaad-5f6f-4477-acb7-30db016b15ea` | INV-1143 DELETED $467.50, INV-1146 DELETED $921.03, **INV-1147 DRAFT $885.50** | Yes — one DRAFT, correct total |
| White Gum Valley | `088dee02-91d0-4539-8c9c-6014c9ebf06e` | INV-1144 DELETED $385 | **NO LIVE INVOICE — unbilled** |
| Mindarie | `967cdb6e-e57e-46ea-89d8-14e8afbc2ada` | INV-1145 DELETED $385 | **NO LIVE INVOICE — unbilled** |

Gwelup `5383e3c4` / INV-1015 deliberately untouched at $385 — not in scope.

Mosman INV-1147 total `885.50` matches the Captain's figure exactly
(500 labour + 235 materials + 70 disposal = 805 ex / 885.50 inc). Minted under a
full live ACCREC duplicate guard (`scanned_accrec: 1172`, `03-pre-mint-live.json`
empty = clean). Reference `MLB-27482`, Xero id `8f7687b0-effb-4522-aaf7-7b4148168d1e`.

## Remaining work, in order

1. **Remint WGV** at 300 ex / 330 inc — `prepare_ses_invoice_obligation` with
   `labour_rate_override` recording `sealed_unit_price_ex_gst: 350`,
   `authorised_unit_price_ex_gst: 300`, reason = Captain pre-shutdown roof-report
   repricing. Then `create_ses_invoice_draft` (full live ACCREC guard).
   Cycle already cleared — see `01-wgv-mindarie-cycle-clear.json`. **Do not re-void.**
2. **Remint Mindarie** identically (`967cdb6e`, ref `MLB-27100`).
3. **Authorise then send, one card at a time**, proving each in Sent Items before
   the next: Mosman (INV-1147, already minted) → WGV → Mindarie.
   Sealed release graph only: `prepare_ses_release_revision` →
   `approve_ses_release_revision` → `execute_ses_release_revision`.
4. Move already-RELEASED cards to completed.

## Paths that must NOT be used

`sw_approve_invoice` / `sw_approve_and_send_invoice` (SecureSuite MCP) are the
legacy generic Xero paths. All SES cards carry `ses_money_sealed_at`, so these are
sealed writes the money fence exists to refuse. `approve_and_send` additionally
mails a Xero-branded invoice to the contact's Xero address — wrong transport, wrong
recipients, no report pack, and it bypasses Docs Ready signoff. These are MLB cards;
the billing pack goes to `makesafes@` with finance@ cc via the release graph.

No Vanessa resend. No photo cull. No trade evidence edits.
