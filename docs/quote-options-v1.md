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
- Options are the client's only: a fence run document and a neighbour's (B, C...) quote never show them. On a shared fence the client's whole quote offers them, with the tool's party figures; the client's deposit is their amount on the combination's first stage (else their share at the deposit percent; unknown is held, never guessed: `partyOptionDeposit`).
- The offer is checked strictly: every money figure a nonnegative whole-cent number, each combination's schedule (and stages when the base has them) complete and adding up, the deposit equal to the first payment and the first stage, the empty combination the same as the base. The accepted pricing never keeps the base schedule or stages.
- Printed payments and invoice stages are one plan: each printed payment equals its stage, id for id and cent for cent (`combination_schedule_and_stages_disagree`). A combination changes amounts only: labels, basis, trigger, due rule and payers stay the base's (`combination_schedule_terms_not_base`, `combination_stages_terms_not_base`). All refused before the document is claimed.
- Each option's destination line must be one its consumer can use (`destinationLineProblem`): words, a positive quantity and a unit on all three; a supplier line also needs its id and must not be an office fixing; a crew line needs its `line_key` and a total in whole cents or blank; an office line's cost is whole cents or blank. A blank cost is never invented.
- A neighbour's acceptance writes no option record (ticking one is refused, `options_on_neighbour_quote`).
- The deposit invoice is raised on the combination's deposit with `council_fees: 0` (the council fee is already inside it). With nothing ticked the request is the old one.
- An option acceptance is one database call, `accept_quote_document_with_options` (`20261113150000`): the document is claimed and its record written in one transaction. A failure writes nothing and the customer gets the retry page; a second tap claims nothing. Without the migration an offer with options cannot be accepted (retry page); a quote without options is unaffected.
- `send-quote/status` returns `accepted_option_ids` for an accepted quote whose revision offered options.

## Record

`quote_option_acceptances` (`20261113150000`): one row per accepted document, written once (an update raises), row-level security with one service-role policy. Not taken = offered minus taken.

The record that applies downstream is the one on the job's current accepted quote (`job_documents.superseded_at` null). A record on a superseded (re-quoted) document never applies, and two current records read as unreadable, never a merge (`readTakenQuoteOptions`, and the same rule in `apply_quote_options_to_scope_drafts`). `ops-api job_detail` returns it as `quote_options` (each option `taken` or `offered, not taken`; `quote_options_unreadable` when the read failed).

## Downstream (contract 4.4)

Everything is read from the record's `taken_options` and `accepted_combination` (the option and combination exactly as sealed), never the live job, and the original sealed revision is never changed. A NOT-taken option is on none of these.

| Taken option | Where | Code |
|---|---|---|
| Crew | Its `labour_line` joins the scope draft work order and its total the agreed labour; the payer draft invoices, totals and payment stages become the combination's. One transaction before release, checked against the frozen revision; a repeat replays. A blank total is unknown labour: refused (`scope_options_labour_unknown`), nothing written, release held | `apply_quote_options_to_scope_drafts`, called on every release by `release_scope_job_drafts.ts`; `scope_payment_plan` reads the combination's stages |
| Crew (job work order filled from the quote) | One line `option:<id>`; its total joins `agreed_labour_ex`. A missing line or total holds the draft for the approver | `job_work_order_quote_fill.ts` `addTakenCrewOptions` |
| Supplier | Its `order_line` is one more sealed line: in its supplier's box (patio), or on the draft list with no supplier (fence). A line that gives no order line holds the fill (`quote_option_line_unusable`), never "on the order" while dropped | `dispatch_quote_options.ts`, both Dispatch fills |
| Office | Its `office_line` is on the job's office list: `job_detail.quote_options[].office_list` | `taken_options.ts` |
| Expected cost | `cost_ex_gst` joins its lane in the frozen baseline. Read from the job's current record when the whole job is accepted, never from the last request, so the acceptance order of the parties cannot change it; an unreadable record freezes nothing | `expected_costs_freeze` |

An option record that cannot be read holds each of them (release held, fill held for review, Dispatch refuses `quote_options_unreadable`, no baseline frozen); unknown is never "none". An open re-quote over a record that took options on the drafts' revision holds the release (`scope_options_record_superseded`).

The owner work order decision is bound to the order's content, so on a job with the saved-revision switch on, a work order that took a crew option needs the owner's decision on its new content.
