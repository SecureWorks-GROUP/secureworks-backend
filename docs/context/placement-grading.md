# Placement grading: is each item on the right job?

Done definition row 3 (5 Oct 2026) is green only when at least 95% of
customer-facing items and 95% of Xero and quote items are on the RIGHT job.
The scorecard can count how many items are on A job; only a grader can say
whether it is the right one. This is how a sample is drawn, graded by a fresh
grader, stored and read. Database objects: migration
`20261007070000_context_placement_grades.sql`.

## The bar and where the scorecard reads it

Row 3 has two populations, each graded on its own sample:

| population | what it is (the scorecard's lane) |
|---|---|
| `customer_facing` | texts, calls, call transcripts, emails in and out whose party roles say customer |
| `xero_and_quotes` | Xero invoices and payments, and quotes, whoever they are with |

`public.context_placement_grades_newest(as_of, population)` returns one row:
the newest sample of that population (latest draw instant) stored by `as_of`,
with

- `drawn` (how many items the draw holds), `graded` and `missing` (drawn and
  not graded);
- `right_count`, `wrong_count`, `unsure_count`;
- `right_share` = right / drawn (a drawn item with no grade is never right,
  and an unsure verdict is never right);
- `weighted_right_share`: each stratum's right / drawn, weighted by its size at
  the draw;
- `placed_share`: placed items / every item of the population in the sample's
  window at the draw, the scorecard lane's own placed share;
- `right_of_all` = least(`right_share`, `weighted_right_share`) x
  `placed_share`: the estimated share of ALL the population's items in the
  window that sat on the right job. This is row 3's wording: an item on no job,
  or on the wrong one, is not on the right job.

Every share is rounded down to 4 decimals. The bar is the scorecard policy's,
not this function's. Read each population as

```
green  when graded = drawn AND drawn >= 100 AND right_of_all >= 0.95
red    "no graded sample" when samples = 0
```

Grading precision among placed items alone is not the bar: with 95% placed and
95% of those right, only about 90.25% of all items are on the right job. On 7
Oct 2026 (window to 04:00Z) the placed shares were 76.2% (4,673 of 6,132
customer-facing items) and 92.6% (1,204 of 1,300 Xero and quote items), so
`right_of_all` cannot reach 0.95 for either until placement does.

## 1. Draw (the orchestrator)

Read only. One call draws 120 placed items of a population from the 30 days to
the instant given, stratified by how they were placed, and the draw is saved
exactly as it came out:

```sql
BEGIN READ ONLY;
SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pos)
FROM public.context_placement_sample('2026-10-07 04:00:00+00', 120, NULL, 30, 'customer_facing') s;
ROLLBACK;
```

and the same with `'xero_and_quotes'`. Save each output as that sample's draw
file. Every row carries `sample_id` (`placement-cf-...` or `placement-xq-...`),
`population`, `as_of`, `pos`, `event_id`, `placed_job_id`, `stratum`,
`stratum_rows`, `stratum_drawn`, `drawn`, `population_rows`, `population_all`,
`draw_digest`, `lane` and `captured_at`: ids, codes and counts only. The
digest covers the whole draw, so the load refuses a draw saved short, mixed
with another or edited. The same `sample_id` draws the same rows from the same
data, but placements change over time, so keep the saved file: it, not a later
re-draw, is what gets graded and loaded. Every stratum (luna, single_open,
single_line, thread, content_ref, party, reference, payload_job, custody,
no_words, other) gets up to 5 items first, then the rest is shared in
proportion. On 7 Oct 2026 04:00Z (read-only emulation) that is, for
customer-facing items, single_open 77 of 3,926, custody 11 of 326, luna 8 of
163, thread 8 of 139, single_line 6 of 82, payload_job 5 of 26, other 5 of 11;
for Xero and quote items, custody 80 of 856, no_words 30 of 291, other 10 of 57.

Give the grader only `pos`, `event_id` and `placed_job_id`. Never the stratum:
the grader judges the job, not the rule that chose it.

## 2. Grade (a fresh grader)

A fresh grader is an agent or person with no part in building or running the
placement system. Read only, always: every query inside `BEGIN READ ONLY; ...
ROLLBACK;`. Never message anyone, never change a row.

For each item, read its card:

```sql
BEGIN READ ONLY;
SELECT public.context_placement_grade_card('<event_id>', '<placed_job_id>');
ROLLBACK;
```

The card gives the item (when it was sent, lane, direction, sender and
recipient roles, the sender field, subject, the first 2,000 characters), the
customer (`contact_id`; `contact_basis` says whether it is the row's own
contact, the GHL contact its payload carries, or the one contact its own email
or phone names), the job it was placed on, the customer's jobs as they stood
at the message time (`live_at_message`, `finished_before_message`,
`created_after_message`, site address, type), the jobs its words name, the
record a Xero or quote item stands for (`record`: an invoice's own number,
reference, contact name, type, status, total, date and first line words; a
quote's version, recipient, option and the job it was built on), and up to
three messages before and after it from the same customer or thread. It says
nothing about how the item was placed.

Judge the job as it stood when the item was sent, never by its status today: a
job archived since was still the right job if the item was about it then.

| Verdict | When | reason | right_job_id |
|---|---|---|---|
| `right` | The placed job is the job the item is about. | empty | empty |
| `wrong` | Another of our jobs is the one it is about (it names that job, its site or its quote; it is about a different service or site the customer had a job for). | `other_job` | that job's id |
| `wrong` | It is about no job of ours: a wrong number, marketing, a supplier talking about stock, a new enquiry no job card exists for, or the placed job is a holding job (`placed.holding_job` true). | `no_job` | empty |
| `unsure` | Two or more of the customer's jobs fit equally and nothing in the words, the record, the neighbours or the records decides. | `several_jobs` | empty |
| `unsure` | The item has too little in it and the records add nothing. | `not_enough_evidence` | empty |

Rules of thumb:

- One live job at the time and nothing pointing elsewhere: a short "Yes
  please" or "Thanks" on that job is `right`. Shortness alone is never
  `unsure`.
- A job number, quote number, invoice number or site address in the words or
  the record decides it.
- An invoice or payment is right when its reference, contact, site or lines
  are this job's and its amount fits this job's quote or work; it is wrong when
  they are another job's, or another customer's.
- A quote item is right when the quote was built on the placed job (the card's
  `record.built_on_job_number`) and is about its site.
- Our own outbound message is judged the same way: is it about the placed job?
- A crew or staff text about a job belongs on that job.
- Use the neighbours: a reply usually belongs with the message it answers.
- Use `unsure` only when the records truly cannot decide. A wrong guess and a
  `right` given to be kind both make the measure lie.

## 3. Return (ids only)

One line per drawn item, no words, no names, no addresses, every item of the
draw answered:

```
event_id,verdict,reason,right_job_id
```

## 4. Load (the orchestrator, with the owner's go)

Turn the grader's lines into a JSON array of `{"event_id", "verdict",
"reason", "right_job_id"}` (`pos` and `placed_job_id` may be echoed; they must
be the draw's), and load it with the saved draw through
`scripts/context-placement-grades-load.sql`: a guarded write that ends in
ROLLBACK until the go. The load takes every grade row's sample, position, job,
stratum and counts from the draw itself, and refuses any key that is not an id
or a code, a draw that does not match its own digest or does not hold
positions 1 to `drawn` once each, an answer for an item the draw does not hold,
an answer naming another position or job than the draw, a draw item with no
answer (a sample loads whole or not at all), a drawn item that no longer exists
or was not captured in the draw's window, and a second load of one sample. It
prints the newest sample as the scorecard will read it.
`scripts/context-placement-grades-load-undo.sql` removes one sample whole. To
correct a sample, unload it and load it again.

## What else row 3 has

- Known misfiles: `context_placement_misfile_counts(as_of)` (cheap) and
  `context_placement_misfile_plan()` (one ladder decision per row, for
  scripts). The 70 rows on the placeholder job SWF-PDF-BUCKET are repaired by
  `scripts/context-placement-misfile-repair.sql` (owner's go): 12 move, 18 go to
  review with their guessed payload job set aside, 40 are copies of a text the
  history load already saved and are marked as such
  (`context_placement_message_twin`).
- The 50 live thread bindings to that placeholder are retired by
  `scripts/context-holding-thread-retire.sql`, before any bucket re-run.
- The bucket re-run under the rules-on ladder is
  `scripts/context-bucket-rerun-l1g.sql`: it stamps every placed row relink (no
  Jarvis reaction, no read woken), marks copies instead of placing them, and
  never sends a row Luna already answered back to Luna.
- Every script is proved end to end on a disposable database by
  `scripts/test-context-placement-row3.sh`. Measurements:
  `docs/evidence/context-placement-row3-2026-10-07.md`.
