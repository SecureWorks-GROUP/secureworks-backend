// ════════════════════════════════════════════════════════════
// The pay-back receipt rule's one case table (part of SEC-465). The rule lives
// twice: the pay run check's reimbursement stops in SQL (trade_pay_run_check_v2,
// 20261118194800, about line 357) and the push's payBackReceiptAllowed and its
// two refusals before it (trade_pay_run.ts). Each half is proved against a
// table: the push test runs these cases through the real push, and the SQL
// contract runs its zz_matrix through the real check. This file is the table;
// trade_pay_run_receipt_rule_parity_test.ts fails when the newest contract's
// zz_matrix stops matching it row for row, so neither half can change alone.
// Ruling B (director 18 Nov 23:46): one office approval is enough to pay a
// trade back. Test data only: nothing here is read at run time.
// ════════════════════════════════════════════════════════════

/** One case: receipt status, marked not booked on its job, the office approved
 * the pay-back line, the check's receipt stops (name order), and the push's
 * refusal code (null: pushed). */
export type PayBackReceiptRuleCase = [
  status: string | null,
  marked: boolean,
  lineApproved: boolean,
  checkStops: string[],
  pushRefusal: string | null,
];

const NOT_APPROVED: [string[], string] = [
  ["reimbursement_receipt_not_approved"],
  "pay_run_receipt_not_approved",
];
const QUERIED: [string[], string] = [
  ["reimbursement_queried_or_rejected"],
  "pay_run_receipt_queried_or_rejected",
];
const NOT_CONFIRMED: [string[], string] = [
  ["reimbursement_not_booked_unconfirmed"],
  "pay_run_receipt_not_confirmed",
];
const BOTH: [string[], string] = [
  ["reimbursement_not_booked_unconfirmed", "reimbursement_queried_or_rejected"],
  "pay_run_receipt_queried_or_rejected",
];
const PASS: [string[], null] = [[], null];

export const PAY_BACK_RECEIPT_RULE_CASES: readonly PayBackReceiptRuleCase[] = [
  // Passes: approved or pushed_to_xero, marked or not, line approved or not.
  ["approved", false, false, ...PASS],
  ["APPROVED", false, false, ...PASS],
  ["pushed_to_xero", false, false, ...PASS],
  ["Pushed_To_Xero", false, false, ...PASS],
  ["approved", true, false, ...PASS],
  ["pushed_to_xero", true, false, ...PASS],
  ["approved", false, true, ...PASS],
  // Passes (ruling B): the office approved the line, the receipt is pending.
  ["pending", false, true, ...PASS],
  ["pending_extraction", false, true, ...PASS],
  ["PENDING", false, true, ...PASS],
  // Stops: not approved; an unknown or new status even on an approved line.
  ["pending", false, false, ...NOT_APPROVED],
  ["pending_extraction", false, false, ...NOT_APPROVED],
  ["zz_new_status", false, false, ...NOT_APPROVED],
  ["zz_new_status", false, true, ...NOT_APPROVED],
  [" approved ", false, false, ...NOT_APPROVED],
  [" pending ", false, true, ...NOT_APPROVED],
  ["", false, false, ...NOT_APPROVED],
  ["", false, true, ...NOT_APPROVED],
  [null, false, false, ...NOT_APPROVED],
  [null, false, true, ...NOT_APPROVED],
  // Stops: queried or rejected, whatever the line.
  ["queried", false, false, ...QUERIED],
  ["rejected", false, false, ...QUERIED],
  ["Queried", false, false, ...QUERIED],
  [" REJECTED ", false, false, ...QUERIED],
  ["queried", false, true, ...QUERIED],
  ["rejected", false, true, ...QUERIED],
  // Stops: marked not booked and unconfirmed, whatever the line.
  ["pending", true, false, ...NOT_CONFIRMED],
  ["pending", true, true, ...NOT_CONFIRMED],
  ["pending_extraction", true, true, ...NOT_CONFIRMED],
  ["zz_new_status", true, false, ...NOT_CONFIRMED],
  [null, true, false, ...NOT_CONFIRMED],
  ["queried", true, false, ...BOTH],
  ["rejected", true, true, ...BOTH],
  // Stops: a tab or newline around a status is kept on both sides (Postgres
  // btrim trims spaces only), so these are no known status.
  ["\tqueried", false, false, ...NOT_APPROVED],
  ["rejected\n", false, true, ...NOT_APPROVED],
  ["approved\t", false, false, ...NOT_APPROVED],
  ["\npending", false, true, ...NOT_APPROVED],
  ["pending_extraction\t", false, true, ...NOT_APPROVED],
  ["\tqueried", true, false, ...NOT_CONFIRMED],
  ["approved\n", true, false, ...NOT_CONFIRMED],
];

