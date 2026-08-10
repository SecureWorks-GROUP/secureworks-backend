// Sender-number policy tests — the +61489267771 ops default (wiki OPS.md,
// Captain decision 2026-07-31), the allowlisted explicit override, and the
// rejection of anything off the allowlist. Pure unit tests; no network, no
// live GHL calls, no real SMS.
import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSmsFromNumber,
  SMS_ALLOWED_FROM_NUMBERS,
  SMS_DEFAULT_FROM_NUMBER,
} from "./sms_from_number.ts";

Deno.test("no caller-supplied fromNumber defaults to +61489267771 (Group Admin), never the GHL location default", () => {
  assertStrictEquals(SMS_DEFAULT_FROM_NUMBER, "+61489267771");
  for (const absent of [undefined, null, "", "   "]) {
    assertEquals(resolveSmsFromNumber(absent), {
      ok: true,
      fromNumber: "+61489267771",
    });
  }
});

Deno.test("every allowlisted SecureWorks number is honored as an explicit override, including with surrounding whitespace", () => {
  for (const number of SMS_ALLOWED_FROM_NUMBERS) {
    assertEquals(resolveSmsFromNumber(number), { ok: true, fromNumber: number });
    assertEquals(resolveSmsFromNumber(`  ${number} `), {
      ok: true,
      fromNumber: number,
    });
  }
  // The Patios line is still reachable — but only by explicit choice.
  assertEquals(resolveSmsFromNumber("+61489267774"), {
    ok: true,
    fromNumber: "+61489267774",
  });
});

Deno.test("numbers off the allowlist are rejected with the established error shape", () => {
  for (
    const bad of [
      "+61400000000", // foreign mobile
      "0489267771", // local format, not E.164
      "+61489267775", // not a SecureWorks line
      "garbage",
    ]
  ) {
    const result = resolveSmsFromNumber(bad);
    assertStrictEquals(result.ok, false);
    if (result.ok) continue;
    assertStrictEquals(
      result.error,
      `Invalid fromNumber: ${bad.trim()}. Must be a SecureWorks number in E.164 form (e.g. +61489267776).`,
    );
  }
});

Deno.test("the default is on the allowlist, so an explicit 771 and the default are the same sender", () => {
  assertStrictEquals(
    (SMS_ALLOWED_FROM_NUMBERS as readonly string[]).includes(
      SMS_DEFAULT_FROM_NUMBER,
    ),
    true,
  );
});
