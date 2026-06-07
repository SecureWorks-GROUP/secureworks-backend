import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _isMakesafeAccessJobForTest } from "./index.ts";

Deno.test("MakeSafe access allows canonical makesafe type", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "makesafe", job_number: "MLB-1" }), true);
});

Deno.test("MakeSafe access allows legacy SWMS job numbers even when type is not normalised", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "misc", job_number: "SWMS-26509" }), true);
});

Deno.test("MakeSafe access still rejects ordinary non-SWMS jobs", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "patio", job_number: "MLB-25000" }), false);
});

Deno.test("MakeSafe access allows make_safe spelling", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "make_safe", job_number: "MLB-1" }), true);
});
