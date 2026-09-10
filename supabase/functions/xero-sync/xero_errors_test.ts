import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isXeroNotFound } from "./xero_errors.ts";

Deno.test("only a 404 counts as gone; timeouts, 429s and 5xx do not", () => {
  assertEquals(isXeroNotFound(new Error("Xero API /Invoices/abc failed (404): not found")), true);
  assertEquals(isXeroNotFound(new Error("Xero API /Invoices/abc failed (503): unavailable")), false);
  assertEquals(isXeroNotFound(new Error("Xero rate limited on /Invoices/abc after 3 retries")), false);
  assertEquals(isXeroNotFound(new Error("Request timed out after 30000ms")), false);
  assertEquals(isXeroNotFound(null), false);
});
