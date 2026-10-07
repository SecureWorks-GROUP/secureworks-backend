# Proposal: let the ledger close on decisions (after the shadow proof)

Status: a proposal, nothing here is live. Do it only after the reader's shadow
proof has passed on today's rules, as one release of the store and the reader
together: the reader mirrors the store's closing rules exactly, and a rule one
side has and the other lacks counts against the shadow gate.

## What happens today

The ledger store lets an app event (a `job_events` row) close an item only
through `context_ledger_job_event_closes(event_type, closes_on)`
(20261006013000):

| closes_on | app events that close it |
|---|---|
| `quote_sent` | `quote_sent` |
| `invoice_issued` | `invoice.emailed`, `acceptance_invoice_sent`, `payment_link_sent` |
| `payment` | `payment_received`, `payment_recorded` |
| `visit` | `clock.clock_on`, `clock.clock_off`, `makesafe_report_submitted`, `roof_report_submitted` |
| `work_done` | `clock.clock_off`, `makesafe_report_submitted` |

There is no row for `record` and nothing for a decline. So two kinds of
reading are refused with `closing_not_issued`, and each refusal counts against
the gate's refusal rate:

1. An item that closes on a record (`closes_on = 'record'`), for example "the
   customer will decide on quote Q-1234", when the customer accepts or
   declines it on the quote page (`quote_accepted`, `quote_declined`), or a
   variation item when the variation is approved or rejected
   (`variation_approved`, `variation_rejected`).
2. Any item declined on a decision record, for example an offer we made (an
   agreement with modality `offered`) that the customer declined on the quote
   page (`quote_declined`).

The quote document cannot stand in for the decision: a document closes at its
sending (`job_documents.sent_at`), never at its acceptance or decline.

Live counts (read-only, 6 Oct 2026): `quote_accepted` 113 rows on 97 jobs,
`quote_declined` 10 rows on 7 jobs, `variation_approved` 1, `variation_rejected`
1. Every quote decision row names its `document_id`. The reader is off, so no
ledger write and no refusal has been counted yet.

## Store change (one migration, guarded on the live md5 of each body)

1. `context_ledger_job_event_closes(p_event_type, p_closes_on)`: add

   ```sql
   WHEN 'record' THEN p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['quote_accepted', 'quote_declined',
    'variation_approved', 'variation_rejected'])
   ```

2. A new helper, `context_ledger_job_event_declines(p_event_type text) RETURNS boolean`,
   `LANGUAGE sql IMMUTABLE`, no `SET` (inlinable), service role only:

   ```sql
   SELECT coalesce(p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['quote_declined', 'variation_rejected']), false)
   ```

3. `context_ledger_check_item`, in the `closed_by` loop, replace

   ```sql
   IF chk #>> '{cite,table}' = 'job_events' AND NOT public.context_ledger_job_event_closes(chk ->> 'kind', p_item ->> 'closes_on') THEN
   ```

   with

   ```sql
   IF chk #>> '{cite,table}' = 'job_events' AND NOT (public.context_ledger_job_event_closes(chk ->> 'kind', p_item ->> 'closes_on')
      OR (v_status = 'declined' AND public.context_ledger_job_event_declines(chk ->> 'kind'))) THEN
    v_close_at := NULL;
   END IF;
   ```

4. `context_ledger_write`, in the transition evidence loop, the same with the
   transition's status:

   ```sql
   IF chk #>> '{cite,table}' = 'job_events' AND NOT (public.context_ledger_job_event_closes(chk ->> 'kind', li.closes_on)
      OR (tr ->> 'to_status' = 'declined' AND public.context_ledger_job_event_declines(chk ->> 'kind'))) THEN
    chk := chk || jsonb_build_object('close_at', NULL::timestamptz);
   END IF;
   ```

5. Record layer: add the four event types to the app events on
   `context_job_record_timeline` (the `ae0` list since 20261006033000), state =
   the event type, with words naming the quote number (from the document the
   row names) or the variation number (`job_variations` by the row's
   `variation_id`), for example "App recorded quote Q-1234 v2 declined by the
   customer". Without a timeline line the reader cannot cite the event.

Nothing else moves: a decision row naming a quote the customer accepted or
declined was received, so the store's not-received rule for documents never
holds it back.

## Reader change (Jarvis, `src/automation/luna-job-ledger.ts`, same release)

1. `JOB_EVENT_CLOSES.record = new Set(["quote_accepted", "quote_declined", "variation_approved", "variation_rejected"])`.
2. `JOB_EVENT_DECLINES = new Set(["quote_declined", "variation_rejected"])`, and
   `jobEventClosesAt(events, closesOn, status)` also accepts those types when
   `status === "declined"`. Pass the status through `countsAt`, `closingAt` and
   `checkClosingCites`: the item's own status for a new item, `to_status` for a
   transition.
3. `jobEventOf(entry)`: read the line's `state` when the line cites
   `job_events` (since 20261006033000 the timeline gives the event type there,
   or `not_delivered` for an event naming a document nobody received), and fall
   back to the words only for a line without a state. This one is worth doing
   now: until then the reader reads the new app-event lines as closing nothing,
   which is safe (it never proposes a close the store refuses) but leaves
   closes on the table.
4. `NUMBERED_ABOUT` and `recordObjects`: add variation numbers
   (`variation:<n>`, "Variation 3" in the words), so a variation decision closes
   an item about that variation on its own.
5. Prompt: say that `record` closes on a decision record (a quote accepted or
   declined, a variation approved or rejected).

## Before switching it on

- The shadow proof passes on today's rules first.
- Measure, read-only, what the change would release: in
  `context_ledger_writes.result`, refusals with code `closing_not_issued` on a
  `job_events` citation, by the item's `closes_on` and the event's type.
- Release the store and the reader together and run the reader's mirror tests
  (`luna-job-ledger.test.ts`) against the new lists.

## Also noticed (no change proposed here)

`payment_link_sent` closes `invoice_issued` even when the app recorded the text
as not sent (`sms_sent` is false on all 895 live rows, and one job has 401 rows
from an automated loop in March and April). The timeline now says "the text was
not recorded as sent" and folds a day's repeats into one line. Whether such a
row should count as the invoice reaching the customer is a separate decision.
