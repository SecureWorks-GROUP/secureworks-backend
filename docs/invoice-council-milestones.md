# Council milestone invoice drafts

Follow-on to backend #1329 and the Scope Engine council producer #873. Installation and distinct council milestone stages can coexist in one sealed printed payment schedule. Every stage is later than the deposit, has a unique stable stage id and unique trigger, and retains its exact printed amount and generated due wording. No free-text timing is parsed.

There is no canonical billing code on existing council steps. Before quoting, staff chooses an actual incomplete step from an existing council workflow on that exact job. GET `billing_council_steps&job_id=...` is office-only and read-only, returning `{ok,job_id,steps:[{submission_id,step_id,step_name,submission_name}]}`. It does not create a submission or invent a step from a name. A workflow must exist before its milestone can be agreed in the quote; existing jobs are never backfilled.

The optional frozen trigger is `{kind:'council_step_completed',submission_id,step_id,step_name}` with the existing `days_after_trigger` due rule. Printed wording names the step, while UUIDs stay internal. At actual quote release the backend pins that exact incomplete step, name, submission, job and organisation in a separate immutable binding. Missing, renamed, complete or foreign steps stay held. The single-payer binding and all draft-only money guards from #1329 still apply.

Only an explicit complete call through the real council-status writer follows the durable SQL review into draft preparation. A workflow jump or overall completion label is never authority. The accepted stage, captured source submission/step ids, immutable release binding and current explicit completion must all match. PostgreSQL repeats those checks before prepared-to-dispatching admission. Reset and recompletion retain the first captured review and existing claim; they cannot mint another invoice.

Exact step names preserve quotation marks up to 500 characters and reject control characters. The provider path, exact DRAFT GET/read-back, durable unknown state, staff-only reconciliation and no-create retry policy are inherited unchanged. No customer send or authorise path is added. The staff GET/process/reconcile API from #1329 remains the office recovery door; process now consumes both explicit trigger kinds.

## Exact proofs

```sh
DENO_DIR=/private/tmp/ws6-round2-deno-cache NODE_OPTIONS=--max-old-space-size=2048 deno test --frozen --cached-only --allow-env --allow-read supabase/functions/ops-api/invoice_milestone_drafts_test.ts supabase/functions/ops-api/invoice_milestone_reviews_test.ts supabase/functions/ops-api/invoice_create_contract_test.ts supabase/functions/ops-api/invoice_email_gate_test.ts supabase/functions/ops-api/job_bookings_test.ts supabase/functions/ops-api/ghost_observer_auto_mirror_test.ts
INVOICE_DRAFT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56437/postgres INVOICE_DRAFT_DISPOSABLE_ACK=I-confirm-this-is-disposable-local-postgres bash scripts/test-invoice-council-drafts.sh
```

Optional connected producer proof: the Scope Engine checker can generate a private temporary raw pricing handoff from the actual engine, quote, seal and save serializer with both triggers. Set `WS6_PRODUCER_PRICING_FILE` to that file for the same typed Deno command. The real explicit council writer and real scheduled-status writer consume those exact bytes and reach two captured Inclusive DRAFT PUTs plus exact GETs, one per distinct stage, with no sends, authorise or contact redirects. The handoff is never committed or printed and is deleted after receipt. The accepted-document, payer and source rows in that test remain stand-ins; SQL independently proves actual release/trigger bindings.

Limits remain: no live provider write or hosted staff trial, no production migration, no named-party invoice automation, and no variation adjustment policy. The council workflow must exist before the accepted quote. The provider HTTP window after admitted dispatch is unchanged from #1329; later supersession leaves a frozen draft for staff reconciliation, never an automatic send. This is a bounded draft-preparation implementation, not full office business acceptance or money approval.

The captured writer proof also creates two actual first-party assignments, lists those same saved ids/dates through readJobBookings, and demonstrates an actual captured provider PUT response timeout: subsequent status calls beyond replay retention perform no second PUT; office reconcile binds the existing draft.

## Connected acceptance receipt voyage, 4 November 2026

A composed captured-transport voyage now joins the actual producer handoff, exact deposit metadata writer (#1332) and this consumer. The existing private acceptance handler creates its ordinary acceptance deposit and a validated immutable receipt; the test never seeds that receipt. The actual first-party assignment writer and booking reader then prepare and list the installation draft, and explicit council completion prepares the distinct council draft. Repeated scheduling/completion retain those two claims, and the real office GET reads them back. All send/authorise transports for the new later drafts remain zero. The existing acceptance deposit's authorised effect is captured, unchanged legacy behavior.

Evidence is in the WS6 workstream `round5-invoice/acceptance-to-milestones-pass.txt`; a separate combined journey PR packages the rerunnable bridge. This is a connected synthetic business voyage with actual handlers and fake provider transports, not a live Xero receipt, hosted browser trial or staff acceptance. The constituent producer, receipt and consumer PRs must all be reviewed and present together.

Practical holds remain deliberate: no fence producer or named-party automation; verified payer mapping must exist before quote release; historical/replacement/variation cases require office review; any active unbound invoice for the payer, including another job without immutable attribution, or incomplete/100+ inventory holds. Repeat/builder contacts can therefore remain manual. New bindings/receipts and claims retain their immutable evidence and inherited-grant controls. Money/release approval remains separate from this connected proof.
