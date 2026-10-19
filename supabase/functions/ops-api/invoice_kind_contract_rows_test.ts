// deno-lint-ignore-file no-import-prefix
// Same payer close (context T16 fix 2): the SQL twin of invoiceKindOf
// (context_ledger_invoice_kind_of, migration 20261019130000) is proved on the
// same table as the Debt tab's reader. The migration contract's FIXTURES block
// must be exactly invoice_kind_fixtures.ts; regenerate it with
// sqlFixtureBlock() (run this file directly) when this fails.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { invoiceKindOf } from "./debt_ws_rules.ts";
import {
  INVOICE_KIND_FIXTURES,
  type InvoiceKindFixture,
} from "./invoice_kind_fixtures.ts";

const contract = await Deno.readTextFile(
  new URL(
    "../../tests/migration-contracts/20261019130000_context_ledger_same_payer_close/contract.sql",
    import.meta.url,
  ),
);

function q(s: string | null): string {
  return s === null ? "NULL" : `'${s.replaceAll("'", "''")}'`;
}

export function sqlFixtureBlock(): string {
  return INVOICE_KIND_FIXTURES.map((f: InvoiceKindFixture, i) =>
    ` (${q(f.label)},${q(f.reference)},${q(f.description)},${
      q(JSON.stringify(f.expected))
    }::jsonb)${i === INVOICE_KIND_FIXTURES.length - 1 ? "" : ","}`
  ).join("\n");
}

Deno.test("invoiceKindOf answers every shared fixture", () => {
  for (const f of INVOICE_KIND_FIXTURES) {
    assertEquals(
      invoiceKindOf(f.reference, f.description),
      f.expected,
      f.label,
    );
  }
});

Deno.test("the SQL contract's fixture block is invoice_kind_fixtures.ts", () => {
  const start = contract.indexOf("-- FIXTURES BEGIN\n");
  const end = contract.indexOf("\n-- FIXTURES END");
  if (start < 0 || end < 0) {
    throw new Error("contract.sql has no FIXTURES block");
  }
  assertEquals(
    contract.slice(start + "-- FIXTURES BEGIN\n".length, end),
    sqlFixtureBlock(),
  );
});

if (import.meta.main) console.log(sqlFixtureBlock());
