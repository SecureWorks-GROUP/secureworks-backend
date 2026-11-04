# Debt Workshop (backend)

The Debt tab on the ops dashboard: see every unpaid invoice clearly, pick the next action, and
send the follow-up text with one tap. Captain: Shaun, approved 8 Oct 2026.

- **Contract:** secureworks-wiki `coding/capabilities/debt-follow-up/debt-workshop-spec.md`.
- **Agent playbook:** secureworks-wiki `harness/ops/skills/secureworks-debt-workshop/`
  (`references/agent-contract.md` is the agent's view of the two agent actions).
- **Screen:** secureworks-ux `modules/ops-debt-workshop.js`, documented in
  secureworks-ux `docs/debt-workshop.md`.
- **Replaces:** the 30 Sep to 1 Oct debt desk, removed 8 Oct 2026 (code, actions and `docs/debt-book/`); its decisions are superseded by secureworks-wiki `decisions/2026-10-08-debt-workshop.md`.

Nothing is sent when this merges. Every switch below starts off.

## Where the code is

| File | What it holds |
|---|---|
| `supabase/functions/ops-api/debt_ws_rules.ts` | The plain rules, with no database and no AI: scope, lane, invoice kind, share, the debt rule, due dates, day 0, categories, the steps with the weekend shift, the neighbour label, the bank-feed matcher, the message templates, Jan's text and the statement HTML. |
| `debt_ws_store.ts` | Every database read and write, behind one interface. |
| `debt_ws_book.ts` | The read model: the debt book worked out once and shared by the overview, the job view, statements, Jan's list and the agent queue. |
| `debt_ws_payer.ts` | Who pays each invoice (the payer, see below), which messages are theirs, and the shares on a job. |
| `debt_ws_actions.ts` | The 19 actions, the guarded send, and `runDebtWsAction` (the method, staff, owner and server-key checks). |
| `debt_ws_report.ts` | The debt report as plain data, its HTML page and its email (see "The debt report" below). No database, Xero or email in it. |
| `debt_ws_report_pdf.ts` | The debt report drawn as a PDF with jsPDF (the same import as the purchase order PDF). |
| `debt_ws_deps.ts` | Builds the dependencies from what `index.ts` owns. |
| `index.ts` | Wiring only: one `case` block that injects `sendChaseSms`, `getJobConversation`, `getToken`, `xeroReadGet`, `updateJobStatus`, the Outlook send, `getInvoicePdf`, `searchGHLContacts`, the staff SMS path and the job document reads. |
| `supabase/migrations/20261008170000_debt_workshop.sql` | The seven tables, row-level security, and the two cron jobs. Rollback: `supabase/rollbacks/20261008170000_debt_workshop_down.sql`. |
| `supabase/migrations/20261015170000_debt_ws_report.sql` | The debt report: three settings, `debt_ws_reports`, `debt_ws_payments_between` and the auto-send cron (first on Monday). Rollback: `supabase/rollbacks/20261015170000_debt_ws_report_down.sql`. |
| `supabase/migrations/20261020150000_xero_mirror_checks.sql` | `xero_mirror_checks`: one row per hourly check of our Xero copy against Xero (see "Total owed to us and the check against Xero"). Rollback: `supabase/rollbacks/20261020150000_xero_mirror_checks_down.sql`. |
| `debt_ws_xero_check.ts` | The newest check as one plain line: "Matches Xero", "Does not match Xero: N invoices differ (...)", or "Not checked against Xero yet". |
| `supabase/migrations/20261016180000_debt_ws_report_wednesday.sql` | Moves the auto-send to Wednesday 12:00 Perth and adds the 11:55 Xero refresh (`trigger_debt_ws_report_refresh()`, cron `debt-ws-report-refresh`). Rollback: `supabase/rollbacks/20261016180000_debt_ws_report_wednesday_down.sql` (back to Monday 08:00). |
| `supabase/migrations/20261105120000_debt_ws_receivables.sql` | Per-company terms (`company_terms`, `company_terms_default` on `debt_ws_settings`, seeded MLB 10 and Ambrose Construct Group 14) with their one write path `debt_ws_set_company_terms()`, and the report moved to Wednesday 14:00 Perth with its refresh at 13:55. `report_auto_send` is not touched. Rollback: `supabase/rollbacks/20261105120000_debt_ws_receivables_down.sql` (back to 12:00 and 11:55; the terms are dropped). |
| `debt_ws_receivables.ts` | Receivables (Shaun, 4 Nov 2026): whether an unpaid invoice is Debt, Other receivables, the Write-off list or Needs a look, its type, its pay-by date and days overdue, and the overdue bands. Display only: the chase does not read it. |

## The actions

Who may call each action:
- **staff:** a signed-in staff user (admin, owner or ops_manager). The server key is refused.
- **owner:** the workshop owner, signed in.
- **server key:** only the two Jan list crons, the Wednesday 2pm report cron, and the agent queue and submit (which the owner may also call).

| Action | Method | Who | What it does |
|---|---|---|---|
| `debt_ws_overview` | GET | staff | Everything W1 needs: categories, rows, companies, not due, not chased, needs a look, paid this week, Jan's list, `receivables` (every unpaid invoice: Debt, Other receivables, the Write-off list and Needs a look, see "Receivables"), `week_money` (paid to us this week against new invoices raised this week), `xero_check` (whether our copy matched Xero), and `total_owed` (the older breakdown, kept for a screen that has not reloaded). Every row carries `receivable_class`, `type_label`, `pay_by`, `days_overdue` and `terms_days`; every company carries `terms_days` and `terms_default`. |
| `debt_ws_job` | GET `xero_invoice_id` (optional `conversation=all`) | staff | Everything W2 needs: row, job (with `shares[]`), `payer_contact`, story, invoices, documents, conversation (the payer's own messages; `conversation=all` gives the whole job's thread with each message marked `party_name` / `is_payer`), notes, ladder, suggestion (a pending agent draft or move, else the template draft), flags, possible payments, the payer's contact candidates, `send_block`, `manual_text` (`{allowed, code, reason}`: whether Shaun may type his own text here, and why not in words) and the pay link. |
| `debt_ws_document` | GET `job_id, document_id` (or `xero_invoice_id`) | staff | One job document as base64, or the invoice PDF. |
| `debt_ws_note` | POST | staff | Add a note (`body`, `note` or `text`). An optional `promise_date` pauses the steps until that date and logs a promise. |
| `debt_ws_decide` | POST | owner | `action: send` runs the guarded send. A template send (no `suggestion_id`) must carry `amount`, the amount its draft was written for, or it is refused with `amount_required`. `skip` marks the due step done for this cycle. `dismiss` closes a pending suggestion, such as an agent flag. `step: "manual"` sends a manual text (see "Manual texts" below). |
| `debt_ws_set_category` | POST | owner | `says_paid`, `rectification` (through `updateJobStatus`, source `debt_workshop`, only when the card is not already in Rectification) or `clear` (removes says paid). Works with no `suggestion_id` (the manual buttons). With `suggestion_id`, a move is marked accepted; `clear` marks it dismissed ("Keep chasing"). |
| `debt_ws_link_contact` | POST `{xero_invoice_id, ghl_contact_id}` (`job_id` still accepted) | owner | Links the invoice's PAYER. A neighbour's contact goes on their own `job_contacts` row and never touches `jobs.ghl_contact_id`; the primary client (or a `job_id`-only call) sets `jobs.ghl_contact_id` as before. Replacing a different contact needs `replace: true`. Refuses `contact_belongs_to_other_payer` (another payer's contact on this job), `payer_not_on_job` (a neighbour with no `job_contacts` row) and `job_mismatch`. |
| `debt_ws_statement_preview` | GET `company_key` | staff | The statement HTML, its invoices, total and To address. An alias contact id reads as its canonical company. |
| `debt_ws_statement_send` | POST | owner | Emails the statement. Refused unless sending is on, an address is set, and it has not been sent this week. Xero is re-checked live first (a failed read refuses), and paid invoices are dropped. Then every invoice left is checked against the bank feed: a possible payment refuses with `possible_payment`, listing which invoices, unless `override_possible_payment: true` (logged). |
| `debt_ws_jan_list` | GET | staff | This week's visit list: live while open, stored once locked. |
| `debt_ws_jan_list_remove` | POST | owner | Takes one share off this week's list. |
| `debt_ws_jan_list_lock` | POST | server key | The Friday cron. Does nothing unless `jan_list_auto_send` is on. |
| `debt_ws_jan_list_send` | POST | server key | The Sunday cron. Does nothing unless `jan_list_auto_send` and sending are both on. A failed live Xero read fails the list (`xero_unavailable`), never sending from our copy. An item with a possible payment in the bank feed is dropped and logged as `send_refused` on its share; the rest still go (`dropped[]` in the result). No bank feed at all fails the list (`bank_check_unavailable`). |
| `debt_ws_agent_queue` | GET | server key or owner | Items for the agent, each with its bundle. Returns no items while `agent_enabled` is off, and none (with `blocked: "bank_feed_unavailable"`) while the bank feed cannot be read. A held message (`unplaced: true`) carries `candidate_job_count`; with more than one candidate job it is also `context_only: true`, and each item carries `held_message_rule`. A held message that is also in the payer's GoHighLevel cache shows once, as the held copy with these marks. Messages are ordered by parsed time; at one instant a held message comes after an unmarked one, so it counts as the newer. |
| `debt_ws_report` | GET | staff | The live debt report, built fresh on every read: `report` (every figure as data), `html` (the page the Debt tab shows), `delivery` (from, to, cc, `auto_send`, `sending_on`, `viewer_is_owner`, `can_send`, `why_not`), `last_sent` and `last_attempt`. See "The debt report". |
| `debt_ws_report_pdf` | GET | staff | The same report as a PDF: `filename`, `content_type`, `pdf_base64`, `page_count`. |
| `debt_ws_report_send` | POST (no fields) | owner | Emails the report PDF to the report recipients. Refused unless sending is on (`sending_off`), the recipients are set and all ours (`no_recipients`, `recipient_not_internal`), and no manual report went in the last two minutes (`recently_sent`). Built fresh at the moment of sending. |
| `debt_ws_set_company_terms` | POST `{company_key, days}` | owner | Sets one company's terms: `days` a whole number from 0 to 120, or `null` to put the company back on the default (10). `company_key` is the key the overview gives the company (an alias contact lands on its canonical company). One database call (`debt_ws_set_company_terms()`), recorded in `updated_by` and `updated_at` on the settings row. Returns `company_key`, `terms_days`, `terms_default`, `default_days`. |
| `debt_ws_report_auto` | POST | server key | The Wednesday 14:00 (2pm) Perth cron. Does nothing unless `report_auto_send` and sending are both on (`sent: false` with `reason`). One auto report per week. Refuses (`xero_copy_stale`, 409) when our Xero copy is more than 20 minutes old. |
| `debt_ws_agent_submit` | POST | server key or owner | Stores a `draft`, `move` or `flag`, or records `no_action`. Every submit stamps `agent_reviewed_at`. A `move` whose payer's newest inbound message is held on no job with more than one candidate job is stored as a `flag` to Shaun instead (`move_refused` in the result); a move is refused with `conversation_unreadable` (503) when those messages cannot be read, including when the read of the held messages fails (the conversation reader's `held_read_failed`). Nothing is stored or stamped then. Drafts, flags and `no_action` are not checked against the messages. |

A refusal is `{ok: false, code, error}`, with a plain reason in `error`. The codes include:
- `sending_off`, `not_owner`, `owner_not_set`, `operator_access_required`, `amount_required`;
- `part_paid`, `paid`, `not_open`;
- `possible_payment` (it also carries `possible_payments[]`);
- `already_sent`, `step_not_due`, `payer_not_linked`, `no_email`, `nothing_due`;
- `text_not_allowed`, `xero_unavailable`, `bank_check_unavailable`;
- the debt report: `no_recipients`, `recipient_not_internal`, `recently_sent`, `report_pdf_failed`, `email_failed`;
- `send_refused_by_guard`, `send_not_confirmed`.

### The guarded send (`debt_ws_decide` send, and stage 5 auto-send)

The checks run in this order. A refusal is logged to `debt_ws_log` as `send_refused`.

1. The owner is the caller, and sending is effectively on.
2. The text passes the guard:
   - no long dash and no emoji;
   - no talk of legal action, debt collectors or credit reporting;
   - no unfilled blank;
   - 1,600 characters or fewer.
3. The invoice is a homeowner invoice that is still open and is chased, and its PAYER has a GHL contact (`payer_not_linked`). The text goes to the payer's own contact (a neighbour's from their `job_contacts` row), with the job named so the contact/job guard runs (see the payer below).
4. The step is the one due now. A reply step (`reply_says_paid`, `reply_promise` or `reply_problem`) needs its suggestion instead, and is not held by Says paid or Rectification.
5. The step has not been sent already this cycle.
6. A live Xero read of the invoice:
   - it is AUTHORISED with an amount due above zero;
   - the amount due is not below the amount the draft was written for.
