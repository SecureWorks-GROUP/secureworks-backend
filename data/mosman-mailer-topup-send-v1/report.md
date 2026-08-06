# Mosman Park SWMS-261147 - mailer ops visibility top-up

Card: `SWMS-261147` (job `762ebaad-5f6f-4477-acb7-30db016b15ea`), MLB-27482, Mosman Park.
Scope: ONE card. Captain authorised the make-safe report and the site photos to the
Prime work-order mailer `mlb.mailer@primeeco.tech` under the exact work-order subject.
Nothing re-sent to `makesafes@mlbuilders.com.au`. No invoice on this path.

Status at time of writing: **dry run complete, both routes clean, live send NOT run.**
Waiting on the Captain's go.

Privacy: this ledger carries suburb and job reference only. The work-order subject
contains a street address, so it is recorded here redacted plus a SHA-256 of the exact
string, which is what makes it independently verifiable without publishing the address.

---

## 1. What has already been delivered for this card

Read from production, read-only: `ses_release_route_proofs`, `ses_external_effects`
(`effect_kind='route_send'`), `makesafe_release_revision_routes`, `xero_invoices`.

The billing pack already went, in full, on 2026-08-06. Release revision
`1f354c78-5e57-5962-9b5f-bee413c56b86`, three routes, all confirmed:

| route | to | cc | confirmed (UTC) | operation token | internet_message_id |
|---|---|---|---|---|---|
| report | `makesafes@mlbuilders.com.au` | (none) | 2026-08-06 05:10:41.879Z | `SES-362b48a4-babc-5113-99be-dec5f0a31ed6` | `<SY8P300MB08402663F3C1535F555FDBF693D22@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>` |
| photo | `makesafes@mlbuilders.com.au` | (none) | 2026-08-06 05:10:57.417Z | `SES-a1911f9c-248b-57ab-833a-51277c1304d3` | `<SY8P300MB0840A90C21898632F400A08193D22@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>` |
| invoice | `makesafes@mlbuilders.com.au` | `finance@secureworkswa.com.au` | 2026-08-06 05:11:04.390Z | `SES-61001a69-b0d1-501c-b9b3-66fea86255c8` | `<SY8P300MB084032C6F5AC8A2D2438614093D22@SY8P300MB0840.AUSP300.PROD.OUTLOOK.COM>` |

Effect ids: report `9d7fcbca-9b7e-4735-adec-794c53ce33f4`, photo
`d5621f25-a9eb-42d1-bcbf-540485c83a79`, invoice `60c9045a-93dc-4fe7-b339-b66e2838ba19`.

**Nothing has ever been sent to `mlb.mailer@primeeco.tech` for this card.** There are
ZERO `mailer_ops_send` effects on this job. The card is also absent from the 14-send
mailer ops ledger of 2026-08-05
(`data/mailer-ops-visibility-live-send-ledger-2026-08-05/ledger.json`), which covers
SWMS-261017, -261080, -261020, -261115, -26902, -261128, -261129 only.

So the authorised send is a genuine top-up and not a re-send: the report and photos
reached the BILLING mailbox but never reached the WORK-ORDER mailer at Prime. The two
destinations are different mailboxes serving different purposes, which is the whole
reason the ops-visibility route exists.

### Invoice state - confirmed, and not work

The task brief described INV-1152 as a DRAFT. Production disagreed, and the Captain has
since confirmed the production reading: INV-1152 is **AUTHORISED at 940.50 as of
05:19Z**, he approved it, and the billing pack has already gone to `makesafes@`. That
is precisely why this is a top-up - only the report and the photos are outstanding, and
only to the Prime mailer. The authorised invoice is settled state, not work to do, and
nothing on this path carries an invoice.

Production `xero_invoices` for this job:

| invoice | status | total | last updated (UTC) |
|---|---|---|---|
| INV-1143 | DELETED | 467.50 | 2026-08-06 00:45:32Z |
| INV-1146 | DELETED | 921.03 | 2026-08-06 01:36:14Z |
| INV-1147 | DELETED | 885.50 | 2026-08-06 04:59:57Z |
| INV-1152 | **AUTHORISED** | 940.50 | 2026-08-06 05:19:00Z |

INV-1152 was authorised by effect `e190b0be-a299-46e4-bab9-63fff0b1c311`
(`invoice_authorise`, confirmed 2026-08-06 05:10:04.772Z) and then mailed on the
invoice route above at 05:11:04Z. Maverick should verify against this state, not
against the brief's DRAFT wording.

## 2. The exact work-order subject

Resolved, not guessed. Three independent stores were read and **all three carry one
and the same string**, so there is no ambiguity and no recency fallback was used:

