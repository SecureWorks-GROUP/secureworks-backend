// deno-lint-ignore-file no-import-prefix
// Part of SEC-465. The pay-back receipt rule lives in SQL (the pay run check)
// and in TypeScript (the push). trade_pay_run_push_test.ts runs the shared case
// table through the real push; the newest contract that carries zz_matrix runs
// its rows through the real check. This test fails when those two tables
// differ, so changing the rule on one side alone turns CI red.
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  caseTableDifferences,
  PAY_BACK_RECEIPT_RULE_CASES,
  parseContractMatrix,
  pushRefusalForCheckStops,
} from "./trade_pay_run_receipt_rule_cases.ts";
import { payBackReceiptRefusal } from "./trade_pay_run.ts";

const CONTRACTS = new URL("../../tests/migration-contracts/", import.meta.url);
// The matrix's shape: a contract that tests this rule declares it exactly so.
const MATRIX_SHAPE =
  "CREATE TEMP TABLE zz_matrix(status text, marked boolean, line_approved boolean, want text[])";
// The first contract that carried it (ruling B). A later migration that
// replaces the rule brings its own contract with the same matrix, and the
// newest one is the one compared.
const FIRST = "20261118194800_trade_pay_run_receipt_allow_list";

async function newestRuleContract(): Promise<{ name: string; sql: string }> {
  const found: { name: string; sql: string }[] = [];
  for await (const entry of Deno.readDir(CONTRACTS)) {
    if (!entry.isDirectory) continue;
    let sql: string;
    try {
      sql = await Deno.readTextFile(new URL(`${entry.name}/contract.sql`, CONTRACTS));
    } catch {
      continue;
    }
    if (sql.includes(MATRIX_SHAPE)) found.push({ name: entry.name, sql });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  const newest = found.at(-1);
  if (!newest) throw new Error("no contract carries the pay-back receipt matrix");
  return newest;
}

Deno.test("receipt rule parity: the newest check contract's matrix is the push's case table, row for row", async () => {
  const { name, sql } = await newestRuleContract();
  assert(name >= FIRST, name);
  const rows = parseContractMatrix(sql);
  assertEquals(rows.length, PAY_BACK_RECEIPT_RULE_CASES.length, name);
  assertEquals(caseTableDifferences(PAY_BACK_RECEIPT_RULE_CASES, rows), [], name);
});

Deno.test("receipt rule parity: the push's own rule gives every case's push refusal", () => {
  for (const [status, marked, lineApproved, , refusal] of PAY_BACK_RECEIPT_RULE_CASES) {
    assertEquals(
      payBackReceiptRefusal({
        status,
        unbooked_job_id: marked ? "0c400000-0000-4000-8000-0000000000aa" : null,
        line_approved: lineApproved,
        receipt_storage_path: "ZZTEST/receipt.png",
      }),
      refusal,
      JSON.stringify([status, marked, lineApproved]),
    );
  }
  // A missing receipt, or a blank image, is refused whatever the case table says.
  assertEquals(payBackReceiptRefusal({ status: null, unbooked_job_id: null, missing: true }), "pay_run_receipt_not_approved");
  assertEquals(
    payBackReceiptRefusal({ status: "approved", unbooked_job_id: null, receipt_storage_path: " " }),
    "pay_run_receipt_no_image",
  );
});

Deno.test("receipt rule parity: a changed, missing or extra row is found, in any column", () => {
  const rows = PAY_BACK_RECEIPT_RULE_CASES
    .map((c) => [c[0], c[1], c[2], [...c[3]]] as [string | null, boolean, boolean, string[]]);
  assertEquals(caseTableDifferences(PAY_BACK_RECEIPT_RULE_CASES, rows), []);
  // The push lets a pending receipt through on an unapproved line; the check does not.
  const changed = rows.map((r) => [...r] as typeof r);
  const k = changed.findIndex((r) => r[0] === "pending" && !r[1] && !r[2]);
  changed[k] = ["pending", false, false, []];
  assertEquals(caseTableDifferences(PAY_BACK_RECEIPT_RULE_CASES, changed).length, 1);
  assertEquals(caseTableDifferences(PAY_BACK_RECEIPT_RULE_CASES, rows.slice(1)).length > 0, true);
  assertEquals(
    caseTableDifferences(PAY_BACK_RECEIPT_RULE_CASES, [...rows, ["zz", false, false, []]]).length,
    1,
  );
  // The push refusal column: a case whose refusal disagrees with the stops the
  // check shows is found even when the first four columns match.
  const cases = PAY_BACK_RECEIPT_RULE_CASES.map((c) => [...c] as typeof c);
  const q = cases.findIndex((c) => c[0] === "queried" && c[1] && !c[2]);
  cases[q] = [cases[q][0], cases[q][1], cases[q][2], cases[q][3], "pay_run_receipt_not_confirmed"];
  const found = caseTableDifferences(cases, rows);
  assertEquals(found.length, 1);
  assert(found[0].includes("pay_run_receipt_queried_or_rejected"), found[0]);
  // Every stop maps to the refusal the push applies first.
  assertEquals(pushRefusalForCheckStops([]), null);
  assertEquals(
    pushRefusalForCheckStops(["reimbursement_not_booked_unconfirmed", "reimbursement_queried_or_rejected"]),
    "pay_run_receipt_queried_or_rejected",
  );
  assertThrows(() => pushRefusalForCheckStops(["reimbursement_no_receipt"]));
});

Deno.test("receipt rule parity: the contract reader takes quoted, padded and null statuses and refuses a reshaped table", () => {
  const sql = `x; INSERT INTO zz_matrix VALUES
 -- a comment
 (' approved ',false,true,'{}'),
 ('it''s',TRUE,false,'{a,b}'),
 (E'\\tq\\nr\\'s\\\\',false,false,'{}'),
 (NULL,false,false,'{reimbursement_receipt_not_approved}');
 more`;
  assertEquals(parseContractMatrix(sql), [
    [" approved ", false, true, []],
    ["it's", true, false, ["a", "b"]],
    ["\tq\nr's\\", false, false, []],
    [null, false, false, ["reimbursement_receipt_not_approved"]],
  ]);
  assertThrows(() => parseContractMatrix("no matrix here"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,'{}');"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,false,7);"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,false,'{}')"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES (E'\\x',false,false,'{}');"));
});
