# Mailer ops send action v1

**Status:** Built and unit-tested. **Zero emails sent.**  
**Action:** `ops-api?action=send_mailer_ops_visibility`  
**Branch:** `fm/mailer-ops-send-action-v1`

## Captain instruction (including 2026-08-05 CC clarification)

Both emails:

| Field | Value |
|-------|--------|
| FROM | `admin@secureworkswa.com.au` (structural) |
| TO | card work-order mailer (e.g. `mlb.mailer@primeeco.tech`), **named explicitly by the operator** and confirmed against the card-bound / configured allowlist |
| CC | **`ses@secureworkswa.com.au` exactly** (structural; intake mailbox = second proof surface) |
| Subject | Exact original WO subject (PR 591 path); photo fallback `Photo Evidence - {REF}` |
| Email 1 | make-safe report PDF only |
| Email 2 | capped photos (~12, representative spread) |
| Invoice | **structurally impossible** on this route |
| Proof | Sent Items message id, subject as sent, To+CC, attachment names, `x-secureworks-ses-operation` |
| Drive | **one `job_id` + `kind` per call** (card one hard-stop before remaining cards) |

## What was built

| Piece | Path |
|-------|------|
| Migration | `supabase/migrations/20260805020000_ses_mailer_ops_send_effect.sql` |
| Rollback | `supabase/rollbacks/20260805020000_ses_mailer_ops_send_effect_down.sql` |
| Module | `supabase/functions/ops-api/ses_mailer_ops_send.ts` |
| Tests | `supabase/functions/ops-api/ses_mailer_ops_send_test.ts` (20 pass, **zero Graph**) |
| Wiring | `ops-api/index.ts` case `send_mailer_ops_visibility` + `makeMailerOpsGraphMailGateway` |
| Effect kind | `mailer_ops_send` on `ses_external_effects` (job_id + report\|photo + attempt `artifact_hash`; no release_revision_id) |

### Call shape

```http
POST /functions/v1/ops-api?action=send_mailer_ops_visibility
Authorization: Bearer <SW_API_KEY>
Content-Type: application/json

{
  "job_id": "<uuid>",
  "kind": "report" | "photo",
  "dry_run": true,
  "to": "mlb.mailer@primeeco.tech",
  "attempt_key": "<optional; only for a deliberate retry>",
  "job_document_id": "<optional makesafe_report id>"
}
```

