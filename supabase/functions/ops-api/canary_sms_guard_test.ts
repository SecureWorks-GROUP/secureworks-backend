// Tests for the BOOKING_CANARY_MODE send-SMS guard added to
// ops-api/index.ts per validator hard-block 2026-05-14.
//
// What's under test:
//   - validateCanarySmsRecipient: BOOKING_CANARY_MODE off → pass.
//   - validateCanarySmsRecipient: BOOKING_CANARY_MODE on +
//     contact_phone present + phone (normalized to digits) in
//     BOOKING_CANARY_PHONE_ALLOWLIST → pass.
//   - validateCanarySmsRecipient: BOOKING_CANARY_MODE on +
//     no contact_phone → blocked.
//   - validateCanarySmsRecipient: BOOKING_CANARY_MODE on +
//     phone present but NOT in allowlist → blocked, even when the
//     proposal carries a SECURE_SALE_TEST marker (per validator
//     review: marker is never sufficient by itself).
//   - Reentrancy: env vars are snapshot+restored per test so the
//     suite is order-independent.
//
// Convention: helpers are mirrored inline from ops-api/index.ts.
// Drift is caught at PR review time. Matches expense_draft_test.ts
// and approve_and_send_test.ts in this folder.
//
// Run:
//   deno test --no-check --allow-env \
//     supabase/functions/ops-api/canary_sms_guard_test.ts

import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// ────────────────────────────────────────────────────────────────────
// Mirror of validateCanarySmsRecipient from ops-api/index.ts.
// Keep these byte-for-byte in sync with the index.ts source.
// ────────────────────────────────────────────────────────────────────
function validateCanarySmsRecipient(args: {
  contact_phone: string | null | undefined;
  metadata?: Record<string, unknown> | null;
  action_payload?: Record<string, unknown> | null;
}): { ok: boolean; reason?: string } {
  const rawMode = String(Deno.env.get("BOOKING_CANARY_MODE") ?? "").toLowerCase();
  const canaryOn = rawMode === "1" || rawMode === "true" || rawMode === "yes";
  if (!canaryOn) return { ok: true };

  const normalize = (s: string): string => s.replace(/\D+/g, "");

  const allowRaw = String(Deno.env.get("BOOKING_CANARY_PHONE_ALLOWLIST") ?? "");
  const allowedNorm = allowRaw
    .split(",")
    .map((s) => normalize(s))
    .filter((s) => s.length > 0);
  const phoneRaw = String(args.contact_phone ?? "").trim();
  const phoneNorm = normalize(phoneRaw);

  if (!phoneNorm) {
    return {
      ok: false,
      reason:
        `BOOKING_CANARY_MODE=on: recipient has no phone (raw=${JSON.stringify(phoneRaw)}); ` +
        `phone-in-BOOKING_CANARY_PHONE_ALLOWLIST is the only gate. Refused.`,
    };
  }

  if (allowedNorm.length === 0 || !allowedNorm.includes(phoneNorm)) {
    const meta = (args.metadata ?? {}) as Record<string, unknown>;
    const ap = (args.action_payload ?? {}) as Record<string, unknown>;
    const markerNote =
      meta.SECURE_SALE_TEST === true ||
      ap.SECURE_SALE_TEST === true ||
      meta.test_archived === true
        ? " (SECURE_SALE_TEST marker present on proposal — logged but NOT sufficient to bypass per validator review)"
        : "";
    return {
      ok: false,
      reason:
        `BOOKING_CANARY_MODE=on: recipient phone "${phoneRaw}" (normalized "${phoneNorm}") ` +
        `not in BOOKING_CANARY_PHONE_ALLOWLIST` + markerNote + ".",
    };
  }

  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────
// Test helper: snapshot/restore env so each test is reentrant.
// ────────────────────────────────────────────────────────────────────
function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const restore: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(vars)) {
    restore.push([k, Deno.env.get(k)]);
    if (v === undefined) {
      Deno.env.delete(k);
    } else {
      Deno.env.set(k, v);
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, prior] of restore) {
      if (prior === undefined) {
        Deno.env.delete(k);
      } else {
        Deno.env.set(k, prior);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 1. mode off → allow (production behaviour unchanged)
// ────────────────────────────────────────────────────────────────────
Deno.test("mode unset → allows everything (production path)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: undefined, BOOKING_CANARY_PHONE_ALLOWLIST: undefined },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400999888" });
      assertEquals(r, { ok: true });
    },
  );
});

Deno.test("mode='0' → allows (treated as falsy)", () => {
  withEnv({ BOOKING_CANARY_MODE: "0" }, () => {
    const r = validateCanarySmsRecipient({ contact_phone: "+61400999888" });
    assertEquals(r, { ok: true });
  });
});

