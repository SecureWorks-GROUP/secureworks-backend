import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findMatchingSenderCompany,
  parseSenderDomain,
  senderMatchesPattern,
} from "../_shared/makesafe_intake_classification.ts";

Deno.test("sender classification: domain suffix is anchored, not substring", () => {
  assertEquals(
    parseSenderDomain("alerts@noreply.mlb.com.au"),
    "noreply.mlb.com.au",
  );
  assertEquals(
    senderMatchesPattern("alerts@noreply.mlb.com.au", "mlb.com.au"),
    true,
  );
  assertEquals(
    senderMatchesPattern("alerts@evilmlb.com.au", "mlb.com.au"),
    false,
  );
  assertEquals(
    senderMatchesPattern("alerts@mlb.com.au.evil.test", "mlb.com.au"),
    false,
  );
});

Deno.test("sender classification: full-address patterns must match exactly", () => {
  assertEquals(
    senderMatchesPattern("orders@builder.test", "orders@builder.test"),
    true,
  );
  assertEquals(
    senderMatchesPattern("other@builder.test", "orders@builder.test"),
    false,
  );
});

Deno.test("sender classification: scan and monitor can share matching company lookup", () => {
  const patterns = [
    { slug: "mlb", name: "ML Builders", pattern: "mlb.com.au" },
    { slug: "aj", name: "AJ Building", pattern: "workorders@aj.test" },
  ];
  assertEquals(
    findMatchingSenderCompany("alerts@noreply.mlb.com.au", patterns)?.slug,
    "mlb",
  );
  assertEquals(
    findMatchingSenderCompany("workorders@aj.test", patterns)?.slug,
    "aj",
  );
  assertEquals(
    findMatchingSenderCompany("spoof@evilmlb.com.au", patterns),
    null,
  );
});
