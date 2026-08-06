# Mosman Park SWMS-261147 - F01/F02 outcome, $110 reprice, SWMS pack proof

Date: 2026-08-06
Branch: `fm/mosman-doc-integrity-f01-f02-v1`
Card: job `762ebaad-5f6f-4477-acb7-30db016b15ea`, SWMS-261147, MLB-27482, Mosman Park
Mode: **operational + docs. No code change. No migration.**

Nothing was approved, authorised, sent, minted or voided. One inert
`makesafe_invoice_void_revisions` row was prepared (`external_mutations: {xero:0, email:0}`).

## 1. F01 - the integrity column is not lying, it is a different thing

**Cause: misread column, not a broken write.** `job_documents.makesafe_content_hash` is
**not** a hash of the file's bytes and never was. It is the row **fact-identity** hash
stamped by the `trg_job_documents_fact_identity_v1` trigger
(`stamp_makesafe_fact_identity_v1`, `20260728060000_makesafe_board_reconcile_truth_u2.sql`):

```
v_payload := to_jsonb(NEW) - 'makesafe_fact_version' - 'makesafe_content_hash' - 'updated_at';
v_hash    := makesafe_fact_hash_v1(TG_TABLE_NAME, v_payload);
```

It digests `'SecureWorks:make-safe-fact:v1:job_documents\n' || canonical_json(row)` - the row,
including its own `id` - so it **cannot** equal the PDF's sha256 by construction. It exists so
`makesafe_state_compare.ts` can tell whether a row changed, paired with `makesafe_fact_version`.
Production's deployed function body was read and matches the repo (plus the restoration widening).

### The sweep Maverick asked for

Board-wide, every curated-bound report row, read-only Management API:

| Measure | Count |
|---|---:|
| `job_documents` rows carrying a bound `curated_source_expected_raw_sha256` | **31** |
| of those, `makesafe_content_hash` equal to that byte hash | **0** |
| of those, `makesafe_content_hash` well-formed `sha256:<64hex>` | 31 |

SWMS-261147 is not anomalous. `0/31` is the whole population. If the column were a byte
hash it would match on all 31.

Artifact: `f01-boardwide-sweep.json`.

### The byte-integrity record on this row is correct and already matches

| Field | Value |
|---|---|
| `data_snapshot_json.curated_source_expected_raw_sha256` | `sha256:e8b2974f53d5…4244d0` |
| `data_snapshot_json.report_render_hash` | `e8b2974f53d5…4244d0` |
| Served bytes, re-downloaded and hashed 2026-08-06 | **`e8b2974f53d5…4244d0`** (2,635,527 bytes) |
| Docket artifact `metadata.output_sha256` / `expected_raw_sha256` | `sha256:e8b2974f53d5…4244d0` |

Four-way match. This is the field `inspectSesSupportingReportProof` and
`sesSupportingReportDocumentBinding` actually enforce, and it is the one that decides whether
a signed URL is served. The card's document integrity is intact.

`superseded_at: null` is also correct: this row **is** the current bound document. The prior
bind was superseded in place (same row, `version` 1 -> 4), which the bind audit event records as
`supersedes_prior_bind: true`. Marking the live row superseded would make the card serve nothing.

Artifact: `f01-document-row.json`.

### So what is the fix

There is no honest data correction available, and writing `e8b2974f` into that column would be
wrong twice over:

1. It would not persist. The trigger is `BEFORE UPDATE` and recomputes the value on every write,
   so the column would revert on the next touch.
2. If it did persist it would **corrupt** the state-authority comparator that
   `makesafe_state_compare` / the board reconcile engine reads, on a card the Captain is about to
   send.

Changing the column's meaning needs a migration - **`stamp_makesafe_fact_identity_v1` would have
to stop stamping `job_documents`, and six tables share that trigger** - so per the brief it is
named and not attempted.

**The real defect is the name.** A column called `makesafe_content_hash`, formatted
`sha256:<64hex>`, sitting beside genuine byte digests, reads as a byte digest to any reviewer.
It already produced one high-severity false finding on a live money card. The proportionate fix
is the `CLAUDE.md` entry added in this commit, not a rename.

