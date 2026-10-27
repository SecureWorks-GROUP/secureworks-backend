# The job card follows a person's decisions (CTX-T22)

Migration `20261021150000_context_job_card_events.sql`, CTX-T22 (gap G5).
Contract: `supabase/tests/migration-contracts/20261021150000_context_job_card_events/`.

A person's reconciliation decision (`20261020140000`) records which job a
captured row concerns. A decision never writes `business_events.job_id`, so
until now the job card read past it. On an isolated stack, after a staff split
of the three Stratco emails (SWP-26376), the card stayed byte-identical and the
second job still said no emails were on record (simulated).

## Which rows a card shows

`context_job_card_events(job_ids uuid[])` returns `(job_id, event_id,
by_person)` and is the one rule:

- A person's current decision puts a row on each job its links name. That means
  a confirm, correct or split whose evidence hash still matches
  (`context_recon_decision_state` `decided`).
- Such a decision, or a current unrelated, takes the row off the job the ladder
  put it on.
- Every other row stays where the ladder put it (`business_events.job_id`). A
  decision whose evidence has moved since, an escalate or an unresolved changes
  nothing.

These read it:
- `context_job_record_messages`, and through it the timeline, loops, contact
  counts, first contact and the lead rule's customer messages;
- the lanes of `context_job_story_meta`;
- ops-api `get_job_conversation`.

Lead monitoring, the finished wake, ledger due order and the timeline therefore
count rows that a person placed.

`context_job_card_decisions(job)` lists the decisions that change this card,
newest first. Each entry is `(event_id, placement on|off, action, decision_id,
decided_at, decided_by, decided_by_name from users.name, other_job_numbers)`.

Both helpers are plain SQL, so they inline into their callers, and they are
service role only.

## What the card says

Story meta gains three keys:

- `matching`: `{waiting, more, emails, texts, calls}`. These count the rows
  that `context_recon_job_items` lists for the job now and that no person has
  decided. Counts stop at 200; `more` is set when there are more than that.
- `person_placed`: `{on, off, split, more, items}`. `split` counts the rows on
  the job that a split also put on another job. `items` holds the newest 20,
  with who, when and the evidence hash the decision was made on.
- `cost_check`: `{read_from, bills, counted_elsewhere, items}`. `bills` counts
  the supplier bills the job cost read (`v_job_cost_events`, actual
  `supplier_bill` and `materials_fact` rows, keyed by the Xero bill id) counts
  as cost on this job. `items` lists each of those it also counts as cost on
  another job, with `document_number`, `here_ex`, `elsewhere_ex` and
  `other_job_numbers`. Read as now, in one scan of the view (67 ms on the
  busiest live job, 21 Oct 2026).

The assembler uses them in four places:

- A texts, emails or calls lane with nothing on the job, while Matching holds
  that kind for it, says "No emails are placed on this job yet." It never says
  "No emails are on record for this job." in that case.
- `not_known` says how many messages wait in Matching for a person.
- `not_known` says how many messages on the job a person's split also put on
  another job, and that any amount in them is unknown for this job, because
  placing a message never moves cost.
- `not_known` names a supplier bill the cost read counts on this job and on
  another ("Supplier bill BILL-1 is counted as cost on this job and also on
  SWP-2.") as a defect for Finance to correct.

`matching`, `person_placed` and `cost_check` sit outside the card digest, as all of `meta`
does except `ledger.status`. A decision changes the digest only through the
timeline rows it moves.

`get_job_conversation` reads `readBusinessEventsBySourceTime(..., {
personDecisions: true })`:
- A row that a person's decision put on the job carries `placed_by_person`
  `{action, decision_id, decided_at, decided_by, decided_by_name,
  other_job_numbers}`.
- A row that a decision took off is not listed.
- A failed decisions read still lists the job's own rows and names the failure
  in `person_decisions_read_failed`. It is never read as "no decisions".

## What it does not change

The following still read `business_events.job_id`:
- the reader's evidence (`context_ledger_evidence_rows`) and citation check;
- the quote value;
- the old-inbox mail rule;
- the off-job and unplaced meta reads, so a split row may still be listed there;
- the call transcript pairing, and the ops-api dossier's own `business_events`
  read (its conversation section reuses the job conversation, so that part
  follows decisions).

Money is unchanged, as Finance's allocation contract (21 Oct 2026, copy at
`/mnt/project-files/cio/cfo-allocation-20261021/`, sha256 `5f5bbd4b…7e1d`)
requires:
- Placing a message never allocates money. The card's bills and invoices come
  only from `xero_invoices`, and cost only from `v_job_cost_events`.
- A split message shows on both cards with who placed it. The bill in it counts
  as cost once, on the job Xero's bill link puts it on. The other card shows the
  message as shared evidence and adds no cost.
- A bill with actual cost rows on two jobs is a defect. The card names it and
  never sums it again.
- Nothing here writes `job_materials_facts`, `xero_invoices.job_id` or
  `materials_reconciliation_queue`, divides a bill, shows unknown money as $0,
  or reads a placement as an installer's confirmation. How one bill is shared
  between jobs waits on Finance's rule.

The contract case proves this on one bill: linked to job A, its email split onto
A and B. A counts it once, B adds nothing, and the two together count exactly
the bill. A materials fact seeded on B for the same bill is named as a defect on
both cards.

The migration adds no table, column, index or trigger, and writes no row. The
reader stays at v8.
