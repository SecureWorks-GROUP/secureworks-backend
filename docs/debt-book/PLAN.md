# Debt book and chase desk: the plan

**Written:** 2026-09-30. **For:** the captain (Shaun), and the workers who build it.
**Status:** approved 30 Sep; build in progress (steps 0-2 merged; step 3 in
review; the step 4 screen merged in secureworks-ux; step 5 in this change,
with sending off; see the PRs).
**Reviewed in Lavish:** this document matches the Lavish plan page shown to the
captain. Plain words are explained in [GLOSSARY.md](GLOSSARY.md). The
captain's rulings, word for word, are in [DECISIONS.md](DECISIONS.md).

Sources:

- `debt-map-s1`: what exists today, the bugs, and a draft phased plan.
  Firstmate data, `data/debt-map-s1/report.md`.
- `debt-baseline-s2`: the live Xero figures read at 2026-09-29 15:19 Perth
  time. Firstmate data, `data/debt-baseline-s2/report.md`.
- One live read-only check on 2026-09-30: `sw_invoice_context` for INV-1477.

## 1. The goal

Know how much debt we have, and chase it every morning:

- one number that always agrees with Xero;
- a list each morning of who to chase, with the message already drafted;
- Shaun approves each message, it is sent, and the result is logged;
- promises to pay are tracked, and a missed promise returns to the top;
- day 7 goes to Jan, and builders get a statement.

It is built on the existing Clear Debt screen and backend, not as a new app.
Aim: a working version on Thursday 2026-10-01 for feedback, and tweaks on
Friday 2026-10-02.

## 2. Today's debt

All figures come from the Xero list of 29 Sep, 15:19 Perth time: 112 open
invoices totalling $111,526.08. They are recomputed under the captain's final
rulings.

