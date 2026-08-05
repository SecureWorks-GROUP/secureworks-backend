# SES photo mail volume guard (2026-08-05)

**Task:** `photo-send-volume-guard-v1`  
**Branch:** `fm/photo-send-volume-guard-v1`  
**Mode:** guard only — no send, no cull, no multi-email split implementation.

## Why

A photo pack was observed at roughly **31 MB across ~70 sequential Graph calls**.
That is slow enough to time out, large enough to sit near the mail gateway
ceiling, and sequential enough that a mid-route failure leaves a half-built
draft nobody can reason about. A card that claims ready while the photo email
cannot fit is worse than a card honestly blocked.

## 1. Measured distribution

### Live re-measure tonight

`SUPABASE_ACCESS_TOKEN` in this worktree returned **HTTP 401 Unauthorized**
against the Management API (`/database/query`, project `kevgrhcjxspbxgovpmfl`)
and against the Supabase MCP `execute_sql` path. **No fresh fleet distribution
was obtained in this session.**

Re-run when a valid token is available:

```bash
SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-photo-mail-volume-measure.ts --write
```

That script is read-only (`read_only: true`, SELECT-only, no PII columns) and
aggregates current-docket `completion_photo` artifacts: count, total raw bytes,
max single photo, and how many cards exceed the 35 MiB / 3 MiB ceilings.

### Prior production pins (still the best fleet signal)

Pinned in `AGENTS.md` and `makesafe_report_photo_budget_test.ts` from an earlier
read-only `storage.objects` metadata pass on SES cards:

| Rank | Photos | Total |
|------|--------|-------|
| heaviest | 51 | 33.5 MB |
| 2 | 69 | 27.9 MB |
| 3 | 50 | 20.9 MB |

Interpretation against a **35 MiB** Exchange default message ceiling. Mail
attachments travel **base64-encoded** (≈4/3 of raw), and Exchange enforces the
message-size limit on the **MIME-encoded** message, so the comparison below is
against encoded size on **both** transports (Captain ruling, 2026-08-05):

- The heaviest known card (33.5 MB / 51) sits under 35 MiB *raw* but is
  **~42.6 MiB encoded** — **over** the ceiling. An earlier draft of this guard
  compared raw bytes on the user-mailbox path and reported this pack as FITS;
  that under-refusal is fixed, because a guard that says FITS and then dies at
  Exchange is worse than no guard.
- A **69-photo / ~28 MB** pack is ~35.5 MiB encoded — also at/over the ceiling —
  and implies **~69 sequential attachment POSTs** on the AJS user-mailbox path.
- The **50-photo / 20.9 MB** pin is ~26.6 MiB encoded and still fits.
- Tonight’s **~31 MB / ~70 calls** observation is ~41.3 MiB encoded, so it too
  refuses. It is consistent with that band — not a freak one-off, and not “half
  the board over the limit” either. The structural risk is the **near-ceiling
  total + sequential call count**, not a universal 31 MB floor.

Until the measurement script succeeds, treat those three pins plus the 31 MB
observation as the working distribution; do not invent percentiles.

## 2. Real Graph ceilings (documented)

