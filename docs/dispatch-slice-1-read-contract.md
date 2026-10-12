# Dispatch slice 1: read contract

What `ops-api` gives the Ops screen's Dispatch tab for slice 1 (the Dispatch view
of any job: job list, job header, Scope and notes). Three additions, all
read-only. Code: `supabase/functions/ops-api/dispatch_job_list.ts` (rules) and
`pipeline` / `jobNotes` in `supabase/functions/ops-api/index.ts` (reads). Tests:
`dispatch_job_list_test.ts`.

Nothing here changes an existing caller: `pipeline` without `dispatch=1` runs the
same selects and returns the same rows and keys as before, and `job_detail` is
untouched.

## 1. The job list: `GET ops-api?action=pipeline&dispatch=1`

Optional `search`, `type`, `status`, as on the plain read. The response keeps the
plain shape: `{ columns: { <status>: [row, ...] }, total }`, plus `degraded` and
`enrichment_errors` when an enrichment read failed.

With `dispatch=1`:

| What | Behaviour |
|---|---|
| Row set | Accepted or later only: every pipeline status except `draft` and `quoted`. The `draft` and `quoted` columns come back empty. An explicit `status` still wins. |
| Make-safe | `type = 'makesafe'` rows are left out unless `search` has text (or `type` is given). So `total` with no `search` and no `type` is the "All jobs" count. |
| Completeness | Paged past the 1,000-row ceiling. Every job in the set is returned; nothing is capped. |
| Order | `updated_at` newest first inside each column, as before. Sort the merged list on `updated_at` for one newest-first list. |
| Search | Same four fields as before (client name, suburb, address, job number), case-insensitive contains. |
| New row field `description` | `string` or `null`. The one-line job description (below). |
| New row field `value_inc_gst` | `boolean`. `true` only when `value` is `pricing_json.totalIncGST`. `false` when `value` is the unlabelled fallback `pricing_json.total`, and when there is no price (`value` is `0`). Print "inc GST" only on `true`. |

Every other row key is exactly what the plain read returns (`value`,
`next_scheduled_date`, `last_scheduled_date`, `council_status`, `council_step`,
`council_required`, `po_count`, ...).

A read with no matching job returns the short empty shape
`{ columns: { draft, quoted, accepted, approvals, processing, in_progress, complete, invoiced }, total: 0 }`
(existing behaviour): treat a missing column as empty.

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

### Type buttons

Filter on `row.type` in the browser. Do not use `type=repair` for the Repair
button: that parameter is the Repairs board's set (jobs whose insurance family is
repair, whatever their type) and returns rows in that board's shape.

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

- Rows: every `job_events` row with `event_type = 'note'` for the job, newest
  first, paged, never capped. `total` is the row count.
- `text`: `detail_json.text`, falling back to the keys older writers used
  (`note`, `note_text`, `message`).
- `author`: the linked user's name, else a name the writer stored, else `null`.
  Most notes have no user: 238 of the 374 notes on non-make-safe jobs today were
  written with a server key. Show no author for `null`; `from_ops: true` marks a
  note written from the office side.
- `visibility`: `internal_only`, `client_visible`, or `null` on old rows.
- Errors: `400` when `jobId` is missing or is neither a job id nor a job number;
  `404` when the job does not exist. An empty `notes` list always means the job
  was found and has no notes.

Saving a note is the existing `add_note` (unchanged). Send what the Jobs tab
sends: `{ job_id, text, visibility: 'internal_only', from_ops: true }`. A note
saved with no `visibility` defaults to `client_visible` and is copied into the
customer's CRM contact notes. The response is
`{ note: <the raw job_events row>, visibility, ghl_synced, ... }`: the raw row,
not the shape above, so either read `note.id`, `note.created_at` and
`note.detail_json.text` from it or call `job_notes` again.

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
- `pipeline` also drops any job whose client name contains the word "test", as it
  always has. None of the 309 listed jobs is one today; 2 make-safe jobs are, so a
  search will not find those two.
- Cost: the scope projection adds about 0.4 s to the list read. Draft and quoted
  jobs hold the heaviest scope blobs (4.9 s to project all 1,400 rows), which is
  why this read stops at accepted work.