| Figure | Invoices | Amount | Kind |
|---|---:|---:|---|
| Open in Xero | 112 | $111,526.08 | Exact (Xero's own figure) |
| **Debt, by the captain's definition** | **97** | **$89,049.43** | Worked out |
| of which overdue | 68 | $57,903.22 | Worked out |
| Not debt | 15 | $22,476.65 | Worked out |

Live on 2026-09-30 (see below), the debt is 103 invoices, $131,790.62. That
includes $42,170.79 of new materials invoices, not due until 7 Oct.

Debt by payer:

| Payer | Invoices | Amount | Overdue |
|---|---:|---:|---:|
| Clients (patio, fencing) | 21 | $38,811.99 | $22,471.78 |
| MLB, the Major Loss Builders contact (make-safe, roof report, repair, assessment) | 63 | $43,316.90 | $29,122.50 |
| AJ (make-safe) | 5 | $2,146.10 | $1,534.50 |
| Other builders (Emergency Trade Services, Builderwest, Western Building) | 8 | $4,774.44 | $4,774.44 |
| **Total** | **97** | **$89,049.43** | **$57,903.22** |

Debt by age (days past the due date, Perth date):

| Age | Clients | MLB | AJ | Other builders | All |
|---|---:|---:|---:|---:|---:|
| Not due yet | $16,340.21 | $14,194.40 | $611.60 | – | $31,146.21 |
| 1 to 30 | $10,839.68 | $26,391.20 | $528.00 | – | $37,758.88 |
| 31 to 60 | $3,497.24 | $1,332.10 | – | – | $4,829.34 |
| 61 to 90 | $4,740.68 | $838.20 | – | – | $5,578.88 |
| 90+ | $3,394.18 | $561.00 | $1,006.50 | $4,774.44 | $9,736.12 |

How the figure moved from the 29 Sep report:

| Change | Invoices | Amount |
|---|---:|---:|
| 29 Sep report, first rules | 95 | $86,375.25 |
| + INV-1011, part payment (Q16) | +1 | +$1,480.00 |
| + INV-0080, Chris Stacey variation (variations count) | +1 | +$231.00 |
| − INV-1050, INV-1391 on the old "ML Builders" contact (only Major Loss Builders counts; round 4) | −2 | −$610.50 |
| Perth Zoo INV-1477: labelled a progress claim, really a deposit (round 4) | 0 | $0.00 |
| + INV-0034, INV-0267: old "50% of quote" invoices already on Jan's list (round 6) | +2 | +$1,573.68 |
| **Debt on the 29 Sep list** | **97** | **$89,049.43** |

Not debt (15 invoices, $22,476.65):

- **10 deposits, $19,662.15.**
  - INV-1601, INV-1602 and INV-1603 ($4,689.93) are deposits raised late to
    match bank transfers already received (Q16).
  - INV-1119 ($2,052.88) is a likely duplicate.
  - INV-0560 ($53.14) is leftover cents.
  - 5 are genuinely unpaid ($12,866.20): INV-1010, INV-1374, INV-1571,
    INV-1597, and Perth Zoo INV-1477 ($10,319.68). INV-1477 is labelled a
    progress claim, but the captain ruled it a deposit. The work is booked
    for 19 Oct, and the job had no payment when checked live on 30 Sep.
- **2 invoices on the old "ML Builders" contact, $610.50:** INV-1050 and
  INV-1391. The captain ruled that only the "Major Loss Builders" contact
  counts for MLB.
- **The AJ test invoice INV-1240, $352.**
- **2 invoices left aside for now, $1,852.00** (captain, round 6):
  INV-0177 (Geoffrey Peddie, a "% of quote" invoice our notes say was paid by
  bank transfer) and INV-1486 (Ross Dunstan planning fee). They are not
  chased.

Inside the debt, flagged "check first" (8 invoices, $4,169.44). Each is still
owed in Xero, so it stays in the figure, but it gets no draft until Shaun has
checked it:

- the Emergency Trade Services pairs INV-0938/INV-1481 and INV-1424/INV-1829;
- Builderwest INV-0597 and INV-0702, which the builder rejected;
- MLB INV-1456, which is in dispute;
- INV-0080, which the desk notes say was overpaid.

### Live check, 2026-09-30 13:36 Perth (captain asked for a connection check)

Read-only, through `sw_list_xero_receivables` (2 pages) and
`sw_debt_context_coverage`. These call the same `xero_receivables_read.ts`
module that step 1 builds on.

- **Xero read is sound.**
  - Both pages came live with `cache_used: false`, ordered by InvoiceID.
  - 118 unique invoices, no duplicates across pages, all AUTHORISED with
    `AmountDue > 0`.
  - `end_of_results_observed: true` on page 2.
  - Quota left: 58 calls a minute, 2,167 a day.
- **Open in Xero:** 118 invoices, $154,267.27.
  - Since 29 Sep: INV-1608 (Emma Clarke, $600) was paid and dropped off.
  - 7 invoices are new: 3 MLB ($1,170.40) and 4 "materials" invoices,
    `SWP-...-MAT` / `MAT50`, totalling $42,170.79. Those 4 are INV-1616
    ($22,094.22), INV-1618 ($8,750.01), INV-1619 ($3,932.06) and INV-1621
    ($7,394.50).
  - Every invoice common to both reads kept the same amount.
- **Debt today** under the rules: 103 invoices, $131,790.62.
  - That is the 29 Sep debt ($89,049.43), minus INV-1608 ($600), plus the
    3 new MLB invoices ($1,170.40), plus the 4 materials invoices
    ($42,170.79).
  - The captain ruled materials invoices count once the job has had its
    first payment (round 6). A live read showed all 4 jobs had
    `deposit_at` set (SWP-26595 on 10 Aug, SWP-261160 on 21 Aug, SWP-26320
    on 25 May, SWP-26195 on 15 May), so all 4 count.
- **Clear Debt's copy:** 112 invoices, $150,683.79.
  - It holds all 7 new invoices, so the sync works, and every shared amount
    matches to the cent.
  - It still lacks the same 6 invoices, $3,583.48 (B7).
- **Build notes for step 1:**
  - `pagination.traversal_complete` stays `false` even on the final page. Stop
    on `end_of_results_observed` / `has_more: false`.
  - Pages are not a snapshot, so de-duplicate by InvoiceID.
  - Page 1 is about 260 KB with full line items, so trim it server-side
    before returning.

Clear Debt's copy was missing 6 open invoices ($3,583.48), because they are
wrongly marked DELETED. 4 of those are debt: INV-0938, INV-0352, INV-0704 and
INV-0080. The desk reads Xero directly, so it sees them.

**Estimate.** The first morning list will hold 8 homeowner finals, about
$23,380. That is the 4 finals due 29 Sep ($16,340.21), which are 2 days
overdue on Thursday, plus the 4 overdue finals classed genuine or never
classified ($7,039.73: INV-0290, INV-1069, INV-1435, INV-1578). It also shows:

- 5 finals the desk had classed "blocked by us", $6,703.75, which need a look
  first;
- 5 rectification invoices, $6,923.62;
- MLB, with 40 overdue invoices, $29,122.50;
- INV-0034 and INV-0267 ($1,573.68), which start at the Jan step because
  they are already on Jan's list.

Statuses may have changed since 29 Sep.

## 3. The rules the desk applies

The rules are applied in order. They are the tested core of step 1.

1. **Scope.** A Xero sales invoice (ACCREC), status AUTHORISED, with
   `AmountDue > 0`, read live from Xero. The backend copy is never the source.
2. **Payer.** The payer comes from the Xero contact:
   - MLB is the "Major Loss Builders" contact only. Invoices on other MLB-like
     contacts (such as "ML Builders") are not MLB debt and are not chased;
     they are listed apart (round 4);
   - AJ is "AJ Building & Restoration" or "Insurebuild Pty Ltd WA (AJ Building
     & Restoration)";
   - other builders are Emergency Trade Services, Builderwest (both contacts)
     and Western Building;
   - everyone else is a client.

   Keep this as a data table, not code branches, so a new builder contact is a
   one-line change.
