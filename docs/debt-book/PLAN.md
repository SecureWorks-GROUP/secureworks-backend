# Debt book and chase desk: the plan

**Written:** 2026-09-30. **For:** the captain (Shaun), and the workers who build it.
**Status:** a plan only. Nothing is built, fixed or switched off yet.
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
| **Debt, by the captain's definition** | **97** | **$88,086.25** | Worked out |
| of which overdue | 68 | $56,940.04 | Worked out |
| Not debt | 15 | $23,439.83 | Worked out |

Debt by payer:

| Payer | Invoices | Amount | Overdue |
|---|---:|---:|---:|
| Clients (patio, fencing) | 19 | $37,238.31 | $20,898.10 |
| MLB (make-safe, roof report, repair, assessment) | 65 | $43,927.40 | $29,733.00 |
| AJ (make-safe) | 5 | $2,146.10 | $1,534.50 |
| Other builders (Emergency Trade Services, Builderwest, Western Building) | 8 | $4,774.44 | $4,774.44 |
| **Total** | **97** | **$88,086.25** | **$56,940.04** |

Debt by age (days past the due date, Perth date):

| Age | Clients | MLB | AJ | Other builders | All |
|---|---:|---:|---:|---:|---:|
| Not due yet | $16,340.21 | $14,194.40 | $611.60 | – | $31,146.21 |
| 1 to 30 | $10,839.68 | $26,671.70 | $528.00 | – | $38,039.38 |
| 31 to 60 | $3,497.24 | $1,662.10 | – | – | $5,159.34 |
| 61 to 90 | $4,740.68 | $838.20 | – | – | $5,578.88 |
| 90+ | $1,820.50 | $561.00 | $1,006.50 | $4,774.44 | $8,162.44 |

How the figure moved from the 29 Sep report:

| Change | Invoices | Amount |
|---|---:|---:|
| 29 Sep report, first rules | 95 | $86,375.25 |
| + INV-1011, part payment (Q16) | +1 | +$1,480.00 |
| + INV-0080, Chris Stacey variation (variations count) | +1 | +$231.00 |
| Perth Zoo INV-1477 progress claim: job has no first payment yet (Q9; checked live 30 Sep, work booked 19 Oct) | 0 | $0.00 |
| **Debt now** | **97** | **$88,086.25** |

Not debt (15 invoices, $23,439.83):

- **9 deposits, $9,342.47.**
  - INV-1601, INV-1602 and INV-1603 ($4,689.93) are deposits raised late to
    match bank transfers already received (Q16).
  - INV-1119 ($2,052.88) is a likely duplicate.
  - INV-0560 ($53.14) is leftover cents.
  - 4 are genuinely unpaid ($2,546.52): INV-1010, INV-1374, INV-1571 and
    INV-1597.
- **Perth Zoo progress claim INV-1477, $10,319.68.**
- **The AJ test invoice INV-1240, $352.**
- **4 unclear invoices, $3,425.68:** INV-0034, INV-0177 and INV-0267 are old
  "% of quote" invoices, and INV-1486 is a planning fee. These are open item
  5 in DECISIONS.md.

Inside the debt, flagged "check first" (10 invoices, $4,779.94). Each is still
owed in Xero, so it stays in the figure, but it gets no draft until Shaun has
checked it:

- the Emergency Trade Services pairs INV-0938/INV-1481 and INV-1424/INV-1829;
- Builderwest INV-0597 and INV-0702, which the builder rejected;
- MLB INV-1456, which is in dispute;
- INV-1050 and INV-1391, which are on the duplicate "ML Builders" contact;
- INV-0080, which the desk notes say was overpaid.

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
- MLB, with 42 overdue invoices, $29,733.

Statuses may have changed since 29 Sep.

## 3. The rules the desk applies

The rules are applied in order. They are the tested core of step 1.

1. **Scope.** A Xero sales invoice (ACCREC), status AUTHORISED, with
   `AmountDue > 0`, read live from Xero. The backend copy is never the source.
2. **Payer.** The payer comes from the Xero contact:
   - MLB is "Major Loss Builders" or "ML Builders";
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
     payment, meaning any PAID invoice on the job or `jobs.deposit_at` set.
   - `VAR`, or the line "Extra Labour and Material" with no reference, means a
     variation. Debt.
   - `DEP`, or a line starting "Deposit", means a deposit. **Not debt.** The
     one exception is a named part-payment override: INV-1011 is debt (Q16).
     Keep overrides as a short list, each entry with its reason and the
     decision it came from.
   - `FINBAL`, `FINAL` or `-BAL`, or a line starting "Balance" or reading
     "Remaining quote amount", or `PRIVATE`, means a final invoice. Debt.
   - `PLAN` means a planning fee. It is treated as a before-work invoice (open
     item 5), not debt.
   - An old "N% of quote" line with no token is unclear. It is shown on its
     own list, not debt, until open item 5 is ruled.