- **`dry_run` defaults true.** Live Graph requires explicit `dry_run: false` under Captain supervision.
- Privileged only (`api_key` or admin/owner JWT). **Not** on `ROUTINE_ALLOWED_ACTIONS`.
- One card, one kind per call — never a batch of four.
- **`to` is required.** It is confirmed against this card's own intake sender
  (`emails.from_email` reached through the card's intake case sources) plus the
  company's full-address `sender_patterns` entries. `sender_patterns` is an
  INBOUND trust list — who we accept work orders FROM — so it may confirm a
  destination but never auto-select one. The refusal
  (`mailer_recipient_confirmation_required`) lists both candidate sets, so the
  operator still gets the preview an auto-select would have given.

### Retry coordinate (exact-once without a dead end)

The effect identity is `mailer_ops_send + job_id + route_kind + artifact_hash`,
where `artifact_hash` covers only STABLE coordinates: kind, `to`, `cc` and the
operator's optional `attempt_key`. That is the same escape `route_send` gets
from a fresh `release_revision_id`:

- the same card + kind + recipients + attempt key is ONE effect (exact-once);
- any call that did not itself dispatch — an already-confirmed replay, or a
  reconcile that proves an EARLIER attempt's message under the same token —
  sends nothing and returns `already_sent: true` with the **stored** ledger
  proof (`recorded_proof`), never a proof recomposed from today's re-resolved
  subject and attachments. Such a call audits as
  `mailer_ops_visibility_reconciled`, not as a fresh send, and the effect's
  `provider_digest` carries subject/attachment claims only when that same call
  composed the message (`content_proof`);
- a Graph failure parks that attempt on `unknown` and it is still **never**
  redispatched — the operator reconciles Sent Items by token, then retries
  deliberately under a new `attempt_key`, which mints a new operation key.

Re-resolved content (subject, attachment hashes, photo selection) is
deliberately **excluded** from the identity. It moves on its own — one more
uploaded photo re-picks the representative spread, and a transient `emails` /
`makesafe_intake_drafts` read error changes the recovered subject — so content
in the identity would mint a second operation key and mail the builder again
with no operator decision behind it. Content travels in `payload_hash` instead,
where `claim_ses_external_effect_v1` raises 23505 and
`reconcileSesEffectAfterContentDrift` returns the ORIGINAL effect: drift
reconciles, it never sends. Only a named `attempt_key` frees a stranded card,
and stranded-and-visible is the deliberate trade against a duplicate the builder
sees.

### Attachment names

Photo attachments are named from the trade's own `label`, ordinal-prefixed
(`01-front-fence-damage.jpg`), falling back to `site-photo-NN.ext` when the row
carries no label. Storage objects are UUID-named, so the raw object name is
never the builder-facing one. The extension comes from the stored object /
content type, and `job_media` has no `file_name` column — do not read one.

### Evidence scope

Attachments are scoped to the card's CURRENT attendance cycle through the shared
`filterMediaForCurrentCycle` / `isEvidenceBoundToCurrentCycle` boundary in
`makesafe_cycle_evidence.ts` (no private fourth copy of that rule), so a
reattended card cannot mail a previous visit's photos or report. `phase:'receipt'`
media are excluded: receipts are our cost evidence, stored as `type:'photo'`, and
must never reach the builder on the one route whose invariant is that no money
information travels. Both exclusions are counted in the response
(`excluded_receipt_count`, `excluded_other_cycle_count`).

### Structural no-invoice

1. TypeScript: `MailerOpsRouteKind = "report" | "photo"` (no invoice).
2. TypeScript: `MailerOpsAttachmentRole = "report_pdf" | "site_photo"` (no invoice role).
3. DB CHECK: `mailer_ops_send` only allows `route_kind IN ('report','photo')`.
4. Runtime refuses money document types and refuses To == company `report_recipient` (makesafes@ billing path).
5. Attachment loader is closed over this send’s prepared map only — never docket invoice hashes, never Xero PDF path.

### Fences satisfied, not softened

| Fence | How satisfied |
|-------|----------------|
| `pdf_provenance_required` | Report path requires a `job_documents` row `type=makesafe_report` owned by `job_id`; prefers curated bind stamps; verifies plain SHA-256 against `curated_source_expected_raw_sha256` when present. Same code family as Outlook’s document-bound check — **not** an exemption on `send-outlook-email`. |
| `sealed_ses_release_required` | This action **is** the audited route: `effect_kind=mailer_ops_send`, operation token, Sent Items reconcile, job_events audit. Does **not** add names to `SEALED_SES_MONEY_READ_EXEMPT_ACTIONS`, does **not** touch `assertOutlookSesDeliveryAllowed`, does **not** modify `execute_ses_release_revision`. |
| Money fence | Untouched. No mint/authorise/void/link. |

### CC as proof surface

`MAILER_OPS_CC` is fixed to `SES_RELEASE_CC` = `ses@secureworkswa.com.au`.  
`assertMailerOpsCcInvariant` refuses any other set.  
Proof digest includes `cc` and `proof_surfaces: ["admin_sent_items","ses_intake_cc"]` so the intake-mailbox copy is part of the recorded proof, not optional.

### Photo cap

`MAILER_OPS_PHOTO_CAP = 12` lives **only** in `ses_mailer_ops_send.ts`.  
Billing pack / docket / curated report do not import it.  
Selection is a representative index spread (`selectRepresentativePhotoIndices`), not first-N.  
PR 587 volume guard still refuses an oversize capped set (no further silent trim).

## Migration named (required)

`20260805020000_ses_mailer_ops_send_effect.sql` — adds `mailer_ops_send` to `ses_external_effects` because existing `route_send` **requires** `release_revision_id`, which this ops-visibility path must not invent. The shape CHECK requires `artifact_hash` (the attempt coordinate) and the partial unique index is `(job_id, route_kind, artifact_hash)`.

Apply **before** deploying matching `ops-api` (standard edge deploy lane). The
new index is declared in `scripts/edge-function-schema-requirements.txt`, so an
`ops-api` deploy that lands ahead of the migration is refused by the read-only
schema gate rather than failing later at claim time (both constraint names it
rewrites already exist, so only the index proves the apply).

## What a green suite does **not** prove

The mail gateway is mocked in tests. **20/20 wiring tests pass with zero outbound Graph calls.**  
That proves shape, fences, CC, provenance wiring, effect identity, and dry_run defaults — **not delivery**.  
A prior send on this system has already reported success and delivered nothing; do not treat green tests as Sent Items proof.

## Supervised send sequence (after merge + deploy)

1. Apply migration `20260805020000_ses_mailer_ops_send_effect.sql`.
2. Deploy `ops-api` from release `main` only.
3. Dry-run card one report:  
   `kind=report`, `dry_run=true`, job Maylands (or chosen card).
4. Dry-run card one photo:  
   `kind=photo`, `dry_run=true`.
5. Live report then live photo with `dry_run=false` under Captain supervision.
6. Prove admin@ Sent Items **and** ses@ intake copy.
7. **HARD STOP** before cards 2–4.

## Emails sent this task

**0 / 8.** No Graph dispatch from this worktree.