3. **Builder invoices** are debt, except the test invoices (reference contains
   `SAMPLE-`). The subtype comes from the line text: roof report, assessment
   report, repair (supply, install or replace wording), otherwise make-safe.
4. **Client invoices.** The first rule that matches wins:
   - `PROG` means a progress claim. It is debt only if the job has had a first
     payment, meaning any money received on the job: `jobs.deposit_at` set,
     any PAID sales invoice on the job, or an amount paid (`amount_paid > 0`)
     on this invoice or any sibling sales invoice on the job (part payment
     counts, round 2).
     The one exception is INV-1477 (Perth Zoo), which the captain ruled is
     really a deposit.
   - `MAT` / `MAT50` means a materials invoice (first seen 2026-09-30). It is
     treated like `PROG`: debt only after the job's first payment (captain,
     round 6).
   - `VAR`, or the line "Extra Labour and Material" with no reference, means a
     variation. Debt.
   - `DEP`, or a line starting "Deposit", means a deposit. **Not debt.** The
     one exception is a named part-payment override: INV-1011 is debt (Q16).
   - **Labels can be wrong.** The kind comes from the reference and line text,
     and two invoices are labelled wrongly (INV-1011, INV-1477). Keep the
     captain's corrections as a short list, each entry with its reason and
     the decision it came from. The real fix is at the source (step 10): the
     tools that raise invoices, including the Xero MCP tools, must state the
     kind correctly (captain, round 4).
   - `FINBAL`, `FINAL` or `-BAL`, or a line starting "Balance" or reading
     "Remaining quote amount", or `PRIVATE`, means a final invoice. Debt.
   - `PLAN` means a planning fee. Not debt.
   - An old "N% of quote" line with no token is unclear, and is not debt by
     default. The captain ruled the current four by name (round 6):
     - INV-0034 and INV-0267 are debt, and start at the Jan step;
     - INV-0177 and INV-1486 are left aside.

     Keep these on the corrections list.
