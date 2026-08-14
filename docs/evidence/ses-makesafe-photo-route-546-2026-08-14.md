# MakeSafe photo-route HTTP 546 — diagnosis and fix (2026-08-14)

**Task:** `makesafe-photo-route-546`
**Branch:** `fm/makesafe-photo-route-546`
**Reported:** Captain Shaun, 2026-08-13 — a completed MLB physical MakeSafe send
should produce three emails (report / photo / invoice, per
`harness/ops/skills/secureworks-makesafe-reporting/references/email-routing-and-approval.md`
in the wiki), but only one reliably goes out in production.

## Verdict

The photo-carrying route dies with HTTP 546 (Supabase Edge worker resource
limit), not a Graph size-limit refusal. Root cause: `uploadSesGraphAttachment`
(index.ts) base64-encodes every sub-3MB attachment via `_bytesToBase64`, which
used a naive per-byte `String.fromCharCode` + string-concat loop — the exact
class of bug this file's own `bytesToBase64` (defined ~16,500 lines earlier)
was already hardened against, with a comment explaining why. The photo route
calls this once per photo, sequentially, inside one edge isolate; a realistic
40-70 photo pack burns enough CPU/memory in that loop to hit the isolate's
resource ceiling and get killed mid-send, after the draft was already created
and checkpointed but before `/send`. The pre-existing photo-mail volume guard
(`ses_photo_mail_volume_guard.ts`, 2026-08-05) does not and should not catch
this — the packs that die are comfortably under its 35 MiB / 3 MiB Graph
ceilings; the failure is CPU-time exhaustion in the encode loop, not payload
size.

**Fix:** `_bytesToBase64` now delegates to the chunked `bytesToBase64`
(one-line change, both functions exported for direct test coverage). No
change to Graph limits, routing, thread-reply logic, or the volume guard.

## Reproduction (read-only, production)

### Edge logs, 2026-08-13 (the day of the report)

```sql
select timestamp, event_message from logs
where source = 'function_edge_logs' and event_message ilike '%546%'
order by timestamp desc
```

Two HTTP 546s that day, both on `ops-api`:

| time (UTC) | action |
|---|---|
| 07:38:47 | `execute_ses_release_revision` — the SEND IT action itself |
| 04:19:43 | `prepare_ses_docket_revision` — docket assembly (separate, heavier-heap defect; see `ses-batch-throughput-2026-08-07.md` §6, not fixed here) |

### The `execute_ses_release_revision` 546, correlated to effect state

```sql
select id, job_id, effect_kind, state, operation_key, created_at, updated_at, external_id
from ses_external_effects
where created_at between '2026-08-13T07:30:00Z' and '2026-08-13T07:50:00Z'
order by created_at asc
```