7. The bank feed:
   - unreconciled RECEIVE transactions from the invoice date minus one day, from the cached feed (see the notes below);
   - a feed that cannot be read, or does not reach back that far, refuses with `bank_check_unavailable`;
   - any amount within $1.00 refuses with `possible_payment`;
   - `override_possible_payment: true` ("Send anyway") is logged with the matches.
8. The claim: a `debt_ws_sends` row in status `sending`, unique per share, cycle and step.
9. The text goes through `sendChaseSms`. That path sends from 771, keeps the SES fence and the contact/job match guard, and also logs to `payment_chase_logs`.
   - A guard refusal releases the claim, because nothing was sent.
   - A send that is not confirmed keeps the claim, so the step can never be texted twice.

### Manual texts (approved 16 Oct 2026)

The Debt tab's job screen is a chat window: the proposed step's text sits in the reply box, and Shaun may instead type his own text (a reply to "I'll pay Friday", say). That text is a **manual text**, not a step.

- **Shape:** `debt_ws_decide {xero_invoice_id, step: "manual", action: "send", text, channel: "sms", amount, client_ref}`. `amount` is the amount owing the screen showed (required, `amount_required`); `client_ref` is a UUID the screen makes once per message. No `suggestion_id`, and it cannot be skipped. `client_ref` on any other step is refused.
- **Same guarded send:** every check above runs (sending on, owner, the text guard, homeowner and open and chased, the payer's contact, live Xero with the amount as the bar, the bank feed with Send anyway, 771 through `sendChaseSms`). Step 4 does not apply.
- **Allowed while chasing is paused** (Shaun decided 16 Oct 2026): says paid, rectification, a promise to pay still ahead, and day 21 (Jan's visit list, or the hold for a progress payment) pause the planned steps only, so Shaun can still reply in his own words ("thanks, we'll keep an eye out for it"). The planned step stays refused (`step_not_due`) while paused.
- **Still blocked** (`not_chased_by_text`): a company invoice (the Monday statement), a contact we never chase, and an invoice that is no longer open (paid, nothing owing); the live Xero check refuses one paid since. `debt_ws_job.manual_text` (`manualTextBlock`) gives the same answer, so the screen says why in place of its reply box.
- **Never a step:** the claim row's step is `manual:<client_ref>`, which no ladder step matches, so the ladder never counts it as done and the due step stays due. The same `client_ref` is never texted twice (a double tap, or a retry after a send that is not confirmed, is `already_sent`); a new message gets a new reference.
- **Logged as manual:** `debt_ws_log` kind `text_sent`, step `manual`, the text as `body`, and `meta.manual: true` with `meta.client_ref`. A refusal is logged as `send_refused` with step `manual`. No migration: both columns are free text.

### The payer (shared fences)

On a shared fence one job has several payers: the job's client (share A, the primary `job_contacts` row) and each neighbour (share B, C, ...). Each invoice belongs to one of them, and the workshop uses THAT person's own contact, phone and conversation, never the job's (the job's contact is the primary client's). `debt_ws_payer.ts` finds the payer in this order, and never by name alone:

1. the active `job_contacts` row whose `xero_contact_id` is the invoice's Xero contact;
2. the row whose `contact_label` is the reference's share letter (`SWF-26624-B-BAL` is B);
3. the job's client, when the invoice's Xero contact is `jobs.xero_contact_id`;
4. the job's client, when the reference has no letter (or A) and the job has no neighbour rows.

Otherwise the payer is not resolved (the Xero name only, nothing to link or text). For the primary, the GHL contact, phone and email fall back to the job's.

- **Overview:** each row carries `payer_contact`; `ghl_linked` means the payer is linked.
- **Job view:** the payer's phone, `job.shares[]` (label, payer name, owing, paid), and the payer's own messages. A message is the payer's when its GHL contact (`contact_id`), an email address or a phone is theirs. A payer with no GHL contact gets no conversation (`reason: "payer_not_linked"`), never the job's thread in its place. `getJobConversation` reads a neighbour payer's own cached GHL thread too (`extra_contact_ids`, accepted only for contacts on that job's `job_contacts` rows).
- **Link:** a neighbour's contact goes on their `job_contacts` row; the job's link is untouched. Candidates are searched by the payer's own phone and email.
- **Sending:** the text goes to the payer's own GHL contact, never the job's, with `job_id` passed. `sendChaseSms` (`assertGhlContactMatchesResolvedJob`) and ghl-proxy's `send_sms` contact/job match accept a contact that is `jobs.ghl_contact_id` OR the `ghl_contact_id` of a live `job_contacts` row (status empty or `active`, no `removed_at`) on the SAME job (Captain ruling, 12 Oct 2026; `_shared/job_contact_membership.ts`). A contact on another job's list, a removed row, or a contact on no list is refused as before (`send_refused_by_guard`); a failed contact-list read fails closed. The SES fence, the 10-minute duplicate block and the 771 sender default are unchanged. `sendClientUpdate` with `job_contact_id` now names the job too, so that path runs the same guard.
- **Jan's list:** the payer's label, the payer's phone and the site address. **The agent:** the payer's contact, messages and `send_block`. Statements are unchanged.

## Receivables (approved 4 Nov 2026)

Shaun approved it on 4 Nov 2026 (spec: the local `.lavish/receivables-build-spec.md`). It replaces "Total owed to us" on the desk and in the report. Display only: the chase steps, the holds, the statements and Jan's list work as before. The one rule change to who gets chased is the per-company terms.

- **Receivables** is every unpaid invoice in our Xero copy (ACCREC, AUTHORISED, amount due above zero), leaving out test invoices (a `SAMPLE-` reference), which are named apart. `debt_ws_report.ts` `receivablesFrom` builds it from `placeOpenInvoices`; the desk (`debt_ws_overview.receivables`) and the report use the same function, so they always agree. Its lines add up to it to the cent (`adds_up`).
- **Debt** (`debt_ws_receivables.ts` `receivableOfEntry`):
  - a final invoice whose job status is Rectification, Complete, Final payment, Get review, Invoiced, Paid or Archived (the ops dashboard job status; GoHighLevel pipeline stages are not used); pay by the invoice date, or the day the job left rectification when that is later (the tab's day 0);
  - a company invoice (the tab's account kind: make-safes, repairs, roof reports, insurance, or a company-named invoice with no job); pay by the invoice date plus that company's terms.
- **Other receivables:** deposits, go-ahead deposits, materials, progress payments, planning fees and extra labour (the tab's progress kind and go-ahead deposits). Pay by Xero's due date (the invoice date when Xero gives none).
- **Write-off list:** the not-chased contacts (Emergency Trade Services, Builderwest), "for us to check whether to write off". Their invoices stay in Receivables.
- **Needs a look:** what the tab already marks so, anything no rule placed, and a final invoice on a job not yet marked Complete or Invoiced (still chased as before: only its money line changes).
- **Overdue:** days after the pay-by date (`days_overdue`, 0 when not due). Debt overdue is Debt with 1 day or more; bad debt is 21 days or more. The bands are 1 to 7, 8 to 20 and 21 days or more (bad debt). The word is always "Overdue", never "late".
- **Company terms:** `debt_ws_settings.company_terms`, `{canonical company key: days}`, and `company_terms_default` (10). Seeded MLB (`96abb9b3...`, which covers its alias contacts) 10 days and Ambrose Construct Group (`eb7bc4e3...`) 14 days. A company's terms move its invoices' due date, so its day, category and statement "past due" move with it (this is the one chase change). ops-api reads the terms apart from the other settings (`readCompanyTerms`): before the migration, or if the read fails, every company is on 10 days (`settings.terms_status: "unavailable"`) and the tab still loads.
- **This week** on the desk (`week_money`): customer payments applied in Xero (`debt_ws_payments_between`) against receivables raised with an invoice date in the Monday-to-Sunday week, both including GST, test invoices left out. Null when either cannot be read.
- A held invoice (says paid, rectification, or a promise to pay) keeps its pay-by date: when past it, it counts as overdue, and the hold shows on its row.

## Total owed to us and the check against Xero

Shaun approved both on 20 Oct 2026. "Total owed to us" was replaced by Receivables on 4 Nov 2026; `total_owed` stays on the overview for a screen that has not reloaded.

- **Total owed to us** (`debt_ws_overview.total_owed`, `debt_ws_report.ts` `totalOwedFrom`) is every open invoice in our Xero copy (ACCREC, AUTHORISED, amount due above zero), so it equals Xero's open receivables once the copy matches Xero. Its lines add up to it to the cent (`adds_up`): **Debt** (the chart's figure, the five categories, not-chased left out), **Not due yet**, **Progress payments** (not due yet), **Companies on statements** (not due yet), **Deposits** (go-ahead payments), **Not chased**, **Needs a look**, and **Test invoices** and **Not placed** only when there are any. The lines are the debt report's own buckets (`placeOpenInvoices`), with not due yet shown in three parts by the kind the tab already gives each invoice; no new rule. Each line carries its `invoices[]`. It is display only: nothing in it is chased, and the chart, the chase rules, the texts and every gate are unchanged.
- **The check against Xero** (`debt_ws_overview.xero_check`): xero-sync compares our copy with Xero's own open list at most once an hour (`xero-sync/xero_mirror_check.ts`, run at the end of `sync_invoices`, or now with `?action=check_invoice_mirror`) and records the result in `xero_mirror_checks`. `status` is `matches`, `differs` (with `differences[]` and the invoice numbers in `words`) or `not_checked`; `drafts` is Xero's DRAFT sales invoices (never in the total); `last_failed` says when a newer attempt did not finish. A check that cannot be read shows "Could not read the check against Xero", never "Matches Xero", and never stops the tab.
- **What the check heals:** where Xero says money is owed and our copy disagrees (marked DELETED or VOIDED, or a different amount), it re-reads that invoice from Xero by its id and copies Xero's answer through `reconcileXeroInvoice`, at most 25 a run. It never writes to Xero, never marks an invoice deleted, voided or paid itself, never sets an amount due to zero (so it never fires the `invoice.paid` trigger), and never inserts an invoice our copy has never seen (that is reported for a person). An invoice our copy counts as owed that Xero does not list is only reported; the hourly stale check re-reads it by id.
- **Why:** until 10 Sep 2026 (#797) the stale check marked an invoice DELETED with nothing owing whenever its read from Xero failed for any reason. Five invoices open in Xero stayed that way (INV-0034, INV-0177, INV-0352, INV-0704, INV-0938, $3,352.48 on 20 Oct 2026), because nothing re-read them. ops-api `void_invoice` likewise now copies only the status Xero's answer names (`xero_void_mirror.ts`).
- **The debt report** shows the check line under the tie in "Where the receivables sit", in the notes and in the email summary.

## The switches

Every switch starts off. Turn one on only when Shaun says so.

| Switch | Where | Effect |
|---|---|---|
| Owner | env `DEBT_WS_OWNER_USER_IDS` (comma-separated users.id), else `debt_ws_settings.owner_user_ids` | Who may send, approve statements, link contacts, move cards and remove from Jan's list. The env value wins when it is set; a value with no valid id means nobody. The migration copies the debt desk's owner list (Shaun). |
| Tab | `debt_ws_settings.tab_visible` | Shows the Debt tab to everyone. Without it, the tab appears only with `ops.html?debt=1`. |
| Sending | `debt_ws_settings.sending_enabled = true` | Texts, statements and Jan's Sunday text. The database switch alone turns manual sending on (Shaun decided 14 Oct 2026). The old env `DEBT_WS_SENDING_ENABLED` is retired and ignored. |
| Agent | `debt_ws_settings.agent_enabled` | The agent queue hands out items. The agent itself is a Claude routine; its setup is in the playbook README. |
| Auto-send | env `DEBT_WS_AUTO_SEND_ENABLED=true` AND `debt_ws_settings.auto_send_steps` (e.g. `{"d1": true}`) AND sending on (the database switch) | Stage 5: a plain agent draft for a step switched on, with no proposed move and no possible payment, goes through the same guarded send as `agent-auto`. |
| Jan's list | `debt_ws_settings.jan_list_auto_send` | The Friday 09:00 lock and the Sunday 19:00 text to Jan (the text also needs sending on). |
| Not chased | `debt_ws_settings.not_chased_contacts` | Contacts that stay in the totals but are never texted or sent a statement. Each entry is a contact name (whole words) or a Xero contact id (matching the invoice's contact or its canonical company). Seeded with Emergency Trade Services and Builderwest, by name and by id. |
| Statement addresses | `debt_ws_settings.statement_emails` | A JSON map from the canonical Xero contact id to an accounts email; a contact-name key is a fallback only. Seeded with Major Loss Builders (`96abb9b3...`) and AJ Building & Restoration (`71a5e645...`). |
| Report recipients | `debt_ws_settings.report_recipients` (To) and `report_cc` (Cc) | Who the debt report is emailed to. Defaults: `marnin@secureworkswa.com.au`, cc `shaun@secureworkswa.com.au`. Our own domain only: the database refuses any other address (`debt_ws_settings_report_addresses_internal`), and ops-api and send-outlook-email check again. |
| Report auto-send | `debt_ws_settings.report_auto_send` AND sending on | The Wednesday 2pm (14:00 Perth) email of the debt report, after the 13:55 Xero refresh. Default OFF. |
| Company terms | `debt_ws_settings.company_terms` and `company_terms_default` | Days each company has to pay from the invoice date. Changed by the owner on the Debt tab (`debt_ws_set_company_terms`). Seeded MLB 10, Ambrose Construct Group 14, every other company 10. |
| Company aliases | `debt_ws_settings.company_aliases` | A JSON map from an extra Xero contact id to the canonical one, because one builder can sit on several Xero contacts. Seeded: MLB `4d7121e3...` to `96abb9b3...`, Western Building `2a34b09f...` to `29d70cdc...`, Builderwest `aff63429...` to `c3a479ce...`. |

To turn sending on (Shaun decided 14 Oct 2026 that the database switch alone decides it):
1. Run `UPDATE public.debt_ws_settings SET sending_enabled = true, updated_by = '<who>' WHERE id = 1;`.

To turn it off, set `sending_enabled = false`. The env `DEBT_WS_SENDING_ENABLED` is retired: setting or unsetting it changes nothing. Automatic sending still needs its own env `DEBT_WS_AUTO_SEND_ENABLED=true` as well as the step switch.

## The cron

pg_cron runs in UTC; Perth is UTC+8 with no daylight saving.

| Job | Schedule (UTC) | Perth | Calls |
|---|---|---|---|
| `debt-ws-jan-list-lock` | `0 1 * * 5` | Friday 09:00 | `public.trigger_debt_ws_jan_list('debt_ws_jan_list_lock')` |
| `debt-ws-jan-list-send` | `0 11 * * 0` | Sunday 19:00 | `public.trigger_debt_ws_jan_list('debt_ws_jan_list_send')` |
| `debt-ws-report-refresh` | `55 5 * * 3` | Wednesday 13:55 | `public.trigger_debt_ws_report_refresh()`: one extra xero-sync `sync_invoices`, a no-op unless `report_auto_send` is on |
| `debt-ws-report-auto` | `0 6 * * 3` | Wednesday 14:00 | `public.trigger_debt_ws_report_auto()`, a no-op unless `report_auto_send` is on |

- **How it calls ops-api:** the trigger posts to ops-api with `Bearer sw_service_key()`, like `20260911060000_ses_report_trigger_runs.sql`.
- **When it calls:** only while `jan_list_auto_send` is on. ops-api checks the switches again before it does anything.
- **The visit day:** the list is for the Monday after the send. Jan's mobile is read from the one `users` row whose first name is Jan, and the text goes through the same staff SMS path the debt desk used (`sendSmsViaGhlWithReceipt`, the 771 default).

## Notes for the next change

- **Due dates** (the chase) ignore Xero's printed due date: a final is due on its invoice date, a progress payment 7 days later, and a company invoice after that company's terms (10 days unless set otherwise; Shaun, 8 Oct and 4 Nov). The money view's pay-by date for Other receivables is Xero's due date (see "Receivables").
- **`share_key`** is the Xero invoice id. **`company_key`** is the canonical Xero contact id, after `company_aliases` (lower case); `name:<normalised name>` for an invoice with no contact id. Company notes and statements sit on it.
- **The bank feed** is one read, cached for 15 minutes within a Perth day and shared by sends, statements, Jan's list, the job view and the agent:
  - it reaches back to the oldest open invoice in our Xero copy (minus one day), so an invoice of any age is checked, and each invoice is matched in memory from its own date;
  - it pages 100 at a time, keeps only RECEIVE rows (`listXeroBankTransactions` has no type filter), and stops at 10 pages, with at most 30 page calls a minute, well inside Xero's 60;
  - a read cut short at 10 pages only vouches for the days it reached: an older invoice is `bank_check_unavailable` for a send and `possible_payments_status: "partial"` on the job view.
- **Pay links** (Xero online-invoice URLs) are cached on `debt_ws_states.pay_link`. A request fetches at most 20 new ones.
- **Invoice kinds:** final endings are FIN, FINBAL or BAL with up to three digits (FIN25, FINBAL50), FINAL and PRIVATE, with a description starting Balance, Remaining or Remainder. Not final: DEP, MAT and PROG with up to three digits, PLAN and VAR. An ending and description that disagree (FIN25 with "Deposit") still fall to "needs a look".
- **Tests:** `deno test --allow-read --allow-env supabase/functions/ops-api/debt_ws_rules_test.ts supabase/functions/ops-api/debt_ws_store_test.ts supabase/functions/ops-api/debt_ws_deps_test.ts supabase/functions/ops-api/debt_ws_actions_test.ts supabase/functions/ops-api/debt_ws_payer_test.ts supabase/functions/ops-api/debt_ws_report_test.ts supabase/functions/ops-api/debt_ws_report_pdf_test.ts` (CI runs the same), plus `job_conversation_payer_threads_test.ts` for the conversation reader.
- **Migration contracts:** `supabase/tests/migration-contracts/20261008170000_debt_workshop/`, `20261015170000_debt_ws_report/`, `20261016180000_debt_ws_report_wednesday/`, `20261020150000_xero_mirror_checks/` and `20261105120000_debt_ws_receivables/`. The check itself: `xero-sync/xero_mirror_check_test.ts`.

## The debt report

Shaun approved it on 15 Oct 2026 (plan: the local Lavish page `debt-collection-fresh/.lavish/debt-report-button-plan.html`), and approved the rebuild as "Debt and receivables" on 4 Nov 2026 (`DEBT_REPORT_VERSION` `debt-report/v2`).

- **On the screen:** a "Debt report" button, top right of the Debt tab, opens the live report as its own view (`debt_ws_report`). It is built fresh every time it opens. On that view: **Download PDF** (`debt_ws_report_pdf`) and **Send to Marnin** (`debt_ws_report_send`, owner only, a second click to confirm), and "Last sent to Marnin: <day, time>".
- **What is in it** (`debt_ws_report.ts` `buildDebtReport`), titled "Debt and receivables":
  - the top numbers: Receivables, Debt overdue, Bad debt (21 days or more), Other receivables (with how much of it is overdue), and cash at bank (the total and the total less provisions, from Xero's Bank Summary read live);
  - "Where the receivables sit": debt not due, debt overdue, other not due, other overdue, the Write-off list and (when there are any) Needs a look, with the tie to our Xero copy to the cent; test invoices are left out and named; then the check against Xero;
  - "Debt, by how overdue": not due, 1 to 7, 8 to 20 and 21 days or more (bad debt), with Private and Companies columns;
  - "Coming due in the next 7 days", Debt and Other receivables shown apart;
  - "What happened this week" (the 7 days to today): invoices paid in full (at their total, deposits included), and the tab's own log: texts sent, promises to pay, notes, category changes and Jan's visit lists;
  - a terms note (each company with its own terms, every other company 10 days; private finals due on the invoice date; Other receivables on Xero's due date);
  - "Every invoice, by how overdue it is": who, invoice, type, amount, invoiced, pay by and days overdue, most overdue first, with any hold on the row;
  - notes (sources, the Debt and Other rule, the cross-check, holds, the bank feed and the week).
  - Dropped on 4 Nov 2026: the bank account list, the money-in split, debt by job type, aging and the companies table.
- **Same rules as the tab.** The report reads the tab's own book (`loadBook`, given the same open invoices it ties to Xero), and its Receivables is the desk's (`receivablesFrom`). A test checks the report's lines equal the desk's, and that the tab's category totals still match (`tie.tab_match`).
- **Reads that fail** never stop the report: the bank balances, payments or bank feed show as "not read" with a note.
- **The PDF** is drawn server side with jsPDF (`debt_ws_report_pdf.ts`), the same approach as the purchase order PDF: portrait throughout: page 1 is the summary, then every invoice and the notes, with "Page x of n" on each.
- **The email** goes from admin@ through send-outlook-email: a short plain summary in the body (Receivables and the tie, debt overdue and bad debt, other receivables, the Write-off list, coming due, this week, cash at bank and the check against Xero) and the PDF attached, as "Debt and receivables <date>.pdf", subject "Debt and receivables: <day>". Who it goes to: `report_recipients`, cc `report_cc` (Marnin, cc Shaun).
- **The internal allow-list.** send-outlook-email's PDF fence refuses any PDF without an invoice or job document behind it. The debt report is the one exception, fenced to this route: the body must say `internal_report: "debt_report"`, be a plain send with no job, invoice or document, come from and go only to `@secureworkswa.com.au` (To, Cc and Bcc), and carry its PDF inline. A body that says `internal_report` but breaks any rule is refused (`internal_report_not_allowed`). Every other email is unchanged. Tests: `send-outlook-email/ses_delivery_fence_test.ts`.
- **Who:** anyone who can see the Debt tab (staff) reads it and downloads the PDF; only the workshop owner sends it, and only while `sending_enabled` is on.
- **The record:** each send is claimed first in `debt_ws_reports` (`sending`), then settled `sent` or `failed`, with a copy of the HTML and the attached PDF (base64 and its SHA-256), the subject, the summary and the headline totals. An email that may have gone stays `sending` and is never retried by itself. Each send also writes an `email_sent` line on `debt_ws_log` under share_key `debt-report`; a refusal writes `send_refused`.
- **The Wednesday 2pm auto-send** (`report_auto_send`, default off) runs `debt_ws_report_auto` from the `debt-ws-report-auto` cron at 14:00 Perth on a Wednesday (Shaun, 4 Nov 2026; it was Monday 08:00 until `20261016180000`, then Wednesday 12:00 until `20261105120000`). It also needs sending on, and sends at most once a week (a unique index on `debt_ws_reports`). The week is still Monday to Sunday, Perth: `week_start` is that week's Monday, so a Wednesday send files under the Monday two days before.
- **Consolidate first.** Every report (the view, the PDF and each send) is built fresh at that moment from the Debt tab's own book, with the bank balances read live from Xero. The invoices come from our Xero copy, which xero-sync brings up to date every 15 minutes (cron `xero-invoice-sync`, at 4, 19, 34 and 49 past the hour). On a Wednesday the cron `debt-ws-report-refresh` asks xero-sync for one extra invoice sync at 13:55, clear of the 13:49 and 14:04 runs (a run takes under a minute), so the copy is about five minutes old at 14:00. The sync can take close to a minute, too long to wait for inside the report call, so the refresh is scheduled ahead instead.
- **The freshness check.** The copy's age is the start of the last invoice sync that read every page (`xero_sync_state` key `sync_invoices`, `cursor_at`; the newest `xero_invoices.synced_at` only when that row is missing). A send, automatic or by hand, refuses with `xero_copy_stale` (409) when that is more than 20 minutes old (`DEBT_WS_REPORT_MAX_COPY_AGE_MS`) or unknown: nothing is sent, no PDF is drawn, the claim settles as `refused` with the reason (so it never holds the week's auto slot) and a `send_refused` line goes on the log. The view says the same in `delivery.why_not`, so **Send to Marnin** stays off until the next sync. A missed 13:55 refresh still leaves the 13:49 run inside the limit; if both are missed the Wednesday report does not go, and Shaun can send it by hand once the copy is fresh again.
- **Deploy order:** the migration applies before the matching ops-api (the normal merge lane does that). Until it is applied, the report still reads (payments show as not read) but cannot be sent. The Wednesday change (`20261016180000`) has no order to keep: ops-api's freshness check reads `xero_sync_state`, live since September, and the migration only moves cron jobs. The receivables change (`20261105120000`) has no order to keep either: ops-api reads the terms apart and falls back to 10 days for every company until the migration applies; only changing a company's terms needs it.