5. **Finished job.** For client finals, the job status is `complete`,
   `invoiced`, `final_payment`, `archived` or `rectification`. A final on an
   unfinished job is shown as "check first", not dropped.
6. **Overdue** means Perth today is later than the due date. There is a
   separate "no due date" bucket, never "not due" and never 90+.
7. **Holds.** A hold keeps the invoice in the figure but gives it no chase
   draft:
   - "check first": the doubt list above, plus any invoice the desk class marks
     `in_dispute`, `not_owed`, `blocked_by_us` or `bad_debt`. A `bad_debt`
     invoice is never chased; the desk suggests a write-off, which only Shaun
     does, in Xero;
   - "fix first": the job is in rectification. It counts, but gets no chase
     until the fix is done (captain, round 6).

**Acceptance fixture.** Save the 29 Sep list of 112 invoices, with its job
statuses, as a fixture. The rules must give exactly 97 invoices / $89,049.43,
68 overdue / $57,903.22, and the payer and age tables above.

## 4. The daily workflow

1. **07:00 Perth, read.** The agent reads the open book from Xero (two pages
   of 100) and applies the rules. Anything paid or reconciled since yesterday
   is simply gone.
2. **Morning list.** For each payer, work out today's step from the schedule
   and the chase log:
   - broken promises first;
   - then Jan visits;
   - then calls;
   - then texts;
   - then builder statements;
   - then deposit reminders.

   Within each group, sort by amount, then age. Holds show with their reason
   and no draft.
3. **Drafts.** Each draft uses standard wording for its step, filled in with
   the name, invoice number, amount, due date, and the Xero online-invoice pay
   link. The agent may add one line of context from the conversation. It must
   never invent facts, threaten, or mention legal action or credit reporting.
4. **Approve.** Shaun approves, edits or skips each draft, singly or as a
   ticked batch. Every approval records Shaun's user id.
5. **Last check, then send.** Immediately before sending, re-read that
   invoice live from Xero. If it is paid, part-paid below the draft amount,
   voided or credited, do not send, and show why. SMS goes through the
   existing ops-api `send_chase_sms`, which is logged and credentialed and
   sends from +61489267771, so replies land in the Group Admin thread.
6. **Log.** Every send, call, visit, statement, promise and outcome is written
   to the chase log against the invoice. A statement is written against each
   invoice it covers.

The schedules:

- **Homeowners:**
  - day 1 after due: friendly text;
  - day 2: firm text with the pay link;
  - day 3: Shaun calls;
  - day 7: Jan visits.

  The next step fires only if the last step's outcome did not resolve it.
- **Builders:**
  - after 14 days, the invoice goes on a statement;
  - statements go every Monday while unpaid;
  - Shaun calls any builder invoice 30 days past its due date (decided,
    round 5).
- **Deposits and before-work invoices:** one friendly reminder about the job.
  After 60 days with no payment, no reply and no job progress, the deposit
  goes on the weekly cancel list. Shaun approves the list, and the void
  happens in Xero.
- **Promises:** a promise records an amount and a date, and pauses chasing.
  A promised builder invoice still stays on the Monday statement, marked.
  When the promise is logged, the desk reads the invoice live from Xero and
  stores the amount then due (`amount_due_at_promise`; for a promise covering
  several invoices, their total). The morning after the date, the promise is
  kept when the amount paid since the promise covers the promised amount
  (amount due at the promise less today's amount due, an invoice paid off
  counting as nothing due). Otherwise, unpaid or short, the invoice goes to
  the top marked "promise broken", at the next step. This holds for deposits
  too. One promise covering several invoices is one promise on the Promises
  list, never one per invoice.
