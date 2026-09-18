// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeExtractedPdfText } from "./ses-bertram-provenance-repair-v1.ts";

Deno.test("Bertram proof normalizes PDF layout wrapping before narrative comparison", () => {
  const extracted = `Storm and wind have cracked the asbestos cement
    (supersix) boundary fencing to the back, front and side boundaries.\f
    The fence is leaning out of plumb.`;

  assertEquals(
    normalizeExtractedPdfText(extracted),
    "Storm and wind have cracked the asbestos cement (supersix) boundary fencing to the back, front and side boundaries. The fence is leaning out of plumb.",
  );
});
