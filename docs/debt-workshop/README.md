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
| `debt_ws_actions.ts` | The 15 actions, the guarded send, and `runDebtWsAction` (the method, staff, owner and server-key checks). |
| `debt_ws_deps.ts` | Builds the dependencies from what `index.ts` owns. |
| `index.ts` | Wiring only: one `case` block that injects `sendChaseSms`, `getJobConversation`, `getToken`, `xeroReadGet`, `updateJobStatus`, the Outlook send, `getInvoicePdf`, `searchGHLContacts`, the staff SMS path and the job document reads. |
| `supabase/migrations/20261008170000_debt_workshop.sql` | The seven tables, row-level security, and the two cron jobs. Rollback: `supabase/rollbacks/20261008170000_debt_workshop_down.sql`. |

## The actions

Who may call each action:
- **staff:** a signed-in staff user (admin, owner or ops_manager). The server key is refused.
- **owner:** the workshop owner, signed in.
- **server key:** only the two Jan list crons, and the agent queue and submit (which the owner may also call).

| Action | Method | Who | What it does |
|---|---|---|---|
| `debt_ws_overview` | GET | staff | Everything W1 needs: categories, rows, companies, not due, not chased, needs a look, paid this week, Jan's list. |
| `debt_ws_job` | GET `xero_invoice_id` | staff | Everything W2 needs: row, job, story, invoices, documents, conversation (100), notes, ladder, suggestion (a pending agent draft or move, else the template draft), flags, possible payments, contact candidates and the pay link. |
| `debt_ws_document` | GET `job_id, document_id` (or `xero_invoice_id`) | staff | One job document as base64, or the invoice PDF. |
| `debt_ws_note` | POST | staff | Add a note (`body`, `note` or `text`). An optional `promise_date` pauses the steps until that date and logs a promise. |
| `debt_ws_decide` | POST | owner | `action: send` runs the guarded send. A template send (no `suggestion_id`) must carry `amount`, the amount its draft was written for, or it is refused with `amount_required`. `skip` marks the due step done for this cycle. `dismiss` closes a pending suggestion, such as an agent flag. |
| `debt_ws_set_category` | POST | owner | `says_paid`, `rectification` (through `updateJobStatus`, source `debt_workshop`, only when the card is not already in Rectification) or `clear` (removes says paid). Works with no `suggestion_id` (the manual buttons). With `suggestion_id`, a move is marked accepted; `clear` marks it dismissed ("Keep chasing"). |
| `debt_ws_link_contact` | POST | owner | Sets `jobs.ghl_contact_id`. Replacing a different contact needs `replace: true`. |
| `debt_ws_statement_preview` | GET `company_key` | staff | The statement HTML, its invoices, total and To address. An alias contact id reads as its canonical company. |
| `debt_ws_statement_send` | POST | owner | Emails the statement. Refused unless sending is on, an address is set, and it has not been sent this week. Xero is re-checked live first (a failed read refuses), and paid invoices are dropped. Then every invoice left is checked against the bank feed: a possible payment refuses with `possible_payment`, listing which invoices, unless `override_possible_payment: true` (logged). |
| `debt_ws_jan_list` | GET | staff | This week's visit list: live while open, stored once locked. |
| `debt_ws_jan_list_remove` | POST | owner | Takes one share off this week's list. |
| `debt_ws_jan_list_lock` | POST | server key | The Friday cron. Does nothing unless `jan_list_auto_send` is on. |
| `debt_ws_jan_list_send` | POST | server key | The Sunday cron. Does nothing unless `jan_list_auto_send` and sending are both on. A failed live Xero read fails the list (`xero_unavailable`), never sending from our copy. An item with a possible payment in the bank feed is dropped and logged as `send_refused` on its share; the rest still go (`dropped[]` in the result). No bank feed at all fails the list (`bank_check_unavailable`). |
| `debt_ws_agent_queue` | GET | server key or owner | Items for the agent, each with its bundle. Returns no items while `agent_enabled` is off, and none (with `blocked: "bank_feed_unavailable"`) while the bank feed cannot be read. |
| `debt_ws_agent_submit` | POST | server key or owner | Stores a `draft`, `move` or `flag`, or records `no_action`. Every submit stamps `agent_reviewed_at`. |

A refusal is `{ok: false, code, error}`, with a plain reason in `error`. The codes include:
- `sending_off`, `not_owner`, `owner_not_set`, `operator_access_required`, `amount_required`;
- `part_paid`, `paid`, `not_open`;
- `possible_payment` (it also carries `possible_payments[]`);
- `already_sent`, `step_not_due`, `no_contact`, `no_email`, `nothing_due`;
- `text_not_allowed`, `xero_unavailable`, `bank_check_unavailable`;
- `send_refused_by_guard`, `send_not_confirmed`.

### The guarded send (`debt_ws_decide` send, and stage 5 auto-send)

The checks run in this order. A refusal is logged to `debt_ws_log` as `send_refused`.

1. The owner is the caller, and sending is effectively on.
2. The text passes the guard:
   - no long dash and no emoji;
   - no talk of legal action, debt collectors or credit reporting;
   - no unfilled blank;
   - 1,600 characters or fewer.
3. The invoice is a homeowner invoice that is still open and is chased, and its job has a GHL contact.
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

## The switches

Every switch starts off. Turn one on only when Shaun says so.

