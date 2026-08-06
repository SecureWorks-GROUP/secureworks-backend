# Roof reviewer screenshot gate: portal capture evidence census

**Date:** 2026-08-06
**Status:** investigation only. No production writes, no display built, no capture committed.
**Scope:** read-only reads against production (Management API `read_only: true`, and one
`GET ops-api?action=query_ses_review_cockpit` per card) plus in-repo and secureworks-ux source reads.

The display work this investigation was opened for was **not** built here, for two reasons
established below: the reviewer UI is in another repository (section 5), and the product
question the evidence surfaced is a Captain decision, not an implementation choice
(section 6).

Every claim below is written so someone else can re-run it. The queries are exact and
read-only. Where a claim could not be established, section 7 says so and does not round it.

---

## 1. Only six capture revisions exist, against 63 roof-family cards

`makesafe_portal_capture_revisions` holds **six** rows in total. Not 24.

```sql
select count(*)                        as revisions,
       count(distinct job_id)          as distinct_jobs,
       count(screenshot_object_key)    as with_screenshot
  from makesafe_portal_capture_revisions;
```

Result, 2026-08-06:

| revisions | distinct_jobs | with_screenshot |
|---|---|---|
| 6 | 6 | 6 |

The roof-family population is **63** cards:

```sql
select count(*) as roof_family_cards
  from jobs
 where metadata->>'makesafe_job_family' = 'roof_report';
```

Result: `63`. (The predicate was reached by widening to
`metadata->>'makesafe_job_family' ilike '%roof%' or metadata->>'insurance_job_type' ilike '%roof%'`
and grouping; every one of the 63 matches on the single exact value `roof_report`, and the
`insurance_job_type` half contributes nothing. The simpler predicate above is therefore
equivalent here. It is a metadata predicate, not the canonical `ses_family` derivation —
see the caveat in section 7.)

So capture coverage of the roof-family population is **6 of 63**, and five of those six
were written before 2026-08-04.

### "24 of 24" is a field count, not a capture tally

The figure "24 of 24" that circulated as a capture count is the **answered-field counter
inside White Gum Valley's own capture signal**:

```sql
select j.job_number, r.signal
  from makesafe_portal_capture_revisions r
  join jobs j on j.id = r.job_id
 where j.job_number = 'SWMS-261114';
```

Result:

```
SWMS-261114: form locked/submitted (form-locked banner), 24 of 24 answered
```

That is one card reporting that 24 of its own 24 portal form fields were answered. It is
not a statement about how many cards were captured. No query returns 24 captures, because
six exist.

---

## 2. Five rows carry a screenshot hash equal to their source hash

```sql
select j.job_number,
       r.captured_by,
       r.screenshot_size_bytes,
       (r.screenshot_content_hash = r.source_content_hash) as hash_collision,
       r.status,
       r.captured_at::date as captured_on
  from makesafe_portal_capture_revisions r
  join jobs j on j.id = r.job_id
 order by hash_collision desc, r.captured_at;
```

Result, 2026-08-06:

| job_number | captured_by | screenshot_size_bytes | hash_collision | status | captured_on |
|---|---|---|---|---|---|
| SWMS-261019 | `ses-run-skill-batch1-v1` | 248,339 | **true** | verified | 2026-08-02 |
| SWMS-26934 | `ses-run-skill-batch1-v1` | 262,197 | **true** | verified | 2026-08-02 |
| SWMS-261079 | `maverick` | 271,856 | **true** | verified | 2026-08-03 |
| **SWMS-261114** | `maverick` | 280,403 | **true** | verified | 2026-08-03 |
| SWMS-261116 | `maverick` | 301,547 | **true** | verified | 2026-08-03 |
| **SWMS-261081** | `ses-prime-portal-observer/2026-08-02.4` | 65,985 | **false** | verified | 2026-08-06 |

### Why those two hashes cannot legitimately be equal

