// The bills backfill's database twin (Follow-up 66) ports billCostDocument to
// SQL. One fixture is checked on both sides: this test runs the edge function
// over the fixture's bills, and the migration contract runs the SQL over the
// same bills; both compare to the fixture's expected documents. Made-up ids
// and amounts.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { billCostDocument } from "./cost_lines.ts";

const FIXTURE = new URL("./cost_lines_bill_backfill_fixture.json", import.meta.url);
const CONTRACT = new URL(
  "../../tests/migration-contracts/20261118999900_job_cost_lines_bill_backfill/contract.sql",
  import.meta.url,
);

Deno.test("the edge billCostDocument gives the fixture's expected documents", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(FIXTURE));
  fixture.bills.forEach((bill: any, i: number) => {
    const doc = billCostDocument(bill, {
      orgId: fixture.org_id,
      mirrorBillIds: new Set(),
      employerSuperOn: fixture.employer_super,
    });
    // Text, not structure: the writer's source hash reads the line's text.
    assertEquals(JSON.stringify(doc), JSON.stringify(fixture.expected[i]), `bill ${i}`);
  });
});

Deno.test("the migration contract still holds this exact fixture", async () => {
  const fixture = (await Deno.readTextFile(FIXTURE)).trim();
  assertStringIncludes(await Deno.readTextFile(CONTRACT), `$fixture$\n${fixture}\n$fixture$`);
});
