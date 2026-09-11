# Sales prerequisites 1 and 2

The current webhook delegates forward stage changes to ops-api, whose accepted
status path already writes `accepted_at`. It formerly returned success even when
that request failed; this change checks the HTTP and application response.

Migration `20260911175000_sales_acceptance_stamps.sql` fills null acceptance dates
from the earliest witnessed `job_events` acceptance/status-to-accepted event
with explicit `detail_json.new_status = accepted`. Partial-contact acceptances
and historical quote events without that full-acceptance status are excluded. If
no such event exists, only an acceptance-chain job may use its previous
`updated_at`, labelled `BACKFILLED` in `accepted_at_evidence`. A quoted job or a
rejected/backward stage conflict is not an acceptance. Existing stamps are never
rewritten; status and deposit fields are untouched.

The new trigger stamps writes with status `accepted` or an explicit non-null
`accepted_at` at the database boundary, covering the
webhook/ops-api path and protecting first stamps against repeated status updates.
It records `OBSERVED_WRITE`; that means the database observed the write, not that
we independently verified client acceptance. `OBSERVED_EVENT` is a historical
source event; `BACKFILLED` is an estimate. Readers must not mix estimates into
observed weekly wins. The exact job reader returns the provenance column. Existing
stamps without provenance remain unknown rather than being relabelled.

Rollback removes the automatic trigger/function but preserves timestamps and
provenance already acquired. It deliberately does not erase business history.
Deposit PR823/825 behaviour is unchanged.

## Complete sent-document pagination

The existing exact-job `list_job_documents` mode remains unchanged. Authorised
JWT operators (`admin`, `owner`, or `ops_manager`) or the verified server
connection may opt into:

```
action=list_job_documents
scope=all_jobs
type=quote
job_type=fencing
sent_at_from=2026-09-06T16:00:00Z
sent_at_to=2026-09-13T16:00:00Z
page_size=100
```

That is the Perth week starting Monday 7 September: lower bound inclusive,
upper bound exclusive. Follow `pagination.next_cursor` until `has_more=false`.
Pages default to 25 rows and allow at most 100; rows use ascending document-ID
keyset pagination. There is no total-row cap. The cursor is bound to the caller organisation and
all filters. Page row counts are not population totals, and the API explicitly
states its mutable-snapshot and missing-sent-date coverage limits. A failed read
returns an error, never an empty/zero population.

The join is restricted by the verified organisation and exact job type. The
projection contains document identities, revision/supersession metadata and dates.
It does not read `scope_json`, whole pricing JSON or whole document snapshots.
Scalar totals retain their source path: snapshot pricing if that specific path
exists; current job pricing is labelled current and is not historical sent-quote
value. Missing values stay null. No synthetic amounts or value fallbacks are
created. Quote revisions remain separate source records; this reader does not
invent a revision-deduplicated sales count.

The public API key and trade users cannot use this mode. A supplied org_id or a
cursor from another organisation/filter is refused. No provider, send, booking,
status or financial write is performed by the document reader.

## Validation boundary

Fixtures cover 237 eligible documents across three pages, sent-time boundaries,
other organisations and job types, invalid/replayed cursors, failed reads, and
preservation of the existing exact-job action. Registered PostgreSQL contracts
cover observed/estimated acceptance dates, preservation of true stamps and
statuses/deposits, new/repeated acceptance writes and rollback. Production
catalog/readback remains a separate release check; no live deployment is claimed.