5. **Finished job.** For client finals, the job status is `complete`,
   `invoiced`, `final_payment`, `archived` or `rectification`. A final on an
   unfinished job is shown as "check first", not dropped.
6. **Overdue** means Perth today is later than the due date. There is a
   separate "no due date" bucket, never "not due" and never 90+.
7. **Holds.** A hold keeps the invoice in the figure but gives it no chase
   draft:
   - "check first": the doubt list above, plus any invoice the desk class marks
     `in_dispute`, `not_owed` or `blocked_by_us`;
   - "fix first": the job is in rectification (open item 1).

**Acceptance fixture.** Save the 29 Sep list of 112 invoices, with its job
statuses, as a fixture. The rules must give exactly 97 invoices / $88,086.25,
68 overdue / $56,940.04, and the payer and age tables above.

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
  - proposed: a call at 30 days overdue (open item 3).
- **Deposits and before-work invoices:** one friendly reminder about the job.
  After 60 days with no payment, no reply and no job progress, the deposit
  goes on the weekly cancel list. Shaun approves the list, and the void
  happens in Xero.
- **Promises:** a promise records an amount and a date, and pauses chasing.
  The morning after the date, if Xero shows it unpaid or short, the invoice
  goes to the top marked "promise broken", at the next step.
- **Write-offs:** only Shaun, in Xero. The desk may suggest one, never do one.

## 5. What changes on Clear Debt

Clear Debt stays in the same place and keeps the same look. Changes:

- **Header.** It shows debt by the captain's definition ($88,086 / 97,
  $56,940 overdue) and a stamp: "Matches Xero, read HH:MM", or "differs by $X
  on N invoices". Beside it: open in Xero, not debt, check first, and waiting
  for Shaun. "Texts waiting for Marnin" goes.
- **Tabs.** Today (the morning list, first) | Debt book | Promises | Jan |
  Deposits. The debt book tab holds the existing bar and payer groups.
- **Payer card.** It gains outcome buttons (no answer, spoke, promised $ by
  date, disputed, says paid) and a promise box. Text, email, notes, the brief
  and the invoices all stay.
- **Faults.** The B17 display faults go: ages use the Perth date, "refreshed"
  shows the newest time, the header overdue excludes holds, and no-due-date
  invoices get their own bucket.

While GitHub is unavailable, the live Ops dashboard (GitHub Pages) cannot
change. Until then the desk runs as its own page in the same style, signed in
with the Ops login. It becomes the Clear Debt tab when GitHub returns (step 9).

## 6. Build steps, smallest first

Each step is test-first and useful on its own. It is one worker task on the
Firstmate backlog.

| # | Step | Delivers | How long | Captain sees | When |
|---|---|---|---|---|---|
| 0 | Switch off the six automated money messages (existing task `debt-autotexts-off`) | No old automatic money text can reach a customer. Xero's reminder emails stay on. | ~2 h plus production sight | A before/after list of each switch | Before Thursday's first send |
| 1 | Debt book read | A live Xero read plus the section 3 rules, per-invoice reasons, and a copy-vs-Xero diff | ~½ day | Headline, splits, a "why" per invoice | Thursday |
| 2 | Morning list | The schedules as data, today's step per payer, holds | ~½ day | The Today list | Thursday |
| 3 | Draft, approve, send, log | Drafts, approve with a last Xero check, send through `send_chase_sms`, one-tap call outcome, chase-log columns | ~1 day | Approve and send; sent history | Thursday (draft-only if step 0 is not done) |
| 4 | Desk page | The "after" screen as its own page | ~½ day, in parallel | A link | Thursday |
| 5 | Promises and Jan | A promise box, the broken-promise rule, the Jan tab, Jan's morning text (approved) | ~½ day | Promises and Jan tabs | Friday |
| 6 | Builder statements | A Monday statement per builder, grouped by Xero contact, through its own audited send route | 1–2 days | A statement preview to approve | Next week |
| 7 | Deposits and weekly cancel list | The Deposits tab, one reminder, a 60-day cancel list | ~½ day | The Deposits tab | Next week |
| 8 | Fix the copy and screen faults | B7 re-check of closed rows (or a nightly ID-set diff), B17, retire B8 | ~1 day | Clear Debt and desk agree to the cent | Next week |
| 9 | Move into the Ops dashboard | The desk becomes the Clear Debt tab; the Today card links to it | ~1 day | One place | When GitHub is back |
| 10 | Every number agrees | The Today card, Invoices tab, CEO pages, digest and AI tools read the debt book (B9 to B12) | 1–2 days | The same number everywhere | Later |