### One adjacent instance of the same confusion, in shipped code

`ses_mailer_ops_send.ts:955` uses `job_media.makesafe_content_hash` as a photo's byte hash,
falling back to `sesSha256Bytes(bytes)` only when it is absent or malformed - and for make-safe
media the trigger always populates it, so the fallback never runs. The value flows into
`attachmentByHash` (a map key) and the audit `provider_digest`. Consequence: the recorded
`content_hash` for a builder-facing photo attachment does not attest the bytes sent. It still
uniquely keys each media row, so no wrong attachment ships. **Reported, not fixed** - it is a
code change on a send route and outside this task.

## 2. F02 - CLOSED by the Captain

Ruling 2026-08-06, after reviewing the report in the cockpit: **the door is SLIDING**, the trade
form was right, his own earlier "roller" was the error, and he has **reviewed and ACCEPTED the
report as it stands**. Recorded as fact, not actioned: the prose was not touched, nothing is
blocked on the wording, and no re-bind was performed.

The evidence trail, for the record:

| Source | Verbatim |
|---|---|
| Trade `checklist_json.work_done` (SR `b7edf9d8-…`) | "…Taped any sharp edges on the **roller door** and removed any loose glass. Framed both bedroom window and **sliding door**, then screwed plyboard onto the frame…" |
| Trade `checklist_json.damage_description` | "Completely smashed bedroom window and smashed **roller door** around handle." |
| Captain's dispatch instruction, `mosman-park-remint-v1` brief | "…**board-up frames on the bedroom window and the roller door area**; and the **glass cleanup**." |
| Served report v4, Works Completed | "Board-up frames were built on the bedroom window and the **roller door** area…" |

Two things worth keeping. The trade's own form uses **both** words in one paragraph, so
"roller" was never invented by curation - it is in the trade's damage field and in the trade's
own work_done sentence before the framing sentence. And report versions 2 and 3 carried both
openings ("Taped … the roller door … Framed both the bedroom window and sliding door"); v4
collapsed them to one under the Captain's instruction wording. He has now settled it: one
opening, sliding.

`attribution.json` for v4 sources this claim to **Trade** `job_type_detail` / `work_done`. On the
framing clause that is inaccurate - `job_type_detail` is just "Board up frames" and the trade's
framing sentence names the sliding door - the actual source was the Captain's instruction. Noted
for accuracy of the ledger; the document itself is accepted and unchanged.

Artifact: `f02-trade-service-report-verbatim.json`.

## 3. Reprice to the new standing rule - arithmetic checked against the card

New Captain standing rule 2026-08-06: **MLB after-hours labour is $110/h**, not $100.

Every input re-read from production before computing:

| Line | Current (INV-1147) | Reminted |
|---|---:|---:|
| Labour 1 trade x 5h after hours | 5 x $100 = **500.00** | 5 x **$110** = **550.00** |
| Materials (structural timber 8m + ply 12mm 2.4x1.8 x3 + screws) | **235.00** | **235.00** unchanged |
| Glass disposal (own line, Captain kept it) | **70.00** | **70.00** unchanged |
| **Subtotal ex** | **805.00** | **855.00** |
| GST 10% | 80.50 | **85.50** |
| **Total inc** | **885.50** | **940.50** |

`550 + 235 + 70 = 855`; GST `85.50`; inc `940.50`. **Matches the instructed figure to the cent.**

**The materials figure is $235**, confirmed from the live obligation revision
`b2047fe3-48b2-5feb-b5fc-9740ae24da60` (`unit_price: 235`, decision key
`captain-preshutdown-send-batch-v1-mosman-mat235`), not from the older $267.30. Nothing to stop
and report.

Trade attendance evidence is untouched: `labour_hours: 5`, `trade_count: 1`, sealed MLB rate
$85 unchanged in the shared schedule. The $110 rides the existing card-scoped
`labour_rate_override` instrument (`commercial_rate_override`), the same one INV-1147 used for
$100 - no new product code needed.

## 4. SWMS - it is in the pack, with proof

