import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { incrementalModifiedSince, SYNC_WINDOW_OVERLAP_MS } from "./sync_window.ts";

Deno.test("window looks back past the last local write so in-flight Xero edits are re-read", () => {
  const now = Date.parse("2026-09-10T00:05:02.690Z");
  assertEquals(incrementalModifiedSince("2026-09-10T00:05:02.690+00:00", now), "2026-09-09T23:50:02.690Z");
  assertEquals(SYNC_WINDOW_OVERLAP_MS, 15 * 60 * 1000);
});

Deno.test("no history means a full fetch; garbage means a full fetch; future stamps are clamped", () => {
  const now = Date.parse("2026-09-10T00:00:00Z");
  assertEquals(incrementalModifiedSince(null, now), undefined);
  assertEquals(incrementalModifiedSince("nope", now), undefined);
  assertEquals(incrementalModifiedSince("2026-09-11T00:00:00Z", now), "2026-09-09T23:45:00.000Z");
});
