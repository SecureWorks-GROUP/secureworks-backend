# The saved job story and the job overview read

Migration `20261009100000_context_job_story_text.sql` (rollback in
`supabase/rollbacks/`, contract case under
`supabase/tests/migration-contracts/20261009100000_context_job_story_text/`)
and the ops-api module `supabase/functions/ops-api/job_overview_read.ts`.

The job page Overview (ops dashboard, the owner's approved design of
9 Oct 2026) leads with a short written story of the job. The story card
(`context_job_story`, job-story-v1) holds every fact; this slice keeps the
WRITTEN story beside it, says whether it is still current, and queues rewrites.
The Luna context worker (secureworks-jarvis, its story writer phase) writes the
words from the card and the live AI notes only, never from call transcripts,
checks every amount and date against them, and saves through these functions.

Everything is behind `feature_flags.context_job_story_text_v1`, created OFF.
Turning it on needs the owner's word. While it is off: no request is queued,
nothing is claimed, the model call admission answers `story_off`, and the job
page shows no saved story (`job_overview` still serves every other part).

## Numbers

`context_job_story_text_policy()` holds every number; change them only by
migration: `calls_per_day` 80 (story model calls a Perth day),
`lease_minutes` 15, `min_rewrite_minutes` 10, `quiet_minutes` 15,
`enqueue_per_call` 5, `max_attempts` 3, `retry_minutes` [30, 120],
`digest` story-digest-v1, `writer` luna-story-writer.

## Freshness: story-digest-v1

`context_job_story_card_hash(card)` is the md5 of the card's stable facts. A
story is `fresh` while its `card_hash` equals the hash of the card now, else
`stale`. The digest reads: job id and status; `now` phase, phase_since,
whose_move, monitored, not_followed_up_since; each loop's key, status, owner,
counterparty, due and blocks; money (job value, not yet invoiced, per party
invoiced, paid, credited, owing, drafts, draft_total, and each invoice's
number, status, total, paid, owing, due_date, fully_paid_on and overdue;
placed_on_no_job; supplier bills); timeline rows (instant in UTC, kind,
source_table, source_id, state, amount); checks (rule and cited rows);
agreements (key, status, modality); events (key); phase notes counted per
phase; who (role, name); which rows are the last exchange; meta.ledger.status.

It never reads what moves with the clock or is prose: `as_of`,
`meta.built_at`, `age_days`, `days_overdue`, every line, what and why, a loop's
cites, handling, not_known, changes. A literal "md5 of the card" would read
every story with an open loop or an overdue invoice stale every Perth day
(day counts sit in the lines). Numbers are rounded to 2 places and arrays
sorted in C order, so the hash survives a JSON round trip (0.00 read back as 0)
and any server collation. Changing the digest makes every saved story stale
once; a change to how the card is built does too (record timeline T1, for
example), and that is expected: the page words stale softly.

## The queue

`context_job_story_requests`: at most one open request a job.

- `context_job_story_request(job, by, reason)` -> `{outcome queued |
  already_open | recent | off | not_live, request_id, requested_at, reason}`.
  `asked` is staff (ops-api `request_job_story`); `job_changed` only for a
  live, monitored job. `recent`: the current story is under 10 minutes old and
  still fresh (the card is built once, only then). Raises
  `context_job_story_request_invalid` (22023) for bad arguments or an unknown
  job.
- `context_job_story_enqueue_changed(limit)` -> `{outcome off | queued,
  queued, job_ids, candidates}`: the one rule for "something new happened",
  run by the worker each tick. A current story older than 10 minutes, no open
  request, a live job, and a cheap signal newer than the story covers: the
  job's status; its AI reading (another generation, or the same one read
  further); a customer invoice or quote row touched since and its record
  signature (`context_job_story_record_sig`: money state and quote times, so a
  Xero sync that rewrites a row unchanged wakes nothing) changed; or, with no
  AI reading, a message row recorded since and quiet for 15 minutes. Then the
  lead rule (`context_lead_monitored_jobs`) for the survivors only. At most 5 a
  call, oldest checked first.
- `context_job_story_claim(limit)` -> `{outcome off | budget | idle | claimed,
  reason, resets_at, closed, requests [{request_id, job_id, lease_token,
  lease_expires_at, reason, attempts}]}`. Asked first, FOR UPDATE SKIP LOCKED,
  15-minute lease; a lease that ran out with no answer counts an attempt; at 3
  counted attempts the request closes failed `max_attempts`. The claim keeps
  `claimed_state` (job status, record signature, the AI reading) on the
  request.
- `context_job_story_writer_input(job)` -> `{version story-writer-input-v1,
  job_id, as_of, job_status, card, card_hash, current {text_id, card_hash,
  written_at, checked_at} | null, notes (context_job_story_ledger),
  transcript_row_ids}` from one snapshot. A `job_changed` request whose
  `card_hash` equals `current.card_hash` is finished `unchanged` with no model
  call.