| Ceiling | Value | Applies to | Source |
|---------|-------|------------|--------|
| Direct `fileAttachment` POST | **under 3 MB** per file | User message, event, **and group post** | [attachment resource](https://learn.microsoft.com/en-us/graph/api/resources/attachment), [Add attachment to post](https://learn.microsoft.com/en-us/graph/api/post-post-attachments) |
| `createUploadSession` | **3–150 MB** per file | User **message/event only** | [Large attachments](https://learn.microsoft.com/en-us/graph/outlook-large-attachments), [createUploadSession](https://learn.microsoft.com/en-us/graph/api/attachment-createuploadsession) |
| Default Exchange Online message size | **35 MB** (tenant may raise to 150 MB) | Whole message (body + attachments) | Noted on createUploadSession docs |
| Group thread reply | **No upload session**; attachments inlined as `contentBytes` on `POST /groups/{id}/threads/{id}/reply`; **per file under 3 MB** | MLB physical report/photo intake-thread replies | [post-post-attachments](https://learn.microsoft.com/en-us/graph/api/post-post-attachments) + our `sendGroupThreadReply` |

**AJS photo route** = admin@ **user mailbox** draft → sequential
`uploadAttachment` → send. Per-file can use upload sessions; **message total**
still bound by the 35 MB default unless the tenant is raised, and that total is
measured on the **base64-encoded** message, not the raw bytes we upload.

**MLB photo route** = **group thread reply** with all attachments base64-inlined
in one POST. Per-file hard-capped at 3 MB; total base64 wire size must also fit
the message ceiling. A single 4 MB photo that would be fine on AJS **refuses on
MLB**.

## 3. Sequential-call path (file + line)

### AJS / user-mailbox path (explains ~70 calls)

| Step | Location | Behaviour |
|------|----------|-----------|
| Load attachment bytes by hash | `index.ts` `loadSesRouteAttachments` ~1486–1517 | Sequential storage downloads per hash |
| Volume guard (new) | `ses_graph_mail_gateway.ts` `assertSesPhotoMailVolumeFits` ~514 | Refuses before any Graph URL when pack cannot fit |
| Create draft | `ses_graph_mail_gateway.ts` `createDraftAndSend` (user-mailbox branch after guard) | 1 Graph POST `/messages` (or createReply) |
| **Per attachment upload** | `ses_graph_mail_gateway.ts` **~570** `for (const attachment of attachments) { await deps.uploadAttachment(...) }` | **Must be one Graph operation sequence per file** (Graph has no multi-file attach batch on messages) |
| Upload implementation | `index.ts` `uploadSesGraphAttachment` **1520–1567** | `< 3 MB`: 1 POST `/attachments`; else `createUploadSession` + sequential 3.2 MB PUTs |
| Send + Sent Items poll | gateway after the attachment loop | 1 send + up to 20 poll GETs |

So for ~70 photos each under 3 MB: **~70 sequential attachment POSTs**, plus
draft create, send, and polls. Attachments **cannot** be batched into one Graph
attach call on the user-message path; Graph documents “attach the files
individually.” Parallelising uploads would be a reliability change, not a size
fix, and is out of scope for this guard.

### MLB / group-thread path

| Step | Location | Behaviour |
|------|----------|-----------|
| Inline all attachments | `ses_graph_mail_gateway.ts` `sendGroupThreadReply` (after volume guard) | Single POST with `post.attachments[]` base64 `contentBytes` |
| Proof poll | same function after reply accepted | List thread posts |

Call count is low; the failure mode is **payload size / per-file 3 MB**, not
sequential attach loops.

## 4. The guard

**Module:** `supabase/functions/ops-api/ses_photo_mail_volume_guard.ts`  
**Named blocker / refusal code:** `photo_mail_volume_exceeds_graph_limit`

### Behaviour

- Evaluates **raw attachment sizes** against the documented **per-file** ceilings
  (under 3 MB direct/group post; 3–150 MB user-mailbox upload session), and the
  **base64-encoded total** against the 35 MB Exchange message ceiling on **both**
  transports, because the message travels MIME-encoded either way.
- On exceed: **clear named refusal** with actual total, actual limit, transport
  kind, and offending files.
- **Never** drops, downscales, re-encodes, or truncates photos.
- Multi-email split is a **recommendation string only** — not implemented.

### Wiring (three layers, all refuse before Graph when sizes known)

1. **Prepare (docket):** after `completion_photo` artifacts exist, before
   email drafts claim ready — adds `SesBlocker`
   `photo_mail_volume_exceeds_graph_limit` so the card cannot honestly sit
   docs-ready. (`ses_prepare_docket_revision.ts`)
2. **Execute (SEND IT):** loads `size_bytes` from `makesafe_docket_artifacts` by
   route `attachment_hashes` and throws `SesActionError` 409 with
   `sesPhotoMailVolumeRefusal`. (`ses_reporting_actions.ts`)
3. **Gateway:** after `loadAttachments`, before any Graph URL —
   `assertSesPhotoMailVolumeFits`. (`ses_graph_mail_gateway.ts`)

## 5. What tests prove vs residual unknown

### Tests establish (`ses_photo_mail_volume_guard_test.ts`)

- Pure limit math (3 MB / 35 MB / 150 MB; base64 length; transport selection).
- Named code and human-readable reason include **actual size and actual limit**.
- `photo_cull: false` on blocker/refusal evidence.
- Gateway refuses an oversized pack **with zero Graph calls** (mocked deps).
- ~70 sequential call estimate for the user-mailbox attachment loop.

### Tests do **not** prove (only a live send would)

- This tenant’s **customised** Exchange message size (may be higher than 35 MB).
- Whether Graph rejects a multi-attachment group post earlier than the
  documented per-file / message limits (request body limits, gateway timeouts).
- The exact MIME envelope/header overhead on top of the encoded attachment
  bytes (the guard counts encoded attachments only, so it is if anything still
  slightly generous).
- End-to-end builder receipt.

**No live send was performed** (hard boundary). The residual unknown is the
tenant-specific ceiling and operational timeout, not the guard’s refusal shape.

## 6. Recommendation (not implemented)

If measurement shows a recurring band of packs under 35 MB raw but failing on
timeouts, or packs over 35 MB, the product decision is almost certainly
**ordered multi-email photo delivery** (or an out-of-band complete share) —
still **no photo cull**. That requires a Captain ruling; this change stops at
the honest pre-Graph refusal.

## 7. Migration

**None.** No schema change. Captain away — no migration asked for.