- `emails.subject` for both proven intake `post_id` rows on this card's own
  `makesafe_intake_case_sources` chain (2 rows, both identical)
- `makesafe_intake_drafts.subject` for the approved draft on this job
- `jobs.metadata.builder_email_subject`

Resolved subject (redacted): `NEW WORK ORDER - MLB-27482 U7/ <street address redacted>, Mosman Park, WA 6012`

- exact-string SHA-256: `78ed5e1987733d5e9d9fca86a3819936fef9e718775356f1b6b35768d4ecb3a9`
- length: 75 characters
- `subject_source`: `emails_subject` (the strongest tier)
- `pick_ambiguous`: `false`
- No `Re:` added or stripped. Verbatim, per the ordinary-mail subject rule.

It is byte-identical to the subject the already-sent report and photo routes to
`makesafes@` used, which is a further independent corroboration.

## 3. Route chosen, with file and line

**`send_mailer_ops_visibility`** - `supabase/functions/ops-api/ses_mailer_ops_send.ts`,
action entry `sendMailerOpsVisibilityAction` at line 1175, dispatched from
`supabase/functions/ops-api/index.ts:6895`.

Why this and not a supplementary release:

- It is purpose-built for exactly this need. Module header lines 3-10 record the
  Captain 2026-08-05 ruling: new Mail.Send to the work-order mailer, CC ses@, from
  admin@, exact original WO subject, report PDF only, then a photo email. Same shape
  the Captain named here.
- It cannot carry an invoice. `MailerOpsRouteKind` is `"report" | "photo"` (line 108),
  `MailerOpsAttachmentRole` is `"report_pdf" | "site_photo"` (line 111),
  `assertNotMoneyDocumentType` (line 344) refuses any invoice-ish document type, and
  the DB CHECK on `mailer_ops_send` backs it. A supplementary release runs on the
  route machinery that DOES have an invoice kind, so it is the weaker guarantee.
- It refuses the billing mailbox structurally: `mailer_ops_billing_recipient_forbidden`
  (line 1354) fires if the resolved To equals any consulted company's
  `report_recipient`, which for MLB is `makesafes@mlbuilders.com.au`. The hard "no
  re-send to makesafes@" boundary is enforced by the code, not by my care.
- A supplementary release would also mint a new release revision on a card whose
  release is already fully proved and closed out, which risks disturbing settled
  money-side state for no benefit.

The fallback was therefore not needed and not used.

## 4. Dry run result

Both dry runs returned `success: true, dry_run: true`. No Graph call, no effect claim,
no email. Run with the deliberate `attempt_key` values intended for the live send, so
the previewed `operation_key` is exactly the one a live send would claim.

Common to both emails:

- from: `admin@secureworkswa.com.au`
- to: `mlb.mailer@primeeco.tech` - `to_source: card_intake_work_order_sender`,
  `to_card_bound: true`. It is BOTH this card's own intake work-order sender AND an
  already-configured `makesafe_companies.sender_patterns` entry for MLB. **No
  allowlist was expanded.**
- cc: `ses@secureworkswa.com.au` (server-set, single, not overridable)
- subject: the exact work-order subject above, `subject_source: emails_subject`
- attendance cycle `b7edf9d8-6f68-4cc4-b12a-7aa20d3b070a`, cycle_number 1,
  `cycle_scoped: false` (reattend_count 0, so no reattend boundary exists)
- `fences.invoice_structurally_impossible: true`, `invoice_code_paths: []`

### Email 1 - report

| field | value |
|---|---|
| attachment | `Make-Safe-Report-SWMS-261147-Mosman-Park-359775313575.pdf` |
| role | `report_pdf` |
| size | 2,635,527 bytes (2.51 MiB) |
| content hash | `sha256:7739ab1e5ae4936daba9972b1643d81754623a2466933356dd3d21047cd3a713` |
| job_document_id | `71f64d51-58f4-426a-83fe-57bf800cfd9c` |
| provenance | `curated_bind` (strongest mode) |
| curated identity | `curation-revision:ses-curated-report:SWMS-261147:2026-08-06-mosman-park-remint-v1/...` |
| expected_raw_sha256 | `sha256:e8b2974f53d50d10ab3cb42c8abae50c8074e000a33f3984c08e0145ee4244d0` - served bytes matched |
| attempt_key | `762ebaad-report-mailer-topup-v1` |
| operation_key | `ses:mailer_ops_send:71d3e3a3-58d1-55ac-92eb-8195b0ad7923` |
| external_token | `SES-71d3e3a3-58d1-55ac-92eb-8195b0ad7923` |