- `context_job_story_text_save(request, lease, job, sections, card_hash,
  evidence_until, generation_id, model, prompt_sha256, checks)` -> `{outcome
  saved, text_id, superseded_id} | {outcome lease_lost} | {outcome refused,
  reason, problem}`. One transaction: the old current story superseded, the new
  one current (`checked_at` = the claim's `picked_at`), the request closed
  written.
- `context_job_story_request_finish(request, lease, outcome, error, retry_at)`:
  `unchanged` (the story now covers the claim), `failed` (closed with an error
  code), `released` (a retry: a stop such as `story_budget`, `story_off`,
  `rate_limited`, `auth_required` or `worker_stopping` is not counted and waits
  5 minutes; any other error counts and waits 30, then 120 minutes; a given
  `retry_at` wins, clamped to 2 days).
- `context_job_story_budget()` -> `{on, lane_on, calls_left, reason,
  resets_at, run_date, story_calls_today, calls_per_day}`, as the admission
  answers.

## The model call budget

A story call reserves through `reserve_context_model_call('story', NULL,
NULL)`: no run, the extraction lane, only while the switch is on (`story_off`),
at most `calls_per_day` story calls a Perth day, and never inside the ledger's
live reserve lines (`context_ledger_settings`: model_call_cap less
live_reserve_calls, before noon morning_cap less live_reserve_calls_morning),
else `story_budget` with reason `story_calls_per_day`, `live_reserve` or
`live_reserve_morning`. Story calls count in the owner's 1,000-call day and in
the heartbeat. Every other phase is unchanged; the admission's md5 moved from
`0d741538d7874ce63d48e54d8645d18c` to `25a5b5f208af726d47e952f98cecef56`, and
the call budget and ledger store contracts accept both.

## The stories

`context_job_story_texts`: one current a job. `sections` holds exactly
`headline` (at most 200 characters), `the_job`, `how_we_got_here`,
`where_it_is_at` and `watch_out` (each at most 700), plain trimmed strings with
no em or en dash (`context_job_story_sections_problem`). `checks` is the
writer's own fact check, codes and counts only
(`context_job_story_checks_problem`); its `inputs` object feeds the page's
"written from" line.

`context_job_story_text_get(job, card, check)` -> `{version
job-story-text-v1, job_id, status fresh | stale | none | unchecked, card_hash,
text {id, written_at, checked_at, evidence_until, generation_id, card_hash,
model, sections, inputs} | null, writer {on, open_request | null,
last_failure {error, at} | null}}`. `card` is the card the caller just read
(ops-api passes it, so a page view builds the card once); `check` false
answers unchecked without building one.

Both tables are RLS on with no policy, the service role reads, and every write
goes through the functions above. Stories hold customer details: they reach a
person only through the staff door.

## ops-api

`GET ops-api?action=job_overview&jobId=<uuid>` (or `job_number`): staff only
(the default front door; a trade, a lead installer or another org is
refused), GET only, nothing written. Answers `job-overview-v1`:

- `job`: the job header (client, site, CRM ids, `current_price_inc_gst`, the
  job description with dashes as commas).
- `story`: the card, with call transcript words taken out (`loops[].why`, a
  last exchange that is a call transcript). The saved story's freshness is
  checked against the card as read.
- `notes`: `{status, generation_id, evidence_until, reader, unread_rows,
  items}`; each item `{id (item_key), item_type, status, from/to role and name,
  what, due_date, blocks, modality, phase, opened_at, as_at (Perth day),
  closed_at, cites_ok, owner (us | customer | third_party | unknown),
  owner_name, group (blocking | waiting | good_to_know), shown, receipt {table,
  id, excerpt}}`. The excerpt is at most 160 characters and never from a call
  transcript (null when the cited row is one, or its kind could not be read).
- `messages`: the job conversation (getJobConversation), every call one row
  (`kind call`, `call_seconds`, `call_status`, `has_transcript`, words such as
  "Call, 2 min 5 s" or "Missed call", never what was said), texts with no words
  dropped, `who` (the customer's name, `Us`, `Supplier`, ...), `side` (them |
  us | internal), `at` and `at_perth`; the newest 80, oldest first, at most 400
  characters.
- `files`: `quotes` (job_quote_values is the only value; `view_count` per
  document from quote_viewed; a superseded quote reads `replaced`),
  `invoices` (customer invoices on this job only, never by client name; a
  draft reads "draft, cannot be paid" and never counts as invoiced; a deleted or
  voided one counts for nothing), `invoice_totals`, `attachments` (email
  attachments once each, uploads), `media` / `media_count` (photos),
  `scope {exists}`.
- `story_text`: `context_job_story_text_get`, or null.
- `sources`: per part `{ok, state, count, code}`; a failed part is null with
  a code, never empty; `story_text` reads `not_deployed` until the migration is
  applied.

`POST ops-api?action=request_job_story` `{jobId}`: staff only, POST only. The
asker is the verified caller (`user:<id>`, or a server caller's actor), never a
body field. The SQL outcome passes through (`queued`, `already_open`, `recent`,
`off`).
