// H7 (INT-10): the Context reader of CFO's bill cost outcomes.
// - Producer and consumer stand on one contract version: CFO's view leads its
//   change hash with it, Context's function passes it on, and this reader
//   refuses any other.
// - The answer carries no amount: a number or a money key refuses it whole.
// - Unknown stays unknown: a code this reader does not know, or a bill with no
//   placement on the job, never reads as "counts here".
// Made-up ids and names only. Reads the two migration files (--allow-read).
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  amountIn,
  BILL_OUTCOME_CONTRACT_VERSION,
  BILL_OUTCOME_SHAPE,
  validateJobBillOutcomes,
} from "./job_bill_outcomes_read.ts";

const PRODUCER = new URL(
  "../../migrations/20261029170000_cfo_bill_cost_outcomes.sql",
  import.meta.url,
);
const CONSUMER_SQL = new URL(
  "../../migrations/20261029170100_context_job_bill_outcomes.sql",
  import.meta.url,
);

function bill(over: Record<string, unknown> = {}) {
  return {
    xero_invoice_id: "x-1",
    invoice_number: "B-1",
    supplier: "Testvale Supplies",
    bill_status: "PAID",
    bill_state: "counted_in_full",
    held_reason: null,
    change_hash: "h",
    overhead_part: false,
    not_job_related_mark: false,
    where_counted: "here",
    here: {
      xero_linked: true,
      placed_by: null,
      counts: "counted",
      reason: "engine_reads_xero_lines",
      holding_job: false,
    },
    other_jobs: [],
    ...over,
  };
}

function answer(over: Record<string, unknown> = {}) {
  return {
    contract_version: BILL_OUTCOME_CONTRACT_VERSION,
    contract_versions_agree: true,
    shape: BILL_OUTCOME_SHAPE,
    job_id: "J",
    bills: [bill()],
    ...over,
  };
}

Deno.test("producer and consumer: one contract version, leading CFO's change hash and passed on by Context", async () => {
  const producer = await Deno.readTextFile(PRODUCER);
  const consumer = await Deno.readTextFile(CONSUMER_SQL);
  assertEquals(BILL_OUTCOME_CONTRACT_VERSION, "cfo-bill-cost-outcome-v1");
  // The view publishes the version and puts it first in the evidence hash, so
  // a new version moves every hash.
  assertMatch(
    producer,
    new RegExp(`'${BILL_OUTCOME_CONTRACT_VERSION}'::text AS contract_version`),
  );
  assertMatch(
    producer,
    new RegExp(
      `md5\\(\\(?jsonb_build_array\\(\\s*'${BILL_OUTCOME_CONTRACT_VERSION}'`,
    ),
  );
  // Context's function passes on the producer's version and names its shape.
  assert(consumer.includes(`'${BILL_OUTCOME_CONTRACT_VERSION}'`));
  assert(consumer.includes(`'${BILL_OUTCOME_SHAPE}'`));
});

Deno.test("an answer on the contract passes, every field kept as the producer said it", () => {
  const r = validateJobBillOutcomes(answer());
  assert(r.ok);
  assertEquals(r.value.contract_version, BILL_OUTCOME_CONTRACT_VERSION);
  assertEquals(r.value.bills[0].where_counted, "here");
  assertEquals(r.value.bills[0].here?.counts, "counted");
  assertEquals(r.value.bills[0].bill_status, "PAID");
  const empty = validateJobBillOutcomes(answer({ bills: [] }));
  assert(empty.ok);
  assertEquals(empty.value.bills, []);
});

Deno.test("another version, disagreeing versions or another shape is refused whole", () => {
  const codes = [
    answer({ contract_version: "cfo-bill-cost-outcome-v2" }),
    answer({ contract_version: undefined }),
    answer({ contract_versions_agree: false }),
    answer({ shape: "context-job-bill-outcomes-v2" }),
    answer({ bills: "none" }),
    answer({ bills: [bill({ xero_invoice_id: null })] }),
    null,
    [],
  ].map((a) => {
    const r = validateJobBillOutcomes(a);
    return r.ok ? "ok" : r.code;
  });
  assertEquals(codes, [
    "contract_mismatch",
    "contract_mismatch",
    "contract_mismatch",
    "invalid_shape",
    "invalid_shape",
    "invalid_shape",
    "invalid_shape",
    "invalid_shape",
  ]);
});

Deno.test("no amount: a number or a money key anywhere refuses the answer, never trims it", () => {
  for (
    const leak of [
      answer({ bills: [bill({ bill_ex: 900 })] }),
      answer({ bills: [bill({ counted_ex: "900.00" })] }),
      answer({ bills: [bill({ other_jobs: [{ job_id: "J2", amount: 1 }] })] }),
      answer({ bills: [bill({ here: { counts: "counted", share: 0.5 } })] }),
      answer({ total: "10" }),
      answer({ bills: [bill({ credit_applied_ex: null })] }),
    ]
  ) {
    const r = validateJobBillOutcomes(leak);
    assertEquals(r.ok ? "ok" : r.code, "amount_present", JSON.stringify(leak));
  }
  assertEquals(amountIn(answer()), null);
});

Deno.test("over-counting and a placed trade-app mirror pass on by name, never as in part or as this bill's cost", () => {
  const r = validateJobBillOutcomes(answer({
    bills: [
      bill({ xero_invoice_id: "x-over", bill_state: "over_counted" }),
      bill({
        xero_invoice_id: "x-mirror",
        bill_state: "trade_mirror",
        where_counted: "trade_app",
        here: {
          xero_linked: false,
          placed_by: "person",
          counts: "not_counted",
          reason: "mirror_bill_person_placed",
          holding_job: false,
        },
      }),
      bill({ xero_invoice_id: "x-odd", bill_state: "mostly_counted" }),
    ],
  }));
  assert(r.ok);
  assertEquals(r.value.bills.map((b) => [b.bill_state, b.where_counted]), [
    ["over_counted", "here"],
    ["trade_mirror", "trade_app"],
    ["unknown", "here"],
  ]);
  assertEquals(r.value.bills[1].here?.reason, "mirror_bill_person_placed");
});

Deno.test("unknown stays unknown: an unknown code or a bill with no placement here never reads as counted here", () => {
  const r = validateJobBillOutcomes(answer({
    bills: [
      bill({ where_counted: "everywhere" }),
      bill({ xero_invoice_id: "x-2", here: null }),
      bill({
        xero_invoice_id: "x-3",
        here: { counts: "maybe" },
        other_jobs: [{ job_id: "J2", job_number: "SWF-2", counts: "sort_of" }],
      }),
      bill({
        xero_invoice_id: "x-4",
        where_counted: "held",
        here: { counts: "held", reason: null },
      }),
    ],
  }));
  assert(r.ok);
  assertEquals(r.value.bills.map((b) => b.where_counted), [
    "unknown",
    "unknown",
    "unknown",
    "held",
  ]);
  assertEquals(r.value.bills[2].here?.counts, "unknown");
  assertEquals(r.value.bills[2].other_jobs[0].counts, "unknown");
  assertEquals(r.value.bills[3].here?.counts, "held");
});