- **Jan** (step 5; Q7: "Morning text to Jan that I approve; I record what he
  reports"): one text a morning to Jan's own mobile, listing today's Jan
  visits (name, site address when the job has one, invoice numbers, amount
  owing, days overdue), a broken promise at the Jan step included. Shaun
  approves it like any draft and it goes through the same guarded send, off
  until Shaun's go. Jan's mobile is read only from the one staff record
  named Jan; when it cannot be found unambiguously the text says "Jan's
  mobile not set in staff records" and cannot be approved. Shaun records what Jan
  reports (visited and paid, promised, no one home, disputed), which moves
  the ladder like a call: no one home comes back to Jan the next morning,
  paid and disputed hold the invoice for a check, a promise pauses chasing.
  Contract: [DESK-API.md](DESK-API.md).
- **Write-offs:** only Shaun, in Xero. The desk may suggest one, never do one.

## 5. What changes on Clear Debt

Clear Debt stays in the same place and keeps the same look. Changes:

- **Header.** It shows debt by the captain's definition ($89,049 / 97,
  $57,903 overdue) and a stamp: "Matches Xero, read HH:MM", or "differs by $X
  on N invoices". The overdue figure is the whole-debt overdue that matches
  Xero, so it includes held invoices. Beside it: open in Xero, not debt,
  "check first" and "fix first" (each hold shown as its own figure), and
  waiting for Shaun. Held invoices get no chase draft on the morning list.
  "Texts waiting for Marnin" goes.
- **Tabs.** Today (the morning list, first) | Debt book | Promises | Jan |
  Deposits. The debt book tab holds the existing bar and payer groups.
- **Payer card.** It gains outcome buttons (no answer, spoke, promised $ by
  date, disputed, says paid) and a promise box. Text, email, notes, the brief
  and the invoices all stay.
- **Faults.** The B17 display faults go: ages use the Perth date, "refreshed"
  shows the newest time, disputed, not-owed and bad-debt invoices are no
  longer counted in "overdue" unseen (they stay in it, and are also shown
  under the "check first" hold figure), and no-due-date invoices get their
  own bucket.

GitHub is back (captain, 2026-09-30), so these changes ship into the real
Clear Debt tab from Thursday. They go through a reviewed secureworks-ux pull
request, and GitHub Pages serves the result about 3 minutes after merge.
There is no separate desk page.

## 6. Build steps, smallest first

Each step is test-first and useful on its own. It is one worker task on the
Firstmate backlog.

| # | Step | Delivers | How long | Captain sees | When |
|---|---|---|---|---|---|
| 0 | Switch off the six automated money messages (existing task `debt-autotexts-off`) | No old automatic money text can reach a customer. Xero's reminder emails stay on. | ~2 h plus production sight | A before/after list of each switch | Before Thursday's first send |
| 1 | Debt book read | A live Xero read plus the section 3 rules, per-invoice reasons, and a copy-vs-Xero diff | ~½ day | Headline, splits, a "why" per invoice | Thursday |
| 2 | Morning list | The schedules as data, today's step per payer, holds | ~½ day | The Today list | Thursday |
| 3 | Draft, approve, send, log | Drafts, approve with a last Xero check, send through `send_chase_sms`, one-tap call outcome, chase-log columns | ~1 day | Approve and send; sent history | Thursday (draft-only if step 0 is not done) |
| 4 | New Clear Debt screen | The "after" screen in the real Clear Debt tab (secureworks-ux PR); the Today card links to it | ~½ day, in parallel | Ops dashboard, Financials, Clear Debt | Thursday |
| 5 | Promises and Jan | A promise box, the broken-promise rule, the Jan tab, Jan's morning text to his own phone (approved) | ~½ day | Promises and Jan tabs | Backend built 1 Oct (Jan's text, what Jan reports, promises tested end to end), sending off; screen changes listed in the PR |
| 6 | Builder statements | A Monday statement per builder, grouped by Xero contact (for MLB, Major Loss Builders only), to accounts@mlbuilders.com.au / accounts@ajs.build, through its own audited send route | 1–2 days | A statement preview to approve | Next week |
| 7 | Deposits and weekly cancel list | The Deposits tab, one reminder, a 60-day cancel list | ~½ day | The Deposits tab | Next week |
| 8 | Fix the copy and screen faults | B7 re-check of closed rows (or a nightly ID-set diff), B17, retire B8 | ~1 day | Clear Debt and desk agree to the cent | Next week |
| 9 | Every number agrees | The Today card, Invoices tab, CEO pages, digest and AI tools read the debt book (B9 to B12) | 1–2 days | The same number everywhere | Later |
| 10 | Label invoices correctly at the source | The tools that raise invoices, including the Xero MCP tools, state the kind (deposit, progress claim, variation, final) correctly; the corrections list can then retire | 1–2 days, scoped when picked up | No more "says deposit but isn't" | Later (captain: "fix the xero mcp tools later") |

