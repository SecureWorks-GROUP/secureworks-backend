// deno-lint-ignore-file no-import-prefix
// Slice B0: the TypeScript twin runs the one fixture table. The SQL helpers run
// the same table in the migration contract (job_refs_contract_rows_test.ts
// proves the two tables are identical).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addressKey,
  addressLooseKeys,
  addressMentions,
  emailKey,
  jobRefTokens,
  phoneKey,
} from "./job_refs.ts";
import { JOB_REF_FIXTURES } from "./job_refs_fixtures.ts";

for (const f of JOB_REF_FIXTURES) {
  Deno.test(`job_refs ${f.kind}: ${f.label}`, () => {
    if (f.kind === "tokens") assertEquals(jobRefTokens(f.input), f.expected);
    else if (f.kind === "phone") assertEquals(phoneKey(f.input), f.expected);
    else if (f.kind === "email") assertEquals(emailKey(f.input), f.expected);
    else {
      assertEquals(addressKey(f.input), f.expected.key);
      assertEquals(addressLooseKeys(f.input), f.expected.loose);
    }
  });
}

Deno.test("N3: 20A Beenan never meets 20 Beenan Cl on the exact key, only loosely", () => {
  const text = addressMentions(
    "Acknowledgement BDBPCERT-2026/3018 - 20A Beenan",
  );
  const job = addressMentions("20 Beenan Cl, Karawara")[0];
  assertEquals(text.some((m) => m.addressKey === job.addressKey), false);
  assertEquals(
    text.some((m) => m.looseKeys.some((k) => job.looseKeys.includes(k))),
    true,
  );
});

Deno.test("E10: Montane Tn and Montane Turn share one exact key", () => {
  assertEquals(
    addressKey("34 Montane Tn"),
    addressKey("34 Montane Turn, Banksia Grove"),
  );
});

Deno.test("E7: the slash form reaches 4 St Joseph Cl loosely and never exactly", () => {
  const [m] = addressMentions("4/6 St Joseph Close Stirling");
  assertEquals(m.slashForm, true);
  assertEquals(m.addressKey === addressKey("4 St Joseph Cl, Stirling"), false);
  assertEquals(
    m.looseKeys.includes(addressLooseKeys("4 St Joseph Cl")![0]),
    true,
  );
});

Deno.test("a text can name several addresses, in order", () => {
  const all = addressMentions(
    "From 14 Bradley St to 20A Beenan and 3/20 Smith Street",
  );
  assertEquals(all.map((m) => m.addressKey), [
    "14 bradley st",
    null,
    "3/20 smith st",
  ]);
});

Deno.test("keys never throw on odd input", () => {
  for (
    const v of [null, undefined, "", "////", ",,,", "0/0 Main St", "99999999 x"]
  ) {
    phoneKey(v);
    emailKey(v);
    addressMentions(v);
    jobRefTokens(v);
  }
  assertEquals(addressMentions("0/0 Main St"), []);
});
