# Debt book glossary

Plain-English meanings for the words used in the debt book plan. The code
behind each word is noted in brackets where it helps.

| Word | Meaning |
|---|---|
| **Debt** | Money owed to us for work that is done. It covers unpaid final invoices on finished jobs (including jobs in rectification), variations, part payments, and progress claims once the job has had its first payment. Deposits are never debt. See DECISIONS.md. |
| **Open in Xero** | Every issued sales invoice that Xero says still has money owing. It includes deposits and before-work invoices, so it is bigger than debt. (`Type=ACCREC`, `Status=AUTHORISED`, `AmountDue > 0`.) |
| **Overdue** | Past its due date and still unpaid. Days are counted using the Perth calendar date, and the due date itself is not overdue. |
| **Final invoice** | The bill for what is left once the job is done. Its reference usually ends `FINBAL`, `FINAL` or `-BAL`. |
| **Deposit** | The first invoice after a client accepts a quote, before work starts. Its reference carries `DEP`. Not debt. |
| **Progress claim** | A part-payment invoice raised during a bigger job. Its reference carries `PROG`. It becomes debt once the job has had its first payment. |
| **Variation** | Extra work agreed during the job. Its reference carries `VAR`. Debt. |
| **Part payment** | Some of an invoice paid, some still owing. The owing part is debt. |
| **Rectification** | Work is done but needs fixing before the client is happy. Its invoice is still debt. |
| **Payer** | Who we chase for an invoice: the client, MLB, AJ or another builder. A builder with two Xero contact names (MLB, AJ) is one payer. |
| **Builder** | An insurance builder who sends us work orders and pays our invoices: MLB (Major Loss Builders), AJ (AJ Building & Restoration), Emergency Trade Services, Builderwest and Western Building. Called "SES" in the code. |
| **Make-safe, roof report, repair, assessment** | The kinds of builder work we invoice. |
| **Xero** | Our accounting system, and the only truth for what is owed and what is paid. |
| **Our copy** | The backend's copy of Xero invoices, which Clear Debt reads today. It can be wrong. On 29 Sep it was missing 6 invoices. (`xero_invoices`.) |
| **Reconciled / matched** | A payment in the bank has been matched to its invoice in Xero. Until that happens, Xero still shows the invoice as owed. |
| **Clear Debt** | The debt screen in the Ops dashboard (Financials, then Clear Debt). The desk is built on it. |
| **Debt desk** | The daily workflow in this plan: the debt book, the morning list, drafts, approval, sending and the log. |
| **Debt book** | The list of every open invoice with a reason for each: debt or not, which payer, how old. It is read straight from Xero. |
| **Morning list** | The "Today" list. Everyone whose next chase step is due today, with the message already written. |
| **Draft** | A message the agent has written for Shaun to approve, edit or skip. Nothing is sent as a draft. |
| **Approve** | Shaun's yes on one message. Nothing leaves without it. |
| **Last check** | Just before a message is sent, the desk re-reads that invoice in Xero. If it has been paid since the morning, the message does not go. |
| **Chase log** | The record, against each invoice, of every text, call, visit, statement, promise and outcome. It also records who approved each one. (`payment_chase_logs`.) |
| **Outcome** | What happened after a contact: no answer, spoke, promised, disputed or says paid. |
| **Promise to pay** | A client's or builder's promise of an amount by a date. While it is open, there is no chasing. If it is missed, the invoice goes back to the top the next day. |
| **Schedule / ladder** | The fixed chase steps. Homeowners: day 1 friendly text, day 2 firm text, day 3 call, day 7 Jan. Builders: a statement after 14 days. Deposits: one friendly reminder. |
| **Jan** | The general manager. He visits clients who haven't paid by day 7. |
| **Statement** | One email to a builder's accounts team that lists all their invoices 14 or more days old. It is logged as one chase covering many invoices. |
| **Check first** | An invoice that Xero says is owed but our notes doubt, such as a duplicate or one disputed or rejected. It stays in the number but gets no draft until Shaun checks it. |
| **Fix first** | Debt on a job still in rectification. It gets no chase until the fix is done (recommended; see DECISIONS.md). |
| **Deposits list** | Unpaid deposits and other before-work invoices, kept apart from debt. Each gets one friendly reminder. |
| **Cancel list** | Once a week, the deposits with 60 days of no payment, no reply and no job progress. Shaun approves each void in one click, and the void happens in Xero. |
| **Write-off** | Deciding a debt will not be collected. Only Shaun does it, in Xero, by voiding or crediting the invoice. |
| **Switch-off** | Turning off our six old automatic money texts, which are broken or fire at the wrong time. |
| **Agent** | The AI assistant that reads Xero, builds the morning list and writes drafts. It never sends without Shaun's approval. |
| **Firstmate** | The supervising agent that applies approved changes to the live system and runs build tasks. |
| **Lavish page** | The review page where Shaun reads and marks up this plan. |
