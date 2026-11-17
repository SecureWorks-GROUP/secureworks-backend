# Director's readback scripts

Director runs one file at a time through an existing read-only connection.
SELECT only, including CTEs; no application functions. The builder has not run
these against any database. No tests added or run.

All take psql variable `job_number`: one exact existing ZZTEST job, never a real
job. Missing/ambiguous rows or wrong figures return `FAIL`. SQL errors also mean
non-pass and stop psql. A returned `FAIL` needs the director to stop and inspect.

Populate the command variables from the kept fixture and independent expected
figures. Supply no credentials on the command line. Keep output privately,
outside git. These scripts neither create fixtures nor run a closing action.

| File | Proves and prerequisites | Extra psql inputs | Output and pass rule |
| --- | --- | --- | --- |
| `digest-from-store.sql` | Latest organisation digest read from existing `daily_digests` (P0-14.3). | `expected_digest_date`: intended build's ISO date. | One row: result, job count, digest metadata and content fingerprint. PASS: one job, nonempty stored object, expected date. |
| `pay-sum.sql` | Stored inclusive pay matches lines and hand arithmetic. Runs after P1-01.1 to .3 merge/release; reimbursements need P1-03.1 to .3 too. | `invoice_id` UUID; decimal `expected_gross`, `expected_fund`, `expected_net`, `expected_gst`, `expected_total`, worked independently. | One row: result, invoice/basis, line amounts, reimbursements, stored/calculated/hand figures. PASS: all agree to the cent on `inclusive_12_112_v1`, no invalid line. |
| `cost-line-readback.sql` | One actual cost and allocation read back. Runs after P2-01.1 merges/applies and its writer saves the fixture. Spec tables `job_cost_lines` and `job_cost_line_parts` are not yet in this branch's schema. | `line_id` UUID; decimal `expected_amount_ex` from the kept source document. | One row: result, source coordinates, kind/lane/state, stored/expected amounts, part count/sum and hash/time. PASS: counted actual `on_job` line, exactly one matching job/lane part, both equal the source figure. Unknown fails. |
| `item-close-from-record.sql` | P4-02 T1 quote closes from records. Runs after P4-02.2 merges/releases and the authorised close flow runs. | `item_id`, `document_id` UUIDs; `expected_closed_at`, independently kept quote sent timestamp with time zone. | One row: result, ids/status/condition, opened/closed/sent times, transition counts/latest actor/status. PASS: live item closed after opening at expected document time, matching citation, exactly one rule close transition, latest transition still that rule. |

For pay, add every stored non-reimbursement line, including travel and commission,
then take 12/112 of that base and round half up once to the cent. Do not round
each line's fund share first. Gross includes reimbursements; net is gross less
fund, so net includes the reimbursement. GST, when registered, is one tenth of
the base; total is gross plus GST. The script compares stored figures against
both that independent arithmetic and the director's hand-worked inputs. The
fixture invoice must contain only lines on this one ZZTEST job; mixed-job and
jobless invoices fail without exposing their line amounts. Use a fixture with
travel, commission and reimbursement to prove those boundaries.

For item close, use a fixture with no later sent quote email: the quote document's
`sent_at` is the expected close time. The script intentionally covers the quote
case only. It does not invoke the closer, refresh a page or prove model-call
counts. For the cost case use a whole-line allocation, not a split. The digest
is organisation-wide: its metadata/fingerprint are returned without its body.
Its PASS proves storage readback only; API read count, model calls and the page's
use of the store need their own P0-14.8 observation.

Commands, from the repository root, one at a time:

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v job_number="$ZZTEST_JOB_NUMBER" \
  -v expected_digest_date="$EXPECTED_DIGEST_DATE" \
  -f scripts/proof/digest-from-store.sql
```

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v job_number="$ZZTEST_JOB_NUMBER" -v invoice_id="$TEST_INVOICE_ID" \
  -v expected_gross="$HAND_GROSS" -v expected_fund="$HAND_FUND" \
  -v expected_net="$HAND_NET" -v expected_gst="$HAND_GST" \
  -v expected_total="$HAND_TOTAL" -f scripts/proof/pay-sum.sql
```

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v job_number="$ZZTEST_JOB_NUMBER" -v line_id="$TEST_COST_LINE_ID" \
  -v expected_amount_ex="$SOURCE_AMOUNT_EX" \
  -f scripts/proof/cost-line-readback.sql
```

```sh
psql -X -v ON_ERROR_STOP=1 \
  -v job_number="$ZZTEST_JOB_NUMBER" -v item_id="$TEST_ITEM_ID" \
  -v document_id="$TEST_QUOTE_DOCUMENT_ID" \
  -v expected_closed_at="$QUOTE_SENT_AT" \
  -f scripts/proof/item-close-from-record.sql
```

Migration sources are named in each SQL file. Future shapes follow the frozen
17 Nov specs: pay 2.1, matching 2.2, agents P4-02.2/T1. Compare the prerequisite
migrations with those specs before running; deployment has not been observed.