Checked against the committed docket `68bd7247-0662-555d-b183-17e6c5e65e97`
(`state: ready`, `pre_xero_docs_ready: true`) via `get_ses_reviewable_pack`:

| Role | Count | Proof |
|---|---:|---|
| `supporting_report_pdf` | **1** | 2,635,527 B, raw sha `e8b2974f…`, re-downloaded 200 |
| `swms_artifact` | **1** | 919,559 B, signed URL fetched **200**, byte-for-byte size match |
| `xero_invoice_pdf` | **1** | INV-1147, `source: live_fetch`, `pdf_unavailable: false` |

`blockers: []`, `suppressed_artifacts: []`. The SWMS is generated
(`generator: ops-api:ses_swms_render`, `template_kind: general_makesafe`), bound to this
attendance cycle `b7edf9d8-…` and to the work order `job_document:7264647f-…` - not a reused
attachment. The MLB billing route already carries it:

```
INVOICE_EMAIL_DRAFT
To: makesafes@mlbuilders.com.au   Cc: finance@secureworkswa.com.au
Subject: MLB-27482 - billing pack (report, SWMS, invoice)
Attachments: ARTIFACTS/Make-Safe-Report-SWMS-261147-…pdf,
             ARTIFACTS/SWMS - MLB-27482 - 33-37-Fairlight-Street-Mosman-Park-…pdf
```

The Xero PDF is not on that attachment line yet because the invoice is DRAFT; it attaches at
AUTHORISED, which is his step.

So the SWMS is not missing from the pack. If the cockpit view he reviewed showed it absent,
that is a **display** question on the review surface, not a missing artifact - naming where I
checked so the difference is testable.

Artifact: `pack-roles-proof.json`.

## 5. Where the remint stops, and why

`create_ses_invoice_draft` runs the full live-ACCREC duplicate guard, so INV-1147 must be DELETED
before the $110 DRAFT can mint. The void revision is **prepared and waiting**:

| Field | Value |
|---|---|
| Void revision | **`de0425a7-3834-5513-810b-64e26abf875c`** |
| State | `proposed` |
| Invoice | INV-1147, `8f7687b0-effb-4522-aaf7-7b4148168d1e` |
| Observed -> target | `DRAFT` -> `DELETED` |
| `external_mutations` | `{xero: 0, email: 0}` |

`approve_ses_invoice_void_revision` runs `requireCaptainVoidApproval`, which requires an
`active` `ses_release_operators` row of class `captain` or `admin_owner`. An ops API key is
refused by design - the same gate that refused `approve_ses_invoice_revision` in the pre-shutdown
batch. **Not bypassed.** The earlier `mosman-park-remint-v1` run drove this through a
service_role RPC and recorded it as a visible bypass; that is not repeated here.

Remaining sequence once the Captain approves and executes the void:

1. `execute_ses_invoice_void_revision` -> INV-1147 DELETED
2. obligation cycle clear on `b7edf9d8-…`
3. `prepare_ses_invoice_obligation` with `commercial_quantity_override` +
   `labour_rate_override` (sealed 85 / authorised **110**, reason "after hours")
4. `create_ses_invoice_draft` under the full ACCREC guard -> new DRAFT at **940.50**
5. `prepare_ses_docket_revision` -> re-prove report / SWMS / invoice, one each

Steps 2-5 need no gate an API key cannot pass; only step 1 does.

## Boundaries held

- No approve, no authorise, no send, no mint, no void executed
- Money fence, curated-bind gates and send gating untouched
- Trade evidence not read for a pricing decision and not written
- No photo cull (15/15 current-cycle intact)
- Report prose not touched (F02 closed, Captain-accepted)
- No other card touched - White Gum Valley, Mindarie and Gwelup not read or written
- No migration applied; the one that would be needed is named in section 1

## Ledger files

- `report.md` (this file)
- `f01-boardwide-sweep.json` - 31 rows, 0 matches
- `f01-document-row.json` - the row and its bind coordinates
- `f02-trade-service-report-verbatim.json` - trade form verbatim
- `pack-roles-proof.json` - pack roles, blockers, invoice pdf availability
- `void-prepare.json` - the prepared, unapproved void revision
