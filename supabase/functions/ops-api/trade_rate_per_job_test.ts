// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TradeJobRateError,
  tradeJobRateNote,
  tradeTypedJobRate,
} from "./trade_rate_per_job.ts";

Deno.test("job rate: nothing typed, or the office rate, bills the office rate", () => {
  for (
    const raw of [null, undefined, "", "  ", 0, "0", 50, "50", "50.00", 50.000000001]
  ) {
    assertEquals(tradeTypedJobRate(raw, 50, "SWF-1"), null, String(raw));
  }
});

Deno.test("job rate: a trade's own rate bills, above or below the office rate", () => {
  assertEquals(tradeTypedJobRate(60, 50, "SWF-1"), 60);
  assertEquals(tradeTypedJobRate("45.50", 50, "SWF-1"), 45.5);
  assertEquals(tradeTypedJobRate(33.6, 35, "SWF-1"), 33.6);
});

Deno.test("job rate: a rate that cannot be read is refused, never guessed", () => {
  for (
    const raw of [
      -5,
      "-5",
      "abc",
      "1e3",
      "0x40",
      "45.555",
      45.555,
      NaN,
      Infinity,
      {},
      [],
      true,
      "123456",
    ]
  ) {
    assertThrows(
      () => tradeTypedJobRate(raw, 50, "SWF-1"),
      TradeJobRateError,
      "SWF-1",
      String(raw),
    );
  }
});

Deno.test("job rate: the line says when it is above the office rate", () => {
  assertEquals(
    tradeJobRateNote(50, 50, false),
    "Server-resolved rate from trade_rates.",
  );
  const above = tradeJobRateNote(60, 50, true);
  assertStringIncludes(above, "$60.00/hr");
  assertStringIncludes(above, "Above the office rate of $50.00/hr");
  const below = tradeJobRateNote(45, 50, true);
  assertStringIncludes(below, "At or below the office rate of $50.00/hr");
});