Three effects in the window, for job `a6eac431-01f0-41df-8ec6-e79e6925f76e`
(docket revision committed 07:37:27, **43 artifacts / 14,483,314 bytes** —
comfortably under the volume guard's ceilings):

1. `invoice_authorise` — `confirmed` at 07:37:25.
2. `route_send` — `confirmed` at 07:37:56, `external_id` a real Graph message
   id. One email sent (the lighter route — a single PDF).
3. `route_send` — created 07:37:57, **stuck in `dispatching`**, `updated_at`
   07:38:32, `external_id` already stamped (a *different* Graph message id,
   from `checkpointDraft`, which runs before the attachment-upload loop).
   The isolate died inside the attachment loop — after the draft existed,
   before `/send` — 15 seconds before the 07:38:47 546. Because the kill is a
   platform-level isolate termination, not a thrown JS error, the
   `executeSesExternalEffect` catch block that would normally transition a
   failure to `unknown` (`ses_external_effects.ts` line ~286) never runs.
   The row is left in `dispatching` forever.

This falsifies "it's a Graph payload-size refusal" (43 photos / 14.5 MB is
well inside the 35 MiB message / 3 MiB per-file ceilings the guard already
enforces) and confirms "it's CPU/memory exhaustion inside the per-attachment
encode-and-upload loop."

## Divergent-path comparison (why report succeeds, photo doesn't)

Both routes call the same `createDraftAndSend` → for each attachment,
`deps.uploadAttachment` (`uploadSesGraphAttachment`, index.ts:1662) → for
files under 3 MB, `_bytesToBase64(attachment.bytes)` (index.ts, formerly the
naive loop) → one Graph POST. The report route has one PDF attachment; the
photo route has dozens. The masking condition is attachment count, not a
different code path — report and photo run the identical loop body, just a
different number of times per release, which is why "the report succeeds and
the photo silently doesn't" reads as route-specific when the trigger is
actually per-attachment CPU cost accumulating across one invocation.

The already-fixed `bytesToBase64` (index.ts, defined earlier in the same
file) is the proven path: its own comment records that the naive
spread-based form "blows the call stack on large PDFs," which is why it was
chunked. `_bytesToBase64` was never migrated to it — every other call site
(`_bytesToBase64` also backs Xero PDF sends) happens to pass small enough
single buffers that the naive loop's overhead never dominated a request,
which is the masking condition that let this survive in the SES send path
specifically until photo counts got high enough.

## Fix

`supabase/functions/ops-api/index.ts`:

- `bytesToBase64` (the chunked, already-proven implementation): exported
  (was module-private).
- `_bytesToBase64`: now `return bytesToBase64(bytes)` instead of its own
  naive per-byte loop. Exported for direct test coverage of the exact
  function `uploadSesGraphAttachment` calls.

No change to `ses_photo_mail_volume_guard.ts`, `ses_mlb_thread_reply.ts`, or
any routing/threading logic. The volume guard's refusal-before-Graph
behaviour for genuinely oversized packs is untouched and still the correct
operator-visible failure mode for packs that really don't fit.

## Operator visibility for a route that still fails

Not new work — confirmed existing and correct. `classifySesReleaseSendProgress`
(`ses_review_cockpit.ts`) is already wired into the job/board response
(`ses_reporting_actions.ts` ~1300-1360) and classifies a release with one
proved route and one still-missing route as `partially_released` with
`missing_route_kinds`, independent of *why* the missing route never proved.
A route stuck in `dispatching` (this bug, or any future failure of the same
shape) is never counted as proved, so it surfaces as a partial release rather
than vanishing. This fix does not touch that classifier; it removes the
proximate cause of a route needing it in the first place at realistic photo
counts.

## Tests

`supabase/functions/ops-api/ses_photo_route_attachment_upload_test.ts` (new):

- `_bytesToBase64` delegates to `bytesToBase64` (identical output).
- Round-trip correctness at a realistic single-photo size (2.9 MB, just
  under the 3 MB direct-post ceiling).
- **Regression guard at realistic pack size:** encodes a 43-photo /
  14,483,314-byte pack (the exact production repro numbers above) via
  `_bytesToBase64` and asserts the encode loop completes in under 3s — a
  generous CI-safe ceiling that still fails hard on a reversion to the naive
  per-character loop.
- End-to-end `createDraftAndSend` through `createSesGraphMailGateway` with a
  stubbed Graph transport (no network, no real email) driving the same
  43-attachment pack through the real send flow, asserting it completes and
  proves sent within 5s.

Note on measurement: Deno std `assertEquals` deep-compares large `Uint8Array`
buffers slowly (multiple seconds at MB scale) — unrelated to `bytesToBase64`
itself, but it will contaminate any timing assertion that wraps it. The tests
here time only the encode step and verify correctness with a fast manual
byte-loop comparison outside the timed section.

Run:

```bash
deno test --allow-env --allow-net=deno.land --allow-read \
  supabase/functions/ops-api/ses_photo_route_attachment_upload_test.ts
```

Full SES suite re-run after the fix: `914 passed, 5 failed` — all 5 failures
reproduced identically against unmodified baseline `index.ts` (verified via
`git stash`), confirming they predate and are unrelated to this change. Four
are named in `docs/evidence/ses-f23-reporting-intake-response-contract-2026-08-10.md`'s
27-failure ledger; the fifth (`ses_artifact_hash_budget_test.ts`) is a
missing `--allow-run` diagnostic-flag artifact of the invocation, same as
that ledger's #25.

## Not fixed here (named, out of scope)

- **`prepare_ses_docket_revision` 546** (04:19:43 the same night) — the
  docket-assembly heap blowup documented in
  `ses-batch-throughput-2026-08-07.md` §6 (photo re-encoding multiple during
  persist). Different code path, different fix; not touched.
- `makesafe_pdf_extraction_drain` cron 401 flood — separate known issue,
  named out of scope in the task brief.
- `MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1` (currently `true`) — MLB
  physical report/photo ride the ordinary admin@ user-mailbox path, not the
  locked group-thread-reply shape, per the standing 2026-08-05 Captain
  exception (Graph 403s conversationThread:reply under app-only auth). This
  fix applies to `uploadSesGraphAttachment`, which is the code both that
  fallback and AJS/Western use, so it also incidentally improves those
  routes' CPU headroom — but does not touch the exception flag itself.
