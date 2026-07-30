# Trade-started MakeSafe reattendance v1

Date: 2026-07-30

## Investigation and implementation plan

### How the model works before this change

- A MakeSafe remains one `jobs` row and one board card.
- `makesafe_job_details.cycle_number` is the current visit counter. `reattend_makesafe` advances it and points `attendance_cycle_id` at the immutable `makesafe_attendance_cycles` row for that visit.
- `job_service_reports` is already additive by visit. A report carries both `cycle_number` and `attendance_cycle_id`. `submit_makesafe_report` looks up an existing report only in the current cycle, so a visit-two report does not overwrite visit one.
- Photos in `job_media`, reports, assignments, holds and packs can carry the same attendance-cycle identity. `makesafe_cycle_evidence.ts` lets only current-cycle evidence satisfy current readiness after a reattendance. Prior-cycle evidence remains historical and cannot complete the new visit.
- The canonical board deliberately projects one current report and one current evidence state per job. Board rows are keyed by `jobs.id`, not report id, so additive reports do not create extra cards.
- The Ops job-detail API already returns all `service_reports`, but the Ops UI opens only the first report. That presentation gap makes the existing additive storage look like a continuation.

No schema migration is required. The existing attendance-cycle and report columns are sufficient. This change will not add or alter charging, invoice or send behavior.

### Planned implementation

1. Replace the manager-only reattendance check with a job relationship check. Permit an authenticated caller who is a dispatcher, a manager of the job's vertical, or a trade with a non-cancelled assignment on that job. Refuse everyone else. Keep the required reason.
2. Show the reattendance action to an assigned trade on the actual report detail flow. Keep cancellation manager-only.
3. Preserve one report row per visit and make every report openable in Ops with its own cycle identity, submission time and cycle-bound photos.
4. Prove a retry leaves the report count at two and prove canonical board parity still emits one job card.
5. Run backend tests, frontend tests, a local test-data browser flow through `chrome-devtools-axi`, and a read-only production shape check.

## Charging decision proposal for Captain ruling

This section proposes rules only. No rule below is implemented by this change.

### Inputs already available to the system

- Whether visit one has a live ACCREC invoice, including its status and total.
- A distinct report for each visit, with visit-specific `attendance_cycle_id`, submitter, submitted time, labour hours, trade count, materials, invoice notes and cycle-bound photos.
- The builder pricing schedule in the reporting skill. Current canon is AJS/AJBR at $80 ex GST per trade-hour with a two-hour floor per trade, MLB at $85 ex GST per trade-hour with a three-hour floor per trade, plus the documented temporary-fencing, travel, retrieval, after-hours and materials rules.
- The reattendance reason from the trade.

### Missing input

There is no structured authorised-limit, approved-budget or not-to-exceed field in the live job schema. A read-only check found no such column on `jobs`, `makesafe_job_details`, `work_orders`, `purchase_orders`, `job_service_reports`, `makesafe_attendance_cycles`, `xero_invoices` or `makesafe_companies`. It also found no limit-like key in the metadata of 426 live MakeSafe jobs and no limit-like key in 429 MakeSafe detail rows. The 138 populated `billing_rules` records carry rate, minimum-hours and payment-term facts, not an authorised job limit.

Until an authorised limit is captured as a typed amount with currency, source and approval reference, the system cannot safely decide that a combined charge is within or over the builder's authority. It must ask a human or treat the limit as unknown.

### Live cases observed read-only

A read-only production check on 2026-07-30 found three MakeSafe detail rows with `reattend_count > 0`:

- `SWMS-26651` is on cycle 2. Visit one has a submitted, cycle-bound report and a PAID $319 ACCREC invoice. Visit two does not yet have a report.
- `SWMS-26953` is on cycle 2. Visit one has a submitted, cycle-bound report and there is no live ACCREC invoice. Visit two does not yet have a report.
- `SWMS-26902` is on cycle 3 after two reattendances. It has one submitted, cycle-bound visit-one report and no live ACCREC invoice. Neither later visit has a report.

These are real examples of the already-invoiced and not-yet-invoiced branches. Production currently has no job with more than one `job_service_reports` row, so the new two-report state was proven with schema-shaped test data rather than created in production. The within-limit and over-limit branches cannot be selected from real data because the authorised limit is not recorded.

All three historical reattendance jobs have unbound legacy photos. New uploads are server-bound to the current attendance cycle, but the system cannot honestly invent cycle ownership for those old photos.

### Proposed decision table

| Case | Proposed rule | Why |
| --- | --- | --- |
| Visit one is not invoiced, combined visit total is within a known authorised limit | Build one draft invoice with separate visit-one and visit-two line groups. Keep both attendance-cycle ids in the invoice proposal evidence. | One commercial event avoids duplicate admin work while the separate lines preserve the operational truth. |
| Visit one is not invoiced, combined total is over a known authorised limit | Do not create an invoice automatically. Hold for Captain or Ops to obtain an increased authority or choose an approved split. | Splitting invoices does not create more authority and must not be used to bypass a cap. |
| Visit one already has a DRAFT invoice that has not been issued | Propose revising that draft to include visit two only when the combined amount is within a known limit. Otherwise hold. | A draft is still reversible, but changing money remains a reviewed action. |
| Visit one already has an AUTHORISED, SUBMITTED or PAID invoice | Never rewrite or combine into the issued invoice automatically. Propose a separate visit-two draft referencing the same builder WO/PO and both attendance cycles, then require review. | Issued accounting history must remain immutable. A second invoice may still require fresh authority even if the arithmetic sits under the original limit. |
| Authorised limit is unknown | Hold the charging disposition. The reporting skill may calculate and show each visit's evidence-backed cost, but may not choose one invoice versus two. | The current live data cannot prove the builder authority boundary. |
| Either visit cost is not deterministically evidenced | Hold for the missing trade count, hours, material quantity/price, retrieval evidence, company identity or approved rate override. | The reporting skill's canonical pricing rules require evidence and prohibit invented values. |