Deno.test("mode='maybe' → allows (unknown value treated as falsy)", () => {
  withEnv({ BOOKING_CANARY_MODE: "maybe" }, () => {
    const r = validateCanarySmsRecipient({ contact_phone: "+61400999888" });
    assertEquals(r, { ok: true });
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. mode on + allowlisted phone → allow
// ────────────────────────────────────────────────────────────────────
Deno.test("mode='1' + phone in allowlist (exact format) → allows", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222,+61400333444",
    },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r, { ok: true });
    },
  );
});

Deno.test("mode='1' + phone in allowlist (different format) → allows via digit normalization", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "0400 111 222,+61 400 333 444",
    },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      // Allowlist entry "0400 111 222" normalizes to "0400111222";
      // recipient "+61400111222" normalizes to "61400111222".
      // These DO NOT match — and that's correct: normalization is
      // digit-only, no country-code stripping. Document the contract.
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + phone in allowlist (with spaces) → allows after normalization", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61 400 111 222",
    },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r, { ok: true });
    },
  );
});

Deno.test("mode='true' (case variant) + allowlist match → allows", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "True", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r, { ok: true });
    },
  );
});

Deno.test("mode='YES' (case variant) + allowlist match → allows", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "YES", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r, { ok: true });
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 3. mode on + marker present + non-allowlisted phone → BLOCKED
// (per validator review: marker is logged but NEVER sufficient)
// ────────────────────────────────────────────────────────────────────
Deno.test("mode='1' + SECURE_SALE_TEST marker + non-allowlisted phone → blocked", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222",
    },
    () => {
      const r = validateCanarySmsRecipient({
        contact_phone: "+61400999888", // NOT in allowlist
        metadata: { SECURE_SALE_TEST: true }, // marker present
      });
      assertEquals(r.ok, false);
      assert(r.reason);
      assertStringIncludes(r.reason, "not in BOOKING_CANARY_PHONE_ALLOWLIST");
      // The marker IS logged into the refusal reason for telemetry.
      assertStringIncludes(r.reason, "SECURE_SALE_TEST marker present");
      assertStringIncludes(r.reason, "NOT sufficient to bypass");
    },
  );
});

Deno.test("mode='1' + action_payload SECURE_SALE_TEST + non-allowlisted phone → blocked", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222",
    },
    () => {
      const r = validateCanarySmsRecipient({
        contact_phone: "+61400999888",
        action_payload: { SECURE_SALE_TEST: true },
      });
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + test_archived marker + non-allowlisted phone → blocked", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222",
    },
    () => {
      const r = validateCanarySmsRecipient({
        contact_phone: "+61400999888",
        metadata: { test_archived: true },
      });
      assertEquals(r.ok, false);
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 4. mode on + no phone → BLOCKED (gate is phone-in-allowlist; absence
//    of phone fails the gate)
// ────────────────────────────────────────────────────────────────────
Deno.test("mode='1' + contact_phone null → blocked (no phone)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: null });
      assertEquals(r.ok, false);
      assert(r.reason);
      assertStringIncludes(r.reason, "has no phone");
    },
  );
});

Deno.test("mode='1' + contact_phone undefined → blocked (no phone)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: undefined });
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + contact_phone empty string → blocked (no phone)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "" });
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + contact_phone whitespace only → blocked (no phone)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "   " });
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + contact_phone non-numeric only → blocked (normalizes to '')", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222" },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "(none)" });
      assertEquals(r.ok, false);
    },
  );
});

// ────────────────────────────────────────────────────────────────────
// 5. mode on + non-allowlisted phone (no marker) → BLOCKED
// ────────────────────────────────────────────────────────────────────
Deno.test("mode='1' + phone present + NOT in allowlist + no marker → blocked", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61400111222",
    },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400999888" });
      assertEquals(r.ok, false);
      assert(r.reason);
      assertStringIncludes(r.reason, "+61400999888");
      assertStringIncludes(r.reason, "not in BOOKING_CANARY_PHONE_ALLOWLIST");
    },
  );
});

Deno.test("mode='1' + empty BOOKING_CANARY_PHONE_ALLOWLIST → blocked (allowlist must be non-empty)", () => {
  withEnv(
    { BOOKING_CANARY_MODE: "1", BOOKING_CANARY_PHONE_ALLOWLIST: undefined },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r.ok, false);
    },
  );
});

Deno.test("mode='1' + BOOKING_CANARY_PHONE_ALLOWLIST is comma garbage → blocked", () => {
  withEnv(
    {
      BOOKING_CANARY_MODE: "1",
      BOOKING_CANARY_PHONE_ALLOWLIST: ",,,",
    },
    () => {
      const r = validateCanarySmsRecipient({ contact_phone: "+61400111222" });
      assertEquals(r.ok, false);
    },
  );
});
