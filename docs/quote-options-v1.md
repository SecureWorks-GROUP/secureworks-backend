# Quote options at acceptance (ruling 14, step 1)

Optional extras on a quote, ticked by the customer on the Accept page or by staff accepting by phone. The quote tool seals them in `pricing_json.optional_extras` (version 1): the options and every tickable combination, precomputed (total, GST, deposit, payment schedule, local stages, parties). The base figures never include options, so a quote without the block accepts exactly as before.

## Rules (send-quote)

| What | Where |
|---|---|
| Read and check the offer (released revision only, never the live job) | `send-quote/quote_options.ts` `readQuoteOptions` |
| Pick the ticked combination; refuse unknown, duplicate or extra ids | `chooseOptions` |
| Accepted job pricing: the combination's figures, fence `line_item`s appended | `acceptedPricing` |
| The Accept page card (tick boxes, live total and deposit from the combinations) | `quote_options_page.ts` |
| Read the offer for a document; write and read the record | `quote_options_store.ts` |

- The server never adds GST, splits a deposit or rounds: it uses the combination after checking it adds up.
- `POST /accept?token=` takes `{ option_ids }`. `POST /accept-for-customer` (identified office session, own tenant) takes `{ document_id, option_ids }` and runs the same acceptance with `accepted_via: staff_phone`.
- Options are the client's only: a fence run document never shows them, and a job with more than one quote party refuses ticks (no per-party option deposit in the contract yet).
- The deposit invoice is raised on the combination's `deposit_inc_gst` with `council_fees: 0` (the council fee is already inside it). With nothing ticked the request is the old one.
- The record is written after the acceptance claim. If it cannot be written, the acceptance stands, the office gets `quote_options_record_failed`, and ticked option money (job price, deposit, drafts) is held.
- `send-quote/status` returns `accepted_option_ids` for an accepted quote whose revision offered options.

## Record

`quote_option_acceptances` (`20261113150000`): one row per accepted document, written once (an update raises), row-level security with one service-role policy. Not taken = offered minus taken. `ops-api job_detail` returns it as `quote_options` (each option `taken` or `offered, not taken`; `quote_options_unreadable` when the read failed).

## Downstream (contract 4.4)

| Taken option | Now |
|---|---|
| Expected cost | `cost_ex_gst` joins its lane (materials or labour; other only the total) in the frozen baseline; `margin_pct` is null then |
| Office list | `quote_options_taken` job event: each option and where it goes |
| Scope draft work order, payer invoices, payment stages | Held (`scope_job_draft_release_held`, reason `quote_options_taken`): they were sealed at the base price |
| Job work order fill | Every line flagged `quote_options_taken_not_in_lines`; never stamped for the automatic issue |

Adding the option lines to the sealed drafts, the supplier order and the work order is not built yet; the office adds them by hand from the event.
