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
} from "./trade_pay_run_receipt_rule_cases.ts";

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

Deno.test("receipt rule parity: a changed, missing or extra row is found", () => {
  const rows = PAY_BACK_RECEIPT_RULE_CASES.map((c) => [c[0], c[1], c[2], [...c[3]]] as const)
    .map((r) => [r[0], r[1], r[2], r[3]] as [string | null, boolean, boolean, string[]]);
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
});

Deno.test("receipt rule parity: the contract reader takes quoted, padded and null statuses and refuses a reshaped table", () => {
  const sql = `x; INSERT INTO zz_matrix VALUES
 -- a comment
 (' approved ',false,true,'{}'),
 ('it''s',TRUE,false,'{a,b}'),
 (NULL,false,false,'{reimbursement_receipt_not_approved}');
 more`;
  assertEquals(parseContractMatrix(sql), [
    [" approved ", false, true, []],
    ["it's", true, false, ["a", "b"]],
    [null, false, false, ["reimbursement_receipt_not_approved"]],
  ]);
  assertThrows(() => parseContractMatrix("no matrix here"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,'{}');"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,false,7);"));
  assertThrows(() => parseContractMatrix("INSERT INTO zz_matrix VALUES ('a',false,false,'{}')"));
});