Being honest about Thursday: steps 1 to 4 add up to about two days of work,
done in parallel across two workers from Wednesday afternoon. If it slips,
priority goes 1, then 2, then 4, then 3. A desk that tells the truth without
sending is still worth reviewing on Thursday.

### Technical notes for the workers

- **Base: always the newest code** (captain, round 6: "make sure we're
  building on the most up to date one"). The local clones were taken while
  GitHub was down and went stale: the old local `main` (`bfd06cb0`) did not
  even contain `ops-api/debt_picture.ts`. This plan is checked against GitHub
  `main` @ `de512e2c` (2026-09-30), where `debt_picture.ts`,
  `xero_receivables_read.ts`, `send_chase_sms`, `add_debt_note` and
  `ops_api_version` all exist. Before step 0:
  - push the branches parked in firstmate's `github-pending.md`;
  - refresh every local clone's `main` from GitHub `main`, in the backend and
    in secureworks-ux.

  Every task then does three checks:
  1. It branches from freshly fetched `origin/main` and records that SHA.
  2. Before asking for merge, it rebases and confirms with
     `git merge-base --is-ancestor origin/main HEAD`.
  3. Before relying on anything live, it checks the deployed version with
     `ops-api?action=ops_api_version` and `git merge-base --is-ancestor`.

  A branch built on a stale base is refused, not merged.
- **Ship the normal way.** Changes ship as reviewed pull requests:
  - Backend changes merge to `main`. The Edge deploy workflow applies pending
    migrations first, then deploys the function (see "Migrations Apply Before
    Edge Deploys" and "Production Edge Deploy Rule" in AGENTS.md).
  - Nothing is deployed from a local checkout, and there is no
    Supabase-connector apply.
  - The UX change is a secureworks-ux PR, live on GitHub Pages after merge.
  - `deno-check` is the one required check on the backend.
- **Where the code lives.** The desk lives inside `ops-api` as its own modules,
  following the `debt_picture.ts` pattern. It must not grow `index.ts` beyond
  the action wiring.
  - The pure logic is `debt_book_rules.ts` and `debt_chase_schedule.ts`, each
    with a `_test.ts`.
  - Xero reads go through the existing read-only `xero_receivables_read.ts`.
  - SMS goes through the existing `send_chase_sms` path, and notes through
    `add_debt_note`.
- **Schema.** Make one additive migration on `payment_chase_logs`:
  - no new channel column: widen the existing `method` CHECK constraint to
    add `visit`, `statement` and `letter`, so `method` stays the one channel
    field that Clear Debt and `send_chase_sms` already use. That means
    dropping and re-adding `payment_chase_logs_method_check`, re-listing
    every value from the LIVE `pg_constraint` definition (nine today, per
    `20260911120000_debt_picture.sql`: call, sms, auto_sms, email, note,
    status_change, personality_note, classification, proposal) plus the
    three new ones. Never copy the older `20260326000001_clear_debt.sql`
    list, which lacks classification and proposal;
  - `direction`;
  - `outcome_code`, a closed list (no_answer, spoke, promised, disputed,
    says_paid, sending, sent, failed, skipped), beside the existing free-text
    `outcome` column, which stays for notes and older rows. A send first
    claims its draft with a `sending` row per invoice, which becomes `sent`;
    a partial unique index allows one sending-or-sent row per draft and
    invoice, so a draft never texts twice;
  - `promised_amount` and `promised_date`;
  - `amount_due_at_promise`, the amount due read live from Xero when a
    promise is logged, so a part payment can show the promise kept;
  - `schedule_step`;
  - `approved_by_user_id`;
  - `automated`, default false;
  - `provider_message_id`;
  - `covers_invoice_ids text[]`, for statements and for any message or
    promise covering several invoices;
  - `draft_id` and `draft_amount`, which tie each approval, skip, send or
    refused send to its morning-list draft and the amount the draft was
    written against, so the last check can refuse a part-paid invoice.

  Built in `20261001100000_debt_desk_chase_log.sql`.

  Add row-level security to the table: it has none today, and debt-map-s1
  B19 notes this. Check the migration version against the live ledger
  (`supabase_migrations.schema_migrations`), because production carries
  versions this repo lacks. Ship the migration in the same PR as the code
  that selects its columns, or land it first. The deploy lane applies it
  before the function.
- **Last check.** One live `get_xero_receivable` per send. Remember the Xero
  limit of 60 calls a minute: a batch of about 20 sends is fine, but send in
  sequence, not fanned out. "Credited" means a credit that leaves less owing
  than the draft says; an older credit note with the drafted balance still
  owing does not block the text.
- **Who approves and sends.** Only the desk owner: the user ids in the
  ops-api secret `DEBT_DESK_OWNER_USER_IDS`, or, unset, the owner list in
  `debt_desk_settings`, seeded with Shaun's `users.id`. Never a role (five
  live users hold `ops_manager`). With no owner, nobody can approve or send
  and the screen shows "desk owner not set". Any staff user may log a call or
  visit outcome.
- **Sending switch.** One server-side switch, `DEBT_SENDING_ENABLED`, off
  unless it is exactly `true`. While it is off every send attempt is refused
  and logged as refused. It is turned on only after step 0 is done and
  Shaun says start sending.
- **Pay link.** Use Xero's OnlineInvoice URL, fetched per invoice. Do **not**
  use `send_payment_link`, which is broken (B1) and picks the newest invoice.
  The morning list reads at most 10 links live per read and keeps each for
  the Perth day, so re-reading the list does not spend the Xero limit.
- **No paid AI.** Drafts are deterministic templates. The morning agent run
  (subscription Claude, as a scheduled routine) may add one context line and
  flags oddities. It never sends.
- **Builder statements** are a new outbound email kind. They must not reuse
  the SES pack or mailer routes, and must not weaken `send-outlook-email`'s
  SES fence. Give them their own audited route, with one chase-log row per
  covered invoice.

## 7. The switch-off (step 0)

The captain ruled "all off" (Q6). Xero's own reminder emails stay on
permanently (Q6b).

| Message | What is wrong | How it is switched off |
|---|---|---|
| Day-3 deposit reminder, 09:00 (stale-followup) | Matches `%deposit%`; references say `DEP`, so it never fires (B4) | Unschedule its cron |
| Daily Pay Now deposit chaser, 07:00, days 7–13 (daily-digest) | Texts the newest invoice's link. The SMS 401s but is recorded as sent (B1, B4) | Disable that section of the digest |
| Pay Now text on quote acceptance | 0 of 72 ever delivered. The acceptance email stays | Disable the SMS leg only; keep the AUTHORISED-invoice and email invariants in AGENTS.md |
| Payment thank-you text (`process-payment-events`) | Fires on void or credit, and marks events processed on failure (B2, B3) | Unschedule its cron |
| GoHighLevel `chase-overdue` workflow | The tag call is unauthenticated (B5) | Refuse `trigger_chase_workflow` / `stop_chase_workflow` |
| Jarvis `debt-chase` (external `secureworks-agent`) | Can auto-send two stages; off only by a missing flag, and fails open (B6) | Set its flag off explicitly in that repo; not local |

**The trap.** Do not add the missing GHL credentials to "fix" these (see
debt-map-s1 section 7.1). That would switch every one of them back on at
once.

## 8. Known bugs, and when each is dealt with

These come from debt-map-s1 section 7.

| Bug | What | When |
|---|---|---|
| B1–B6 | Broken automated money messages | Step 0 (off) |
| B7 | The copy never re-checks rows it thinks are closed or deleted: 6 invoices, $3,583.48 | Step 1 works around it by reading Xero live; step 8 fixes it |
| B8 | `mark_invoice_paid` writes our copy only | Step 8 (retire) |
| B17 | Clear Debt display faults | The desk avoids them; step 8 fixes them |
| B9–B12 | Other screens' overdue totals | Step 9 |
| B13, B14 | Wrong or name-matched job links | After step 9. The desk shows the link it used |
| B15 | `reconcile_payment` audit and bank-account faults | Later (payments are matched in Xero) |
| B16, B18 | Health check; old CEO page auth | Later, outside this plan |
| B19 | Committed service key | The separate security task (under way) |

## 9. Risks

- **Building on stale code.** The local clones predate GitHub's return.
  Mitigation: branch from current GitHub `main`, and go live only through
  reviewed PRs and the deploy lane.
- **An unfinished desk in front of staff.** The new screen is in the real
  dashboard from Thursday. Mitigation: the send button stays off until
  step 0 is done and Shaun says go.
- **Chasing someone who has already paid.** Mitigations:
  - the last Xero check before every send;
  - "says paid" as an outcome;
  - "check first" holds;
  - prompt matching in Xero.
- **Two chasers.** Xero's reminder emails stay on (ruled). Our code cannot see
  Xero's reminder schedule. If the captain shares it, avoid texting on the
  same days.
- **The Luna fact extractor is failing.** A live read on 30 Sep showed
  `credit balance is too low`. Mitigation: drafts do not depend on it.
- **Thursday is tight.** Mitigation: the priority order in section 6, and
  draft-only if needed.
- **Invoices on old builder contacts.** INV-1050 and INV-1391 ($610.50) sit
  on "ML Builders", which the captain ruled irrelevant. They are left out and
  never chased. If either is really owed, it needs moving to Major Loss
  Builders in Xero. AJ's two contacts still count as one payer.

## 10. Decided, and what is left to confirm

All eight calls were answered on 2026-09-30 (round 6). They are recorded
word for word in DECISIONS.md:

1. Rectification: it counts, but gets no chase until the fix is done.
2. The launch backlog starts at the friendly text, one step a day.
3. Builders:
   - 14 days from the invoice date;
   - statements every Monday;
   - the same rule for every builder;
   - a call at 30 days overdue.
4. Statement addresses: MLB `accounts@mlbuilders.com.au`, AJ
   `accounts@ajs.build`.
5. Unclear invoices:
   - INV-0034 and INV-0267 are debt and already on Jan's list;
   - INV-0177 and INV-1486 are left aside.
6. Materials invoices are debt once the job has had its first payment.
7. Jan gets a morning text to his own phone, approved by Shaun. Shaun records
   what Jan reports.
8. Go-live follows the normal GitHub route: reviewed PRs merged on Shaun's
   approval, then the backend deploy lane. Sends only after step 0 and
   Shaun's go.

Left to confirm during the build:

- the accounts email for Emergency Trade Services, Builderwest and Western
  Building;
- Jan's mobile number. The desk reads it from the one staff record named
  Jan and shows it on Jan's text before Shaun approves; check it there
  before the first text.