They fingerprint different artifacts, and the contract says so:

- `source_content_hash` fingerprints the **normalised page text** the classifier read. In
  the observer that is `sha256Text(normalizePrimeSourceText(read.body_text))`
  (`scripts/ses-f7-prime-portal-observer.ts`, `sourceContentHash`).
- `screenshot_content_hash` fingerprints the **PNG bytes**. The contract requires the
  `sha256:<64hex>` shape and the writer refuses `missing_screenshot_content_hash` without
  it; `rawSesPortalCaptureSha256` in
  `supabase/functions/ops-api/ses_portal_capture_contract.ts` digests the image bytes.

A SHA-256 of a UTF-8 text string and a SHA-256 of a PNG byte stream collide only if the
two inputs are byte-identical, which they are not and cannot be — one is page text, the
other begins with the PNG signature `89 50 4E 47`. Equality therefore does not indicate a
collision. One of the two columns is carrying the other's digest.

The one row where the two differ is SWMS-261081: screenshot `sha256:900796d7…` against
source `sha256:da47eedd…`. That is the shape a correctly computed pair takes.

### CORRECTION (2026-08-06): the direction of the copy was stated backwards

**This correction was already relayed upward in its original, wrong form. Read it in
full — the earlier version leads to the OPPOSITE conclusion about which coordinate to
trust.**

**The claim that was wrong.** This section originally said the screenshot hash "was not
derived from the image at all", that the source hash had been copied into the screenshot
field, and drew three consequences from that: that `status: verified` does not attest the
image bytes, that the storage path carries the source-text digest, and that a downstream
re-hash of the PNG would mismatch. **All four statements are withdrawn. They are wrong,
and each is wrong in the opposite direction.**

**The corrected facts.** The sanctioned writer
(`supabase/functions/ops-api/ses_portal_capture_evidence.ts`) settles the direction:

- `screenshot_content_hash` is **server-computed from the uploaded PNG bytes**. Line 313
  validates the bytes are PNG (`isSesPortalCapturePng`); line 319 computes
  `screenshotContentHash = await rawSesPortalCaptureSha256(screenshotBytes)`; lines
  320–326 refuse a caller whose claimed hash disagrees with a 409
  `ses_portal_capture_hash_mismatch`. The value persisted at line 351 is the server's own
  computation, never the caller's string. **That column is SOUND and genuinely fingerprints
  the stored image.**
- `source_content_hash` is **caller-supplied and unchecked**. It is only shape-validated
  (`isSesSha256`, ~line 237), because the server cannot recompute it — it fingerprints
  normalised page text the server never sees. **That is the corrupted coordinate.** On
  those five rows the caller put the PNG digest where the page-text digest belonged.

**The confirming consumer, and the empirical discriminator.**
`supabase/functions/ops-api/ses_assembler_input_adapter.ts` lines 2704–2725 downloads the
stored object and refuses via `invalidPersistedPortalCapture` —
`screenshot failed its byte-hash check` — when
`rawSesPortalCaptureSha256(bytes) !== row.screenshot_content_hash`. Had the screenshot
column been a copied source-text digest, all five of those cards would already fail docket
assembly on that check. They do not. A downstream re-hash of the PNG **matches**.

It follows that `status: verified` **does** attest the image bytes on those rows, and that
the storage paths are correct: `captureScreenshotStoragePath` derives the path from
`screenshot_content_hash`, which is the genuine PNG digest.

### The defect is still real, and it is on the source side

On those five rows **the page-text fingerprint is lost.** `source_content_hash` does not
fingerprint the page text on them — it repeats the image digest — so the textual basis of
the "done" verdict cannot be re-verified against the page the classifier read. That is
narrower than originally written and different in kind, but it is a genuine integrity
defect and is not softened here.

Do not use `source_content_hash` on those rows as a page-text coordinate without
re-checking it per row. `screenshot_content_hash` needs no such caveat.

