# Dispatch slice 1: read contract

What `ops-api` gives the Ops screen's Dispatch tab for slice 1 (the Dispatch view
of any job: job list, job header, Scope and notes). Three additions, all
read-only. Code: `supabase/functions/ops-api/dispatch_job_list.ts` (rules) and
`pipeline` / `jobNotes` in `supabase/functions/ops-api/index.ts` (reads). Tests:
`dispatch_job_list_test.ts`.

Slice 3 adds the stage rail fields to the same list read and two writes:
`docs/dispatch-slice-3-contract.md`.

`pipeline` without `dispatch=1` runs the same selects as before. A populated
board already returns the nineteen column keys below. An empty plain pipeline
returns those same nineteen keys. `job_detail` changes only by the two document
dates in section 4.

## 1. The job list: `GET ops-api?action=pipeline&dispatch=1`

Optional `search`, `type`, `status`, as on the plain read. The response keeps the
plain shape: `{ columns: { <status>: [row, ...] }, total }`, plus `degraded` and
`enrichment_errors` when an enrichment read failed.

With `dispatch=1`:

| What | Behaviour |
|---|---|
| Row set | Accepted or later only: every pipeline status except `draft` and `quoted`. The `draft` and `quoted` columns come back empty. An explicit `status` still wins. |
| Make-safe | Make-safe jobs are left out unless `search` has text (or `type` is given). A repair-family job typed `makesafe` is a repair, not a make-safe, and is listed (below). So `total` with no `search` and no `type` is the "All jobs" count. |
| Completeness | Paged past the 1,000-row ceiling. Every job in the set is returned; nothing is capped. |
| Order | `updated_at` newest first inside each column, as before. Sort the merged list on `updated_at` for one newest-first list. |
| Search | Same four fields as before (client name, suburb, address, job number), case-insensitive contains. |
| New row field `description` | `string` or `null`. The one-line job description (below). |
| New row field `value_inc_gst` | `boolean`. `true` only when `value` is `pricing_json.totalIncGST`. `false` when `value` is the unlabelled fallback `pricing_json.total`, and when there is no price (`value` is `0`). Print "inc GST" only on `true`. |
| New row field `work_type` | `string`. The work type the type buttons filter on: `repair` for a repair-family job whatever its `type`, else the row's `type`. |

Every other row key is exactly what the plain read returns (`value`,
`next_scheduled_date`, `last_scheduled_date`, `council_status`, `council_step`,
`council_required`, `po_count`, ...).

A read with no matching job returns `{ columns, total: 0 }` with the same
nineteen keys as a populated board: `draft`, `quoted`, `partially_accepted`,
`accepted`, `awaiting_deposit`, `approvals`, `order_materials`, `processing`,
`awaiting_supplier`, `order_confirmed`, `schedule_install`, `scheduled`,
`in_progress`, `rectification`, `complete`, `final_payment`, `invoiced`,
`get_review`, `archived`. An older caller may still treat a missing column as
empty.

### The description line

Built from five projected scope paths, never the whole `scope_json`. The fields
are the ones the screen's `renderScopeSummary` reads.

| Scope shape | Line | Example |
|---|---|---|
| Fence tool (`scope_json.job.runs` or `.gates` has entries) | `<total metres>m <colour> <profile> fence`, then `, N runs` when more than one run, then `, N gate(s)` when there are gates | `43.4m Monument Trimclad fence, 2 runs` |
| Patio tool (`scope_json.config` has a size or a roof style) | `<length>m × <projection>m <roof style> patio`, then `, <roofing>` | `7.7m × 4.2m skillion patio, solarspan75` |
| Anything else | `null` | |

- Shape decides, not job type, so a repair job scoped in the fence tool gets a
  fence line (4 of the 14 repair jobs today).
- A missing part is left out; no placeholder is ever printed. Metres are summed
  over the runs and shown to one decimal at most. Underscores in tool codes become
  spaces (`reverse_skillion` reads `reverse skillion`).
- `null` means the scope has nothing these rules can describe. Omit the line.

Coverage on 12 Oct 2026: 245 of the 309 listed jobs get a line (fencing 180 of
206, patio 61 of 86, repair 4 of 14, insurance 0 of 3). Not covered, by choice, because the
screen's own summary does not read them either: 5 patio jobs saved in the
multi-patio shape (`scope_json.patios`) and 1 fencing job saved as free text
(`scope_json.job_description`).

### Type buttons and repair

Filter on `row.work_type` in the browser, never `row.type`.

A make-safe card reclassified as a repair keeps `type = 'makesafe'` for good
(`update_makesafe_job_family` never retypes a card). Repair wins: a job is a
repair when its `type` is `repair`, or `metadata.ses_family` or
`metadata.makesafe_job_family` is `repair`. That is the rule the Trade app's
`_jobVertical` and the Repairs board apply. Such a job is on the default list and
under the Repair button with `work_type: "repair"`; its `type` comes back as
stored. A true make-safe has `work_type: "makesafe"` and comes back only for a
search.

A job whose only repair mark is `makesafe_job_details.report_type = 'repair'` is
not recognised here, as on the calendar's `job_family`; a read-only production
check on 16 Sep 2026 found none.

Do not use `type=repair` for the Repair button: that parameter is the Repairs
board's set and returns rows in that board's shape.

## 2. The GST flag

`value_inc_gst` above. The figure itself is unchanged: `value` is
`pricing_json.totalIncGST`, else `pricing_json.total`, else `0`.

## 3. Every note on a job: `GET ops-api?action=job_notes&jobId=<uuid or job number>`

