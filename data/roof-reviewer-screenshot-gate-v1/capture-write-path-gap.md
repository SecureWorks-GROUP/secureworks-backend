# The compliant capture script cannot store its own capture

**Date:** 2026-08-06
**Status:** finding. No production write was made. The retake was captured and NOT recorded.
**Companion to:** `report.md` in this directory (the census, the producer split, and the
corrected hash-direction finding). Read that first; this document explains why the retake
it recommended could not be completed, and why that is a larger problem than the retake.

---

## The finding in one line

The sanctioned capture script produces a correct portal capture and has **no way to store
it**; the only code that can write to the capture store is the observer that produces the
non-compliant synthetic card.

---

## READ FIRST: a capture document with no extractable text is NOT empty

**Attached portal captures are image-only PDFs — a wrapped full-page screenshot with no
text layer. Text extraction on a complete, perfectly good capture returns roughly three
characters.**

This is the single most dangerous thing in this campaign for a future author, because the
obvious completeness check is the wrong one:

```python
# WRONG - condemns every valid portal capture ever attached
if len(pdf_text(doc)) < 100:
    refuse("capture document is blank")
```

Mindarie's attached capture yields 3 characters of extracted text. Rendered, it is the
**full two-page Prime roof report**: page 1 with the Job Details panel, the form-locked
banner, the `Roof Report` heading, the `21 of 23` progress bar and the answered Inspection /
Property / Report Details; page 2 with Recommended and Required Maintenance, Other Comments,
and the complete Photo Schedule of roughly 24 site photographs. **Neither page is blank.**

The premise that this card carried a "blank page-2 attachment" was measured and is **false**.
It came from exactly the reading above, and this investigation nearly repeated it.

**Any completeness check on a capture document must RENDER it, or test for embedded image
streams and page count — never for extractable text.** A text-based gate will refuse valid
evidence, on every roof card, silently, and it will look like a data problem rather than a
check problem.

---

## 1. The retake capture works, and proves the compliant path is sound

Run 2026-08-06 against Mindarie `SWMS-261081`
(`967cdb6e-e57e-46ea-89d8-14e8afbc2ada`) using the skill's own
`capture_portal_evidence.py` against that card's share link.

Classifier result:

```
[DONE] - Roof Report (form locked/submitted (form-locked banner), 21 of 23 answered)
```

The produced PNG is a **genuine full page render of the filled-out Prime roof report**:

| Property | Retake capture | The synthetic observation card |
|---|---|---|
| Dimensions | 1280 x 1800 (full page) | viewport only |
| Extracted page text | 6,561 characters | a few hundred |
| `Prime portal observation` marker | **absent** | present |
| `Job details panel redacted before capture` | **absent** | present |
| `Observed state` / `SecureWorks card` labels | **absent** | present |
| Form lock banner from the real page | **present** | absent |
| Readable form fields | **yes** | none by construction |

Visual confirmation: the image shows the Prime lock banner, the `Roof Report` heading, the
`21 of 23` progress bar, and readable answered fields across Inspection Details, Property
Details and Report Details, under builder job number `MLB-27100`.

**This settles the question the retake was authorised to answer.** The skill's script
genuinely screenshots the page; it does not produce another observation card. The
compliant path works. Nothing about the script needs fixing.

It also confirms the mechanism recorded in `report.md` section 3: the deviation lives in
`scripts/ses-f7-prime-portal-observer.ts`, whose `installSafeCaptureFrame` covers the
viewport before every screenshot, and not in the Python script the producer contract is
named after.

### What client detail a genuine capture carries

Stated plainly, because an image nobody has described should not be attached anywhere. A
real page capture of a Prime roof report carries:

- the **policyholder's full name** and the **full residential site address**, in the Job
  Details panel;
- the **builder job number** and the share link's expiry date;
- the **inspecting tradesperson's name**, and the inspection date, time and weather;
- **property and roof detail** — construction type, storeys, condition, roof type and pitch,
  services present;
- **free-text damage narrative** describing the loss and the remedial work; and
- on the full two-page render, a **Photo Schedule of site photographs**, including exterior
  and street-facing views of the property.