**This correction touches the hash question only.** Section 3's producer finding stands
unchanged: SWMS-261081 Mindarie is still the deviation (a synthetic observation card from
`ses-prime-portal-observer/2026-08-02.4`), SWMS-261114 White Gum Valley is still the
skill-compliant real page capture, and the retake instruction is still inverted. Which
card was captured by which producer, and which shape is compliant, does not depend on
either hash column.

The two findings also remain independent in the other direction: the source-hash defect
holds on all five rows regardless of what any of those images shows, and per section 3
all five are genuine page captures.

---

## 3. Which producer captured each of the two cards in question

`capture_producer` is `capture_portal_evidence.py/v1` on all six rows: that column names
the approved producer **contract**, not the implementation. The implementation that did the
looking is recorded separately in `captured_by`, which the contract documents as free-form
attribution (`ses_portal_capture_contract.ts`, comment on
`SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS`). `captured_by` is what separates the six rows into
two groups.

**SWMS-261114 White Gum Valley — `maverick`. A real page capture. Skill-compliant.**

**SWMS-261081 Mindarie — `ses-prime-portal-observer/2026-08-02.4`. A synthetic observation
card. A deviation from the skill.**

Four independent lines of evidence agree:

1. **The `captured_by` value on Mindarie is a literal in this repository.**
   `scripts/ses-f7-prime-portal-observer.ts:49` declares
   `const OBSERVER_VERSION = "ses-prime-portal-observer/2026-08-02.4"`, exported as
   `SES_PORTAL_CAPTURE_OBSERVER_AGENT` (line 63) and written to `captured_by` (line 284).
   It matches Mindarie's row exactly and appears on no other row.

2. **That producer is structurally incapable of capturing the page.** In
   `runObservation`, `installSafeCaptureFrame` (line 1585) runs immediately before
   `captureViewportPng` (line 1592). The frame is
   `position:fixed; inset:0; z-index:2147483647; background:rgb(255,255,255)`, it blanks
   every `prime-object-summary` panel, and it verifies full coverage by hit-testing five
   viewport points plus asserting the background colour. If verification fails it throws
   `privacy frame verification failed`; the surrounding catch reclassifies the verdict and
   writes **no** screenshot. So a screenshot from this producer exists only if the opaque
   frame was proven to cover the viewport — a page capture cannot come out of this path.

3. **Signal vocabulary splits along the same line.** The skill reference
   (`harness/ops/skills/secureworks-makesafe-reporting/references/portal-proof-and-roof-reports.md`,
   section 1) documents `capture_portal_evidence.py` emitting signals of the form
   `form NOT locked, 14 of 22 answered`. The five page-render rows use exactly that
   vocabulary (`form locked/submitted (form-locked banner), N of M answered`). Mindarie
   reads `submitted/locked observed, 21 of 23 fields answered`, which is the wording built
   by `buildSafeEvidenceFrameHtml` in the observer, not by the Python script.

4. **Size profile.** The five page renders are 248,339–301,547 bytes. Mindarie is 65,985,
   in the same band as the observer's own committed dry-run frames
   (`docs/evidence/ses-f7-prime-portal-capture-dry-run-2026-08-02/screenshots/`, 55,552–67,185
   bytes) — output of the same code path.

The synthetic shape was confirmed visually from the dry-run capture for SWMS-261081 already
committed in this repository at the path above. It renders a white card headed "Prime portal
observation" with a field counter, the SecureWorks card number, builder reference, observed
state, observed time, and the line "Job details panel redacted before capture." No portal
form fields appear in it.

### Correction to this investigation's earlier reading

An earlier note from this investigation described the observer as the audited, compliant
producer and treated the five page renders as the likely privacy hazard. **That reading was
wrong and is withdrawn.** It was derived from in-repo source alone, where the observer's
fail-closed privacy frame reads like policy, without the skill reference — which states the
opposite: `capture_portal_evidence.py` "screenshots the page (the proof)", and the proof
tile is built from that screenshot. The measurements in sections 1–3 are unchanged; only the
judgement of which shape is correct was inverted.