Being honest about Thursday: steps 1 to 4 add up to about two days of work,
done in parallel across two workers from Wednesday afternoon. If it slips,
priority goes 1, then 2, then 4, then 3. A desk that tells the truth without
sending is still worth reviewing on Thursday.

### Technical notes for the workers

- **Base.** Local `main` (`bfd06cb0`) is 267 commits behind the newest known
  backend, `origin/shaun/agent-skills-setup` @ `509ed121`, and does not even
  contain `ops-api/debt_picture.ts`. The deployed ops-api version was not
  observed. Build on a branch from `509ed121` plus the local security commits.
  Never deploy `ops-api` from this checkout (see "Production Edge Deploy
  Rule" and "Measure The Deployed Thing" in AGENTS.md).
- **New function, not ops-api.** Put the desk in its own edge function,
  `debt-desk` (for example `supabase/functions/debt-desk/`). Deploying it then
  cannot overwrite `ops-api`.
  - It reads Xero through the existing read-only receivables module
    (`ops-api/xero_receivables_read.ts` at `509ed121`), imported, not copied.
  - It sends only through already-live ops-api actions: `send_chase_sms` and
    `add_debt_note`.
  - Pure logic lives in small modules (`debt_book_rules.ts`,
    `debt_chase_schedule.ts`), each with a `_test.ts`.
- **Schema.** Make one additive migration on `payment_chase_logs`:
  - `channel` (sms, email, call, visit, statement, letter);
  - `direction`;
  - `outcome_code`, a closed list;
  - `promised_amount` and `promised_date`;
  - `schedule_step`;
  - `approved_by_user_id`;
  - `automated`;
  - `provider_message_id`;
  - `covers_invoice_ids text[]`, for statements.

  Add row-level security to the table: it has none today, and debt-map-s1
  B19 notes this. Check the migration version against the live ledger
  (`supabase_migrations.schema_migrations`) before applying, and apply it
  before the function that selects the new columns. Firstmate applies both
  through the Supabase connection after the captain has seen them (open
  item 8).
- **Last check.** One live `get_xero_receivable` per send. Remember the Xero
  limit of 60 calls a minute: a batch of about 20 sends is fine, but send in
  sequence, not fanned out.
- **Pay link.** Use Xero's OnlineInvoice URL, fetched per invoice. Do **not**
  use `send_payment_link`, which is broken (B1) and picks the newest invoice.
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
| B9–B12 | Other screens' overdue totals | Step 10 |
| B13, B14 | Wrong or name-matched job links | After step 10. The desk shows the link it used |
| B15 | `reconcile_payment` audit and bank-account faults | Later (payments are matched in Xero) |
| B16, B18 | Health check; old CEO page auth | Later, outside this plan |
| B19 | Committed service key | The separate security task (under way) |

## 9. Risks

- **GitHub is down.** The live dashboard cannot change. Mitigation: a
  separate desk page until step 9.
- **The local code is behind production, and the deployed version is not
  observed.** Mitigation: a new function slug, and send through live actions
  only.
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
- **Duplicate builder contacts in Xero** (MLB, AJ). Mitigation: group by
  payer. The Xero clean-up is for Shaun or bookkeeping.

## 10. Still to decide

See DECISIONS.md, "Still open". The plan follows each recommendation until
the captain rules otherwise:

1. Rectification: count it, but no chase until the fix is done.
2. The launch backlog starts at the friendly text.
3. Builders: 14 days from the invoice date, Monday statements, a call at 30
   days overdue, the same rule for all builders.
4. Builder accounts emails are suggested from remittances; Shaun confirms.
5. The unclear four stay out until checked. A half-of-quote invoice on a
   finished job counts once its other half is paid. The planning fee goes to
   the deposits list.
6. Perth Zoo and other before-work invoices are treated like deposits.
7. Jan gets a morning text approved by Shaun; Shaun records the outcomes.
8. Go-live goes through firstmate's Supabase connection after Shaun has seen
   each change. Sends only after step 0 and Shaun's go.