/** The push refusal a check answer implies: the push applies queried or
 * rejected first, then not booked, then not approved (PAY_BACK_RECEIPT_REFUSALS),
 * so the first of those stops the check shows names the refusal. */
export function pushRefusalForCheckStops(stops: readonly string[]): string | null {
  if (stops.includes("reimbursement_queried_or_rejected")) {
    return "pay_run_receipt_queried_or_rejected";
  }
  if (stops.includes("reimbursement_not_booked_unconfirmed")) {
    return "pay_run_receipt_not_confirmed";
  }
  if (stops.includes("reimbursement_receipt_not_approved")) {
    return "pay_run_receipt_not_approved";
  }
  if (stops.length > 0) throw new Error(`unknown receipt stop in ${stops.join(",")}`);
  return null;
}

/** A contract's zz_matrix row: status, marked, line approved, want. */
export type ContractMatrixRow = [string | null, boolean, boolean, string[]];

/** The rows of `INSERT INTO zz_matrix VALUES ...;` in a contract's SQL. Reads
 * only quoted strings ('' escaped), E'' strings (\t, \n, \r, \\ and \'),
 * NULL, true and false, and '{a,b}' text arrays; anything else throws, so a
 * reshaped table never reads as empty. */
export function parseContractMatrix(sql: string): ContractMatrixRow[] {
  const start = sql.indexOf("INSERT INTO zz_matrix VALUES");
  if (start < 0) throw new Error("no INSERT INTO zz_matrix VALUES");
  const src = sql.slice(start + "INSERT INTO zz_matrix VALUES".length);
  const rows: ContractMatrixRow[] = [];
  let i = 0;
  let row: unknown[] | null = null;
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("--", i)) {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      return;
    }
  };
  for (;;) {
    skip();
    const ch = src[i];
    if (ch === undefined) throw new Error("zz_matrix VALUES has no end");
    if (row === null) {
      if (ch === "(") {
        row = [];
        i++;
      } else if (ch === ",") i++;
      else if (ch === ";") break;
      else throw new Error(`unexpected ${JSON.stringify(ch)} between rows`);
      continue;
    }
    if (ch === ",") {
      i++;
      continue;
    }
    if (ch === ")") {
      i++;
      if (row.length !== 4) throw new Error(`a row has ${row.length} values`);
      const [status, marked, line, want] = row;
      if (typeof marked !== "boolean" || typeof line !== "boolean") {
        throw new Error("marked and line_approved must be true or false");
      }
      if (typeof want !== "string" || !/^\{.*\}$/.test(want)) {
        throw new Error(`want is not a text array: ${String(want)}`);
      }
      const inner = want.slice(1, -1).trim();
      rows.push([
        status as string | null,
        marked,
        line,
        inner === "" ? [] : inner.split(",").map((s) => s.trim()),
      ]);
      row = null;
      continue;
    }
    const escaped = (ch === "E" || ch === "e") && src[i + 1] === "'";
    if (ch === "'" || escaped) {
      let out = "";
      i += escaped ? 2 : 1;
      for (;;) {
        if (i >= src.length) throw new Error("unterminated string");
        if (escaped && src[i] === "\\") {
          const next = src[i + 1];
          const map: Record<string, string> = { t: "\t", n: "\n", r: "\r", "\\": "\\", "'": "'" };
          if (!(next in map)) throw new Error(`unsupported escape \\${next}`);
          out += map[next];
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += src[i++];
      }
      row.push(out);
      continue;
    }
    const word = /^[A-Za-z]+/.exec(src.slice(i))?.[0] ?? "";
    const lower = word.toLowerCase();
    if (lower === "null") row.push(null);
    else if (lower === "true") row.push(true);
    else if (lower === "false") row.push(false);
    else throw new Error(`unexpected value at ${JSON.stringify(src.slice(i, i + 20))}`);
    i += word.length;
  }
  return rows;
}

/** Every way the contract's rows differ from the case table, in words; empty
 * when they match row for row, in order, in every column: the status, the
 * mark, the line approval, the check's stops, and the push refusal those
 * stops imply (pushRefusalForCheckStops) against the case's push refusal. */
export function caseTableDifferences(
  cases: readonly PayBackReceiptRuleCase[],
  rows: readonly ContractMatrixRow[],
): string[] {
  const out: string[] = [];
  const show = (r: unknown) => JSON.stringify(r);
  const n = Math.max(cases.length, rows.length);
  for (let k = 0; k < n; k++) {
    const c = cases[k];
    const r = rows[k];
    const want = c ? [...c] : undefined;
    const got = r ? [...r, pushRefusalForCheckStops(r[3])] : undefined;
    if (show(want) !== show(got)) {
      out.push(`row ${k + 1}: cases ${show(want)}, contract ${show(got)}`);
    }
  }
  return out;
}