| Switch | Where | Effect |
|---|---|---|
| Owner | env `DEBT_WS_OWNER_USER_IDS` (comma-separated users.id), else `debt_ws_settings.owner_user_ids` | Who may send, approve statements, link contacts, move cards and remove from Jan's list. The env value wins when it is set; a value with no valid id means nobody. The migration copies the debt desk's owner list (Shaun). |
| Tab | `debt_ws_settings.tab_visible` | Shows the Debt tab to everyone. Without it, the tab appears only with `ops.html?debt=1`. |
| Sending | env `DEBT_WS_SENDING_ENABLED=true` AND `debt_ws_settings.sending_enabled = true` | Texts, statements and Jan's Sunday text. Both must be on. |
| Agent | `debt_ws_settings.agent_enabled` | The agent queue hands out items. The agent itself is a Claude routine; its setup is in the playbook README. |
| Auto-send | env `DEBT_WS_AUTO_SEND_ENABLED=true` AND `debt_ws_settings.auto_send_steps` (e.g. `{"d1": true}`) AND sending on | Stage 5: a plain agent draft for a step switched on, with no proposed move and no possible payment, goes through the same guarded send as `agent-auto`. |
| Jan's list | `debt_ws_settings.jan_list_auto_send` | The Friday 09:00 lock and the Sunday 19:00 text to Jan (the text also needs sending on). |
| Not chased | `debt_ws_settings.not_chased_contacts` | Contacts that stay in the totals but are never texted or sent a statement. Each entry is a contact name (whole words) or a Xero contact id (matching the invoice's contact or its canonical company). Seeded with Emergency Trade Services and Builderwest, by name and by id. |
| Statement addresses | `debt_ws_settings.statement_emails` | A JSON map from the canonical Xero contact id to an accounts email; a contact-name key is a fallback only. Seeded with Major Loss Builders (`96abb9b3...`) and AJ Building & Restoration (`71a5e645...`). |
| Company aliases | `debt_ws_settings.company_aliases` | A JSON map from an extra Xero contact id to the canonical one, because one builder can sit on several Xero contacts. Seeded: MLB `4d7121e3...` to `96abb9b3...`, Western Building `2a34b09f...` to `29d70cdc...`, Builderwest `aff63429...` to `c3a479ce...`. |

To turn sending on:
1. Set the Supabase function secret `DEBT_WS_SENDING_ENABLED` to `true`. Secrets reach the function on its next request; no deploy is needed.
2. Run `UPDATE public.debt_ws_settings SET sending_enabled = true, updated_by = '<who>' WHERE id = 1;`.

To turn it off, either one is enough.

## The cron

pg_cron runs in UTC; Perth is UTC+8 with no daylight saving.

| Job | Schedule (UTC) | Perth | Calls |
|---|---|---|---|
| `debt-ws-jan-list-lock` | `0 1 * * 5` | Friday 09:00 | `public.trigger_debt_ws_jan_list('debt_ws_jan_list_lock')` |
| `debt-ws-jan-list-send` | `0 11 * * 0` | Sunday 19:00 | `public.trigger_debt_ws_jan_list('debt_ws_jan_list_send')` |

- **How it calls ops-api:** the trigger posts to ops-api with `Bearer sw_service_key()`, like `20260911060000_ses_report_trigger_runs.sql`.
- **When it calls:** only while `jan_list_auto_send` is on. ops-api checks the switches again before it does anything.
- **The visit day:** the list is for the Monday after the send. Jan's mobile is read from the one `users` row whose first name is Jan, and the text goes through the same staff SMS path the debt desk used (`sendSmsViaGhlWithReceipt`, the 771 default).

## Notes for the next change

- **Due dates** ignore Xero's printed due date: a final is due on its invoice date, a progress payment 7 days later, and an account invoice 10 days later (Shaun, 8 Oct).
- **`share_key`** is the Xero invoice id. **`company_key`** is the canonical Xero contact id, after `company_aliases` (lower case); `name:<normalised name>` for an invoice with no contact id. Company notes and statements sit on it.
- **The bank feed** is one read, cached for 15 minutes within a Perth day and shared by sends, statements, Jan's list, the job view and the agent:
  - it reaches back to the oldest open invoice in our Xero copy (minus one day), so an invoice of any age is checked, and each invoice is matched in memory from its own date;
  - it pages 100 at a time, keeps only RECEIVE rows (`listXeroBankTransactions` has no type filter), and stops at 10 pages, with at most 30 page calls a minute, well inside Xero's 60;
  - a read cut short at 10 pages only vouches for the days it reached: an older invoice is `bank_check_unavailable` for a send and `possible_payments_status: "partial"` on the job view.
- **Pay links** (Xero online-invoice URLs) are cached on `debt_ws_states.pay_link`. A request fetches at most 20 new ones.
- **Invoice kinds:** final endings are FIN, FINBAL or BAL with up to three digits (FIN25, FINBAL50), FINAL and PRIVATE, with a description starting Balance, Remaining or Remainder. Not final: DEP, MAT and PROG with up to three digits, PLAN and VAR. An ending and description that disagree (FIN25 with "Deposit") still fall to "needs a look".
- **Tests:** `deno test --allow-read --allow-env supabase/functions/ops-api/debt_ws_rules_test.ts supabase/functions/ops-api/debt_ws_store_test.ts supabase/functions/ops-api/debt_ws_deps_test.ts supabase/functions/ops-api/debt_ws_actions_test.ts` (CI runs the same).
- **Migration contract:** `supabase/tests/migration-contracts/20261008170000_debt_workshop/`.