One attachment. It is the curated make-safe report bound to the current attendance
cycle. **No invoice present.**

### Email 2 - photos

| field | value |
|---|---|
| attachments | `site-photo-01.jpg` .. `site-photo-12.jpg` (12 files) |
| roles | 12 x `site_photo` |
| content types | all `image/jpeg` |
| available_count | **15** |
| selected_count | **12** |
| cap | 12 (`MAILER_OPS_PHOTO_CAP`, `ses_mailer_ops_send.ts:105`) |
| excluded as receipts | 0 |
| excluded as other cycle | 0 |
| attempt_key | `762ebaad-photo-mailer-topup-v1` |
| operation_key | `ses:mailer_ops_send:0f0602b2-1c6f-56ae-b9a2-1947ee6a3966` |
| external_token | `SES-0f0602b2-1c6f-56ae-b9a2-1947ee6a3966` |

**No invoice present.**

### The photo cap is NOT silent - three photos would be dropped

The card holds **15** site photos in the current cycle. The route would attach **12**.
Three would not go. The route selects a representative spread across the ordered list
(`selectRepresentativePhotoIndices`, line 138), not the first twelve, so the dropped
three are positions 3, 8 and 13 by creation order:

| media_id | size |
|---|---|
| `2bdaf886-d195-467d-8bb4-b104f38b410c` | 508,845 bytes |
| `a5c11ff3-fbaf-492f-bee9-73bb694e3522` | 364,823 bytes |
| `3ed578e6-b462-4d75-9ba7-a0794013e308` | 510,327 bytes |

The 12 selected total 3,959,993 bytes (3.78 MiB raw). All 15 would total 5,343,988
bytes (5.10 MiB raw, about 6.8 MiB base64-encoded).

**The cap here is not a size necessity.** The Exchange Online message ceiling is 35 MB
on the base64-encoded total and the per-file user-mailbox ceiling is 3-150 MB. All 15
photos at 6.8 MiB encoded clear both ceilings with very large margin. The three photos
are dropped purely because the module constant is a flat 12, not because Graph or
Exchange would refuse them.

Standing rule is no photo cull; the Captain's narrow exception permits roughly 10-15 on
this ops-visibility path. 12 sits inside that band, so sending 12 is defensible. But
because nothing physical forces the loss, this is a real choice and is put to the
Captain rather than absorbed. See the open decision below.

## 5. Fences and gates

Nothing was weakened, bypassed or worked around. No gate refused either dry run.

- Sealed SES money fence: untouched. This action is its own audited route
  (`effect_kind = mailer_ops_send`) and does not exempt `send-outlook-email` or any
  money verb.
- Duplicate-send guard: intact. Identity moves only on the deliberate `attempt_key`.
  The two attempt keys above are new and deterministic, so a replay of the same call
  reconciles the original effect rather than sending a second email.
- PDF provenance: satisfied at the strongest mode, `curated_bind`, with the served
  bytes matching the bind coordinate.
- Billing-recipient refusal: armed and correctly not triggered, because the To is the
  work-order mailer and not `makesafes@mlbuilders.com.au`.
- Photo volume guard: evaluated on the composed set, passed.
- No invoice, no approve, no authorise, no mint, no void, no re-price was performed.
  INV-1152 was not touched by anything in this task.

## 6. Live send proof

Not yet run. This section is filled after the Captain's go, and will carry, for each of
the two emails: Graph `message_id`, `internet_message_id`, the recipient list as the
API recorded it, the effect operation key and state, and an admin@ Sent Items readback
matched on the `x-secureworks-ses-operation` header.

## 7. Open decision for the Captain

1. **Go / no-go on the live send.** Both routes are dry-run clean. Nothing has gone to
   the Prime mailer for this card, so this is a first send to that destination, not a
   re-send.
2. **12 of 15 photos, or all 15?** Sending 12 is what the route does today and needs no
   change. Sending all 15 would require raising `MAILER_OPS_PHOTO_CAP`
   (`ses_mailer_ops_send.ts:105`), which is a sealed module constant and is his call,
   not mine. Size is not the constraint either way.

## Reproduction

Read-only production evidence in this report was gathered through the Supabase
Management API with `read_only: true`. The dry runs were:

```
POST /functions/v1/ops-api?action=send_mailer_ops_visibility
{ "job_id": "762ebaad-5f6f-4477-acb7-30db016b15ea",
  "kind": "report" | "photo",
  "to": "mlb.mailer@primeeco.tech",
  "attempt_key": "762ebaad-<kind>-mailer-topup-v1",
  "dry_run": true,
  "actor": "mosman-mailer-topup-v1" }
```