This is inherent to a real page capture and is exactly what the observer's frame was
stripping. It is not a defect in the capture; it is a property of the evidence the Captain's
ruling requires.

**Disclosure assessment for the builder pack:** none of it is new to the builder. The share
link is created by the builder (the page footer reads "This link has been created by ML
Builders"), the form was completed on the builder's own portal, and the builder is the party
holding the claim. Attaching the capture to that builder's own pack therefore discloses
nothing they do not already hold. The exposure question is not the builder — it is anywhere
else such a capture is stored or displayed.

**Note:** `job-documents` is a **public** storage bucket, so an attached capture is
retrievable by URL without authentication. The two Mindarie documents and the White Gum
Valley document were all fetched over plain HTTPS with no credential during this
investigation. That is a pre-existing property of the document pipeline and not a
consequence of any action taken here, but it is worth a separate look given what these
documents contain.

No capture image is committed to this repository, and none is reproduced in this document.

---

## 2. Append-only is verified on live production, not just read in the migrations

Verified read-only against production before any write was considered, because Mindarie's
existing capture is cited evidence in `report.md` and losing it would remove the ability to
re-check any of that finding.

**The commit RPC cannot destroy a row.** The live definition of
`commit_makesafe_portal_capture_v1`, pulled with `pg_get_functiondef`, contains **zero
`UPDATE` statements and zero `DELETE` statements**. It is a pure `INSERT`, with:

- version assignment `SELECT COALESCE(MAX(makesafe_fact_version), 0) + 1` scoped to
  `(job_id, attendance_cycle_id, role)` — append-only versioning;
- `RAISE EXCEPTION ... ERRCODE = '23505'` when an existing row shares the idempotency key
  but carries a different content hash — a fail-closed refusal, never an overwrite;
- `RETURN to_jsonb(v_existing)` on an identical replay — idempotent no-op.

**The live indexes agree.** From `pg_indexes` on `makesafe_portal_capture_revisions`:

| Index | Definition | Consequence |
|---|---|---|
| `..._job_id_attendance_cycle_id_ro_key` | unique on `(job_id, attendance_cycle_id, role, makesafe_fact_version)` | multiple revisions per card/cycle/role coexist **by design** — the version is IN the key |
| `uq_makesafe_portal_capture_idempotency` | unique on `(job_id, attendance_cycle_id, role, capture_idempotency_key)` | a fresh idempotency key inserts alongside rather than replacing |
| `uq_makesafe_trade_portal_confirmation` | unique on `(job_id, attendance_cycle_id, role)` **WHERE `capture_producer = 'trade_portal_confirmation/v1'`** | the one-row-per-card rule is scoped to the trade producer only; it does not constrain capture rows |

**Storage cannot overwrite either.** `ses_portal_capture_evidence.ts` uploads with
`upsert: false` to a content-addressed path derived from the screenshot hash, so different
bytes take a different path. A colliding path is verified by
`assertExistingScreenshotMatches`, not replaced.

A retake is therefore safe: it would add revision 2 beside revision 1. The practical
constraint is that it must carry a **fresh `capture_idempotency_key`**, or it refuses with
`23505` — a refusal, not a loss.

### Mindarie's original row is untouched

Confirmed after the capture run:

```sql
select count(*) as rows, max(makesafe_fact_version) as max_version
  from makesafe_portal_capture_revisions
 where job_id = '967cdb6e-e57e-46ea-89d8-14e8afbc2ada';
-- rows: 1, max_version: 1, captured_at unchanged (2026-08-06 00:31:58.239+00)

select count(*) from makesafe_portal_capture_revisions;
-- 6
```

One row, version 1, original timestamp, and the estate still totals **six** revisions. The
capture run wrote nothing: `capture_portal_evidence.py` shells headless Chrome and writes
local files, and makes no network write of any kind.

---

## 3. The missing piece is solely the wiring between the script and the RPC

Every part exists and is correct. Nothing connects them.

| Component | Produces | Writes to the capture store? |
|---|---|---|
| `capture_portal_evidence.py` (wiki skill) | a correct real-page PNG + `portal_evidence.json` | **no** — local files only, zero network writes |
| `drain_portal_recheck.py` (wiki skill) | portal-done stamps | **no** — posts `mark_makesafe_portal_report_done`, which carries no screenshot and creates no capture revision |
| `record_ses_portal_capture_evidence` (ops-api) | the capture revision row + stored object | **yes — this is the only writer** |
| `commit_makesafe_portal_capture_v1` (RPC) | the append-only insert | yes, behind the action |
| `scripts/ses-f7-prime-portal-observer.ts` | a synthetic observation card | **yes — and it is the ONLY caller of that action** |

A repository-wide search for `record_ses_portal_capture_evidence` returns the ops-api
handler, its two test files, the action manifest, documentation, and exactly one
non-test caller: `scripts/ses-f7-prime-portal-observer.ts`. A search across the wiki
returns nothing at all.

**So the gap is not in the script and not in the store. It is the absent wiring between
them.** The script cannot record; the recorder produces the wrong image.

---

## 4. Why this is very likely the CAUSE of the deviation, not a gap beside it

The two facts fit one causal story, and it is the story a future worker will re-enact.

Someone needed captures recorded. The compliant path could not record. So a path that
*could* write got built — and the thing that got built produces synthetic cards. The
deviation is not a careless substitution; it is the predictable result of being the only
route to a required outcome.

Two pieces of evidence support the reading:

1. **The five compliant rows were produced manually.** `report.md` section 3 shows five
   rows written by `maverick` and `ses-run-skill-batch1-v1` carrying genuine page renders.
   No automation exists that could have written them, so each was a hand-assembled POST of
   the script's output.
2. **That manual route explains the hash defect.** Those same five rows carry
   `source_content_hash` equal to `screenshot_content_hash` — and per `report.md`'s
   corrected section 2, `screenshot_content_hash` is server-computed and sound while
   `source_content_hash` is caller-supplied and **shape-validated only**. A hand-assembled
   POST is exactly how the PNG digest ends up in the one field the server cannot check.
   The corrupted coordinate and the missing wiring are the same root cause.

So the write-path gap has already produced two distinct defects: a producer that strips the
evidence, and a corrupted provenance coordinate on every capture made the manual way.

### The warning this document exists to leave

**A future worker asked to record a portal capture will find the same dead end.** They will
find a script that captures correctly but stores nothing, and one tool that can write. The
two available shortcuts are the two that already caused the defects above: run the observer
(and get a synthetic card), or hand-assemble a POST (and corrupt `source_content_hash`).

Neither is the fix. **The fix is the wiring.** Until it exists, treat a request to "record a
capture" as blocked work, not as a task to improvise.

---

## 5. Scope: this gates the evidence STORE, not the Captain's document tab

**These are two different destinations and they must not be conflated.**

| Destination | Table | Sanctioned writer | State |
|---|---|---|---|
| Captain's document tab / roof pack | `job_documents` | `attach_makesafe_document.py` → ops-api `attach_makesafe_document` | **works today** |
| Internal capture-evidence store | `makesafe_portal_capture_revisions` | `record_ses_portal_capture_evidence` | **no sanctioned writer** (section 3) |

The gap in section 3 blocks the **evidence store only**. The Captain's requirement that a
roof pack carry the portal capture as a first-class document is satisfiable today, and on
the two cards in question it is already satisfied — see section 5a.

An earlier version of this document claimed the Captain's contract "cannot be satisfied at
all" while the write path is missing. **That is withdrawn.** It conflated the two
destinations above. The evidence-store gap remains real, remains unfixed, and remains
mandatory work — it is what the intake/board/U4 consumers read, and it is where the
`source_content_hash` defect lives — but it is not what gates the document tab.

### 5a. Both cards already carry a complete capture document

Measured 2026-08-06 from `job_documents` and the stored objects:

| Card | `roof_report` documents | Content |
|---|---|---|
| SWMS-261114 White Gum Valley | 1 (`Prime Portal Roof Report - RR-26836 - 51 Samson St White Gum Valley.pdf`, v1, 460,362 bytes) | complete capture |
| SWMS-261081 Mindarie | **2** (see below) | complete capture, **duplicated** |

Mindarie's two rows are **byte-identical** — both objects are 534,248 bytes and both hash to
`sha256 1711bd6421d7a240822d874969540aff6ca781be942a9ce70f652b1f36f3e8a2`:

| Document id | File name | Version | Created |
|---|---|---|---|
| `eea6fe2e-3e53-442b-8c1e-605d9c0e27cd` | `Prime Portal Roof Report - MLB-27100 - 1 Keys Cl Mindarie.pdf` | 2 | 2026-08-06 08:03:15Z |
| `ba373f52-15fe-4359-98f6-1b2fb001b3c1` | `Prime Portal Roof Report - MLB-27100 - 1 Keys Cl Mindarie - RETAKE.pdf` | 1 | 2026-08-06 08:18:13Z |

**The attached document is NOT blank, and page 2 is not blank.** It is an image-only PDF —
a wrapped full-page screenshot with no text layer — so text extraction returns 3 characters
and a text-based check reads it as empty. Rendered, it is the genuine Prime roof report:
page 1 carries the Job Details panel, the form-locked banner, the `Roof Report` heading, the
`21 of 23` progress bar, and the answered Inspection / Property / Report Details; page 2
carries Recommended and Required Maintenance, Other Comments, and the full Photo Schedule of
roughly 24 site photographs.

Anyone auditing these documents must **render** them. Judging one by extracted text will
report a complete capture as blank.

### 5b. Idempotency confirmed, and confirmed already broken on Mindarie

`attach_makesafe_document` is idempotent on the exact triple
`(job_id, type, file_name)` — a re-run with the same three updates the row and bumps
`version` instead of inserting. Mindarie's canonical row is at version 2, which is that
mechanism working.

**The idempotency key is the file name, so changing the file name defeats it.** Appending
` - RETAKE` to the name produced a second row at 08:18 holding byte-identical content. It
replaced nothing. That is why Mindarie's pack currently shows two capture documents rather
than one, and it is the same class of mistake as the rest of this document: a sanctioned
tool used slightly off-contract produces a silent duplicate rather than an error.

The remedy is removal of the duplicate row `ba373f52-15fe-4359-98f6-1b2fb001b3c1`, which is
a destructive write and is not performed here.

---

## 6. The retake capture is preserved

The capture produced on 2026-08-06 is held so the page does not need re-capturing when a
write path exists.

| Property | Value |
|---|---|
| Card | Mindarie `SWMS-261081` / `967cdb6e-e57e-46ea-89d8-14e8afbc2ada` |
| Attendance cycle | `90bbf1ee-70ac-4cb0-ae7e-1356423ad5db` |
| Role | `roof_report` |
| Builder reference | `MLB-27100` |
| PNG sha256 | `2b9a6f8ec53f09f5d800c28a857d97d8bb8d5dca001b85711740c604597a706d` |
| PNG size / dimensions | 156,738 bytes / 1280 x 1800 |
| PDF sha256 (text source) | `4903f60c272426ee9eae747576959071bb7af9ab03037d17252caf2fcf59b0e1` |
| Classifier verdict | `done` — `form locked/submitted (form-locked banner), 21 of 23 answered` |

**The image is deliberately NOT in this repository** — it carries client PII (see section 1).
It is held outside the repo in the capturing session's scratchpad. **That location is
session-scoped and will not survive the worktree**, so if the bytes themselves must be kept,
they need moving to durable storage by someone with somewhere appropriate to put them. The
hashes above make any later re-capture checkable against this one, and re-running
`capture_portal_evidence.py` on the same link is cheap if the bytes are lost.

Note the share link carries an expiry (`This link is available until 24th Aug, 2026`), so
the page is not indefinitely re-capturable.

**This capture is redundant to, and less complete than, the document already attached to
Mindarie** (section 5a). The attached PDF is two pages and includes the full Photo Schedule;
this capture is a single 1280x1800 viewport render that reaches only partway down page one
and carries no photo schedule. It is retained solely as an independently produced control
proving the compliant script works (section 1) — **it must not be attached over the existing
document**, which would replace better evidence with worse.

---

## 7. What was NOT done, and why

- **No manual POST to `record_ses_portal_capture_evidence`.** It is the only route from the
  captured bytes to the store, and it is precisely the improvisation this document argues
  against. Doing it would have added a sixth hand-assembled row to a card that is cited
  evidence in a published finding, most likely reproducing the `source_content_hash` defect
  in the process.
- **No use of the F7 observer.** It can write, but it cannot produce a compliant image; its
  frame verification is fail-closed, so it emits the synthetic card or nothing.
- **No change to `capture_portal_evidence.py`.** It is correct as written.
- **White Gum Valley `SWMS-261114` was not touched.** Its capture stands.
- **No `attach_makesafe_document` run on Mindarie.** An attach was authorised, but on
  measuring the card first (section 5a) the document tab already held a complete capture and
  a byte-identical duplicate of it. Attaching the preserved viewport capture would have
  either overwritten a two-page document containing the photo schedule with a partial
  one-page render, or — under any other file name — created a **third** row. The authorised
  outcome was one capture document on the card; running the attach would have moved the card
  further from it, so it was not run.
- **No removal of the duplicate row.** Deleting `ba373f52-15fe-4359-98f6-1b2fb001b3c1` is the
  correct remedy and is a destructive write outside this task's authority.

## 8. Open items for the Captain

Recorded, not acted on. Each is his call, not an implementer's.

### 8a. Mindarie carries a duplicate capture document — deletion is destructive

`SWMS-261081` has two byte-identical `roof_report` documents (section 5a):

| Disposition | Document id | File name |
|---|---|---|
| **Keep** — canonical, idempotency-key row | `eea6fe2e-3e53-442b-8c1e-605d9c0e27cd` | `Prime Portal Roof Report - MLB-27100 - 1 Keys Cl Mindarie.pdf` |
| **Remove** — duplicate created by a renamed re-attach | `ba373f52-15fe-4359-98f6-1b2fb001b3c1` | `Prime Portal Roof Report - MLB-27100 - 1 Keys Cl Mindarie - RETAKE.pdf` |

The content is not at risk either way — both rows point at the same bytes
(`sha256 1711bd64…`) and the canonical row is the one a re-attach under the correct file name
would continue to update. **Deleting a document is a destructive write and was not
performed.** It needs the Captain's ruling on which row is authoritative and on whether the
stored object is removed with the row or left in place.

Note that the duplicate is not harmful in itself — it is the same evidence twice. The reason
to resolve it is that a pack showing two capture documents invites exactly the "which one is
real" question this campaign has been answering all day.

### 8b. `job-documents` is a public bucket

Every attached capture is retrievable by URL with no authentication; all three documents
referenced in this document were fetched that way during the investigation. Given that a
genuine capture carries the policyholder's name, full site address and site photographs
(section 1), this deserves its own look. It is pre-existing and was not caused by anything
here.

### 8c. The wiki skill reference describes the capture path without the write-path caveat

`secureworks-makesafe-reporting/references/portal-proof-and-roof-reports.md` (wiki
repository, not this one) documents `capture_portal_evidence.py` as the capture path and
its screenshot as the proof. That is correct as far as it goes, but it does not record
that the script's output has no sanctioned route into `makesafe_portal_capture_revisions`
(section 3). A reader following it therefore reaches the dead end described there and is
tempted by one of the two shortcuts that already caused defects (section 4): run the
observer and get a synthetic card, or hand-assemble a POST and corrupt
`source_content_hash`. The remedy is either a caveat in that reference or the option-1
wiring in section 9 — both are work in the wiki repository and neither can be done from
here.

---

## 9. Options for the write path, for whoever owns the decision

Recorded as options, not as a recommendation to act on without a ruling.

1. **Teach the skill to record.** Add the `record_ses_portal_capture_evidence` POST to the
   wiki skill beside `capture_portal_evidence.py`, computing `source_content_hash` from the
   extracted page text rather than repeating the image digest. Durable, wiki-side, and fixes
   both defects at once.
2. **Fix the observer to record the real page.** It already has correct write plumbing,
   correct hash handling and idempotency; the only defect is the `installSafeCaptureFrame`
   step. Smallest diff, but it is a code change in this repository and it inherits the
   observer's own privacy design decision, which is the subject of an open Captain question.
3. **Authorise a single audited manual POST per card.** Unblocks specific cards now, but
   re-enacts the path that produced the `source_content_hash` defect, and does not scale to
   the 57 uncaptured roof cards.