### What can be automatic and what remains human

The system can automatically identify invoice existence and status, calculate an evidence-backed proposed cost for each cycle under the approved builder schedule, sum those proposals, and compare the sum with a future typed authorised-limit field.

Human review remains necessary when the authorised limit is missing or conflicting, the original authority may apply only to the first attendance, a second builder instruction or variation is required, company or pricing evidence is ambiguous, an issued invoice already exists, or the proposed charge exceeds authority.

### Captain rulings required

1. If visit one is uninvoiced and the combined amount is within a recorded limit, approve one invoice with separate visit line groups, or require one invoice per attendance.
2. If visit one is already issued, approve the default of a separate visit-two invoice or require another action.
3. Confirm that exceeding the limit always holds rather than splitting invoices.
4. Approve a typed authorised-limit field and its source-of-truth rules before any automatic within-limit decision is built.

## Verification record

### Automated backend proof

Command:

```text
~/.deno/bin/deno test --no-check --allow-env --allow-net=127.0.0.1 \
  supabase/functions/ops-api/makesafe_reattendance_test.ts \
  supabase/functions/ops-api/makesafe_submit_report_test.ts \
  supabase/functions/ops-api/makesafe_cycle_evidence_test.ts \
  supabase/functions/ops-api/makesafe_board_read_model_test.ts
```

Result: 71 passed, 0 failed.

The focused tests prove an assigned trade succeeds, an unrelated user and a user with only a cancelled assignment are refused, visit two creates a distinct cycle-bound report, visit one remains byte-for-byte intact, each report has its own submitted time and photo-cycle identity, a repeat submit leaves exactly two reports, and the pipeline still contains one card and one active job.

### Automated browser proof

Command:

```text
cd dashboard
npm run test:e2e -- \
  tests/e2e/makesafe-report.spec.js \
  tests/e2e/ops-makesafe-multi-report.spec.js
```

Focused result: 7 passed, 0 failed. The full dashboard Playwright suite also passed 30 tests with the two credential-gated live-auth tests skipped as designed.

The Trade test signs in as an ordinary assigned installer, starts visit two with a reason, observes the visit-two marker and gets a blank visit-two report with a 0/5 current-cycle photo gate. The Ops test renders one job detail with two reports, opens both Visit 1 and Visit 2, and proves each modal shows only its own cycle-bound report and photo.

### `chrome-devtools-axi` trade flow

The real `dashboard/trade.html` was served through `tests/browser/makesafe-reattendance-server.mjs` on local test data. An isolated `chrome-devtools-axi` instance on port 9231 signed in as an ordinary assigned installer and drove the controls through DOM queries:

1. The submitted visit-one screen exposed **Create reattendance report** without a manager capability.
2. The installer entered `storm loosened the temporary fence` and clicked **Start reattendance**.
3. The local API recorded exactly `{ job_id: "e2e-makesafe-reattend", reason: "storm loosened the temporary fence" }`.
4. The app reopened the same job as **Re-attend · visit 2**, showed the reason, a blank MakeSafe report and the 0/5 current-visit photo gate. Visit-one work was absent from the new form.

Captured machine-readable browser evidence: [`makesafe-trade-reattendance-browser-proof.txt`](./makesafe-trade-reattendance-browser-proof.txt).

### Read-only production shape proof

The production check used Supabase service-role SELECT requests only. It selected lightweight columns from `jobs`, `makesafe_job_details`, `makesafe_attendance_cycles`, `job_service_reports`, `job_media`, `job_assignments` and `xero_invoices`. It did not select `jobs.scope_json`, write data, send communications or create invoices.

It confirmed the three live shapes listed above and confirmed:

- immutable attendance-cycle rows and the current detail pointer are present;
- existing reports have `cycle_number`, `attendance_cycle_id`, `cycle_attribution='bound'` and their own `submitted_at`;
- zero production jobs currently have a second report row;
- no structured authorised-limit field exists in the relevant live schemas;
- 426 MakeSafe metadata records and 429 MakeSafe detail records contained no limit-like key;
- 138 populated `billing_rules` objects contain pricing schedules and payment terms, not a job authority cap.

### What could not be proved

- No production write was permitted, so a real client job was not advanced or given a second report. The production shape is proven read-only and the transition is proven against schema-shaped tests.
- Legacy unbound photos on the three existing reattendance jobs cannot be attributed to a particular historical visit without inventing evidence. New visit uploads are cycle-bound.
- Within-limit and over-limit charging outcomes cannot be proven or automated because the authorised limit is absent. Those rules await the Captain's ruling and a typed authority field.
- No charging, invoice creation, invoice revision, communication or production mutation was implemented or exercised.
