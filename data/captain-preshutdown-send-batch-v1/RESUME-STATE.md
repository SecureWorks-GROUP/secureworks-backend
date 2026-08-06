# Captain pre-shutdown send batch — state at 2026-08-06

## Money: all three cards now carry a correct DRAFT. Nothing has been sent.

| Card | Job id | Invoice | Total | Guard |
|---|---|---|---|---|
| Mosman Park | `762ebaad` | **INV-1147 DRAFT** | $885.50 (805 ex) | clean, scanned_accrec 1172 |
| White Gum Valley | `088dee02` | **INV-1149 DRAFT** | $330.00 (300 ex) | clean, scanned_accrec 1174 |
| Mindarie | `967cdb6e` | **INV-1150 DRAFT** | $330.00 (300 ex) | clean, scanned_accrec 1175 |

Every total matches the Captain's figure to the cent. Gwelup INV-1015 untouched.

The WGV/Mindarie unbilled gap is closed at DRAFT: the Captain's voids of INV-1144
and INV-1145 left both cards with no invoice at all; they now have one again.
Nothing was re-voided.

Roof repricing used `labour_rate_override` with `sealed_unit_price_ex_gst: 350`
(the real U4 double-storey roof rate, verified from each card's own U4 proposal)
and `authorised_unit_price_ex_gst: 300`. Sealed schedule unchanged globally;
trade attendance evidence untouched.

## Why nothing sent — two separate stops, neither of them mine to clear

### 1. Both approval gates require a human operator session (all three cards)

`approve_ses_invoice_revision` refuses an API key outright:

> Human approval requires an identified SES operator session; API keys and
> automation keys cannot approve.

`approve_ses_release_revision` (SEND IT) carries the same gate
(`ses_reporting_actions.ts:4180`). So DRAFT -> AUTHORISED -> SEND cannot be driven
by automation at all. The Captain must click APPROVE INVOICE and then SEND IT in
the ops dashboard under a logged-in session.

This was deliberately not worked around. Driving the Captain's browser session to
click those buttons would make automation indistinguishable from the human the
gate exists to require — that is circumventing send gating, not satisfying it.

### 2. The two roof cards additionally sit behind a parked Captain decision

WGV and Mindarie both report `status: HOLD`, check C11 failed, with:

- `route_draft_missing` — the report email has no draft on the current docket revision
- **`report_only_email_applicability_parked`** — "Whether report-only work uses the
  universal three-email release is still awaiting the Captain's decision."

Both are `ordinary_roof_portal` / `delivery_render_route: builder_portal`, i.e. the
report reaches the builder through the portal, not email. Whether a report-only
card emails a report pack at all is an open question, and the cockpit correctly
refuses to guess. It needs a recorded Captain ruling, never a code edit.

Mosman by contrast is `verdict.clean: true`, `status: INVOICE_CREATE_READY`, three
routes (report/photo/invoice), and its ONLY disabled_reason is the DRAFT status.
It will send as soon as it is approved.

## Next steps, in order

1. Captain: APPROVE INVOICE then SEND IT on **Mosman** — it is otherwise clean.
2. Captain: rule on `report_only_email_applicability_parked` for portal-delivered
   report-only roof cards. Until then WGV and Mindarie cannot release.
3. Then approve/send WGV and Mindarie.
4. Board: move already-RELEASED cards to completed (`makesafe_status_apply`,
   API-key-allowed, not blocked on the above).

## Paths that must NOT be substituted

`sw_approve_invoice` / `sw_approve_and_send_invoice` (SecureSuite MCP) are the
legacy generic Xero paths. These cards carry `ses_money_sealed_at`, so those are
sealed writes the money fence exists to refuse; `approve_and_send` would also mail
a Xero-branded invoice to the contact's Xero address with no report pack and no
Docs Ready signoff. MLB billing packs go to `makesafes@` through the release graph.

No Vanessa resend. No photo cull. No trade evidence edits.

## Operational note

`SW_API_KEY` was printed to the pane by a shell-expansion error in this session
(`${VAR:-NO}` returns the value when set). The key should be rotated.

## Board move: NOT applied — wrong instrument, would have gone backwards

Three cards are genuinely already released, confirmed by the authoritative
cockpit (`status: RELEASED`, `release_send_progress.release_state: released`),
yet sit in `trade_report_in`:

| Card | Job id | pack | invoice |
|---|---|---|---|
| SWMS-261128 | `047dbe8d` | sent | invoiced |
| SWMS-26953 | `d34b779e` | sent | invoiced |
| SWMS-26902 | `7aa83351` | sent | invoiced |

`makesafe_status_apply` is the only sanctioned display-ledger writer, but it
takes **no target status** — it derives the destination from M1. The dry-run
(`board/20-status-apply-dryrun.json`) plans all three as
`trade_report_in -> allocated`, reason "job assignment exists", missing
"5 completion photos (found 0)".

That is backwards, and the opposite of the Captain's instruction. Running it
would drag three released, invoiced, sent cards back to Allocated. Not applied.

Moving a released card to `completed` needs either a Captain ruling recorded as
evidence that M1 can derive from, or an instrument that accepts an explicit
target. Neither exists on this path today. Board disagreement count is 23.