The consequence runs the other way too. A genuine page capture may contain client details
precisely because it is a picture of the real page. Under the skill that is the proof, not a
fault. Where such an image may be viewed is an access-control question, not a reason to
retake a compliant capture.

---

## 4. What the cockpit payload does and does not carry

Live read, per card:

```
GET {SW_SUPABASE_URL}/functions/v1/ops-api?action=query_ses_review_cockpit&job_id=<id>
x-api-key: {SW_API_KEY}
```

(Job ids: SWMS-261081 = `967cdb6e-e57e-46ea-89d8-14e8afbc2ada`,
SWMS-261114 = `088dee02-91d0-4539-8c9c-6014c9ebf06e`.)

**The share link is already in the payload.** `sections.family_evidence.roof_report_link`
returns `state: "ready"` with `evidence: "url:https://primeeco.tech/share/<id>"` on both
cards. Surfacing it needs no API change.

**The screenshot is not in the payload in any form.**
`sections.family_evidence.roof_report_capture` returns `state: "ready"` with the symbolic
string `evidence: "file:EVIDENCE/portal_roof_report.json"` — a marker, not a reference to
`screenshot_object_key`, not a signed URL, and not bytes. Nothing in the payload names the
stored object.

No ops-api action serves capture bytes or a signed URL for one: the only capture-related
actions are `record_ses_portal_capture_evidence` (a write),
`mark_makesafe_portal_report_done`, `makesafe_portal_recheck_queue` and
`makesafe_portal_recheck_enqueue`. A reviewer display of the image therefore requires a
**backend change as well as a view change**; the share link half is view-only.

The typed cockpit input carries the verdict but no image reference either:
`SesCleanInput.portal_capture_status` in `supabase/functions/ops-api/ses_review_cockpit.ts`
is `"done" | "not_done" | "unreachable" | "not_applicable"`.

---

## 5. Where the reviewer UI lives

**Not in this repository.** There is no reviewer UI here; no file in this repo references
`query_ses_review_cockpit` outside `supabase/functions/ops-api/` (the handler at
`index.ts:6684` and three test files).

The Docs Ready review cockpit is:

- **Repository:** `SecureWorks-GROUP/secureworks-ux`
- **File:** `modules/ops-makesafe-reporting-cockpit.js` (2,518 lines on `origin/main`)
- **Current level:** `26bdbdf` — *fix(ops): source Docs Ready cockpit hold and stamp copy
  from backend fields* (**PR #247**)

That module renders neither `roof_report_link` nor `roof_report_capture`; it contains no
reference to either key, nor to `primeeco`, in any revision.

### This repository's `dashboard` gitlink is nine cockpit PRs behind, and diverged

`dashboard/` is a submodule of `secureworks-ux` (`.gitmodules`). The gitlink here is
`ef8e01732684eeeebdb6f23ff7d7b4e6667e0cfc` — *fix(ops,trade): hide branding/tracker URLs as
builder portals (F5)*, 2026-08-02.

```
git -C dashboard rev-list --count ef8e0173..origin/main -- modules/ops-makesafe-reporting-cockpit.js
```

Result: **9**. Those nine are PRs #232, #233, #236, #239, #241, #242, #243, #246, #247 —
including all three rebuilds of the review pane. (An earlier note in this investigation said
"four"; that was an eyeball count and is corrected to the measured nine.)

The pin is also **not an ancestor** of `secureworks-ux` `origin/main`:
`git merge-base --is-ancestor ef8e0173 origin/main` fails, the merge base is `ae29676`
(*fix(ops): show honest make-safe card status*, #219, 2026-07-27), and five commits reachable
from the pin are absent from `origin/main`. So the gitlink is on a divergent line, not merely
behind. Anyone reading the cockpit through this repo's submodule is reading neither current
nor ancestral ux code.

### On the share link being a regression

No commit in `secureworks-ux` history renders a roof report share link on the review
cockpit; a pickaxe over `modules/` and `ops.html` for `roof_report_link`,
`portal_report_url` and `report_share_url` returns nothing. Share links **are** rendered on
the board card face and job detail, added by ux PR #227 (2026-08-02), which describes moving
"the assessment triad and roof report links" onto the card row.

The skill reference does specify an "always-present **Open live ↗** link" on each portal
proof tile — so an always-present link is expected behaviour of the skill's own proof tile
render. Whether the Captain is recalling that render, or the ux card face from #227, is not
resolved here. What is established is that the ops.html review cockpit has never shown it.

---

## 6. The product conflict (Captain decision, not an implementation choice)

The requirement is a screenshot in which the form fields can be read. The two capture shapes
in production answer it differently:

- A **page capture** (five rows, the skill's `capture_portal_evidence.py`) shows the form,
  and may therefore show whatever client detail the page shows.
- The **observation card** (one row, the F7 observer) shows no form fields by construction,
  and states on its face that the job details panel was redacted.

Showing the observation card larger cannot satisfy the requirement, because the fields are
not in the image. That is a conflict between two standing positions, and choosing between
them is the Captain's call. Nothing in this investigation resolved it, and no capture was
retaken, displayed or committed pending that decision.

---

## 7. What could NOT be established

Stated precisely, because the distinction matters in both directions.

- **No capture bytes were read.** The available credentials are `SW_SUPABASE_URL`,
  `SW_API_KEY` and `SUPABASE_ACCESS_TOKEN`. The Management API path used here is SQL-only;
  it reads `storage.objects` metadata (name, size, mimetype, created_at) but cannot return
  object contents. No service-role key or signed URL was available, and none was sought.

- **Therefore the redaction status of the five page-render images is unestablished — in
  both directions.** It was **not** shown that they contain unredacted client detail, and it
  was **not** shown that they do not. What is established is their producer, their size
  profile, and their signal vocabulary. Any statement that those images are unredacted, or
  that they are safe, goes beyond this evidence.

- The one image whose content **was** seen is the committed dry-run frame for SWMS-261081 in
  this repository — the observer's own output, not the production object. The production
  object for SWMS-261081 (65,985 bytes) was not read either; its shape is inferred from
  producer identity and size band, which is strong but is inference.

- **`status: verified` was not traced to its writer.** What that status asserted at write
  time was not established. It is established that the byte digest it sits beside is sound
  (section 2 correction), and that the page-text digest on those five rows is not.

- **The 63-card roof population is a metadata predicate**
  (`jobs.metadata->>'makesafe_job_family' = 'roof_report'`), not the canonical `ses_family`
  derivation used by the board. It is the population reachable from a read-only SQL session.
  A census against canonical family may differ and was not run.

- **Coverage was measured, causation was not.** That 57 of 63 roof-family cards have no
  capture row is a count. Why — never attempted, attempted and unreachable, or not required
  for that card — was not investigated.

---

## Reproducing this

Read-only throughout. Management API queries take `read_only: true`; the cockpit read is a
GET with the action in the query string.

```bash
set -a; . ~/.config/secureworks/env; set +a

# Management API, read-only SQL
curl -sS -X POST "https://api.supabase.com/v1/projects/kevgrhcjxspbxgovpmfl/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg s "<query from section 1 or 2>" '{query:$s, read_only:true}')"

# Cockpit payload, per card
curl -sS "$SW_SUPABASE_URL/functions/v1/ops-api?action=query_ses_review_cockpit&job_id=<job_id>" \
  -H "x-api-key: $SW_API_KEY" | jq '.sections.family_evidence'
```

secureworks-ux facts are reproduced from the `dashboard` submodule after
`git submodule update --init dashboard` and `git -C dashboard fetch origin main`.