`job_detail.events` is the newest 50 events of every kind, so older notes on a
busy job are not in it. This read returns all of them and writes nothing (it has
none of `job_detail`'s annotation side effect, so it is safe to call again after a
save or on Retry).

```json
{
  "job_id": "<uuid>",
  "total": 4,
  "notes": [
    {
      "id": "<job_events.id>",
      "text": "the note",
      "author": "Name or null",
      "user_id": "<uuid or null>",
      "created_at": "2026-10-12T05:16:00+00:00",
      "visibility": "internal_only",
      "from_ops": true
    }
  ]
}
```

- Rows: every `job_events` row for the job whose `event_type` is `note`,
  `note_added` or `site_note` (`JOB_NOTE_EVENT_TYPES`), newest first, paged,
  never capped, less the system marker rows. `total` is the count of notes
  returned. All three come back in the one shape above; nothing tells them
  apart. `note_added` is an older Ops screen writer: 13 live rows, all from 2
  and 3 Sep 2026, 11 of them on listed jobs. `site_note` has no live row.
- The list's count: `total` equals that job's `comms_notes_count` on the list
  read, on every listed job. Both use the same event types and the same marker
  rule (`isPersonWrittenJobNote`), so a card's note count and the notes under
  it cannot differ. The first version of this read returned `note` rows only,
  and 11 of the 315 listed jobs read one fewer note than their count (measured
  12 Oct 2026).
- System markers: the pack-sent (`MAKESAFE_PACK_SENT ...`) and agent-reply
  (`MAKESAFE_AGENT_REPLY ...`) rows are machine breadcrumbs stored as notes. They
  are left out by `noteIsSystemMarker`, tested on `detail_json.text`, else
  `detail_json.note`. The portal-ready marker
  (`MAKESAFE_PACK_PORTAL_READY ...`) is not in that rule: it still counts and
  still shows.
- `text`: `detail_json.text`, else `detail_json.note`, else
  `detail_json.message`. Read on production, 12 Oct 2026, 1,243 `note` rows:
  `text` on 1,228, `note` on 6, `message` on 9 with no other text key. The 13
  `note_added` rows: `text` and `note` holding the same words on 12, `note`
  alone on 1.
- `author`: the linked user's name, else `null`. Most notes have no user: 238 of
  the 374 notes on non-make-safe jobs today were written with a server key. Show
  no author for `null`; `from_ops: true` marks a note written from the office
  side.
- `visibility`: `internal_only`, `client_visible`, or `null` on old rows.
- `jobId`: a job id, or a job number. A value that is not a job id is read as a
  job number and matched whole against the stored number, so every number the
  list returns works whatever its shape (`SW1346`, `SWF-PDF-BUCKET` and
  `SWG-20260713-BE` are live). Never a prefix, a part or a pattern. Stored
  numbers are upper case; a lower-case number is accepted.
- Errors: `400` when `jobId` is missing; `404` when no job has that id or that
  job number. An empty `notes` list always means the job was found and has no
  notes.

Saving a note is the existing `add_note` (unchanged). Send what the Jobs tab
sends: `{ job_id, text, visibility: 'internal_only', from_ops: true }`. A note
saved with no `visibility` defaults to `client_visible` and is copied into the
customer's CRM contact notes. The response is
`{ note: <the raw job_events row>, visibility, ghl_synced, ... }`: the raw row,
not the shape above, so either read `note.id`, `note.created_at` and
`note.detail_json.text` from it or call `job_notes` again.

## 4. Document dates on `job_detail` (slice 2)

Each `job_detail.documents` row also carries `sent_at` and `superseded_at`
straight from `job_documents` (null when unset), added last so every earlier key
keeps its order. Slice 2's quote chips read them to show a sent date or
"Superseded"; without them a superseded quote read "Sent". Projection:
`projectJobDetailDocument`; test: `job_detail_document_dates_test.ts`.

## Who can call these

Staff sessions only (admin, owner, ops manager), and the server key. `pipeline`
was already off the trade list; `job_notes` is on none of the trade, routine or
agent-read lists, so each refuses it. No price field reaches a trade session.

## Facts the screen should know

Measured read-only on production, 12 Oct 2026.

- The plain `pipeline` read (no `dispatch=1`) is cut at 1,000 rows. It matches
  1,400 jobs today, so the 400 least recently updated are missing from it,
  including 26 accepted-or-later jobs that are not make-safe. That is existing
  behaviour and is not changed here; `dispatch=1` is the complete read.
- "All jobs" through `pipeline` is 309 jobs, not the 488 a direct count of the
  jobs table gives. `pipeline` has always left out jobs with no job number (179
  accepted-or-later: 148 fencing, 31 patio) and old-system records (3). By type:
  fencing 206, patio 86, repair 14, insurance 3, decking 0. Make-safe: 538.
  Dispatch shows the same job set as the other Ops tabs, so the unnumbered jobs
  stay off it; they are being handled separately as a records problem.
- Those counts are by stored `type` and were taken before repair-family jobs
  typed `makesafe` joined the list. How many of the 538 are repair-family was not
  measured: "All jobs" and the Repair count rise by that number, and the
  description coverage above (245 of 309) does not include them.
- `pipeline` also drops any job whose client name contains the word "test", as it
  always has. None of the 309 listed jobs is one today; 2 make-safe jobs are, so a
  search will not find those two.
- Cost: the scope projection adds about 0.4 s to the list read. Draft and quoted
  jobs hold the heaviest scope blobs (4.9 s to project all 1,400 rows), which is
  why this read stops at accepted work. The two `metadata` family paths were
  added after that measurement and are not in it.
