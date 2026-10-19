// deno test supabase/functions/_shared/shared_key_containment_test.ts
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isSharedKey,
  serverCallHeaders,
  SHARED_KEY_CONTAINMENT_ENV,
  sharedKeyAccepted,
  sharedKeyContainmentOn,
  sharedKeyGate,
} from "./shared_key_containment.ts";

// Placeholders only. None of these is, or is shaped from, a real key.
const SHARED = "fixture-shared-browser-key";
const SERVICE = "sb_secret_fixture_service";

const envWith = (v?: string) => (name: string) =>
  name === SHARED_KEY_CONTAINMENT_ENV ? v : undefined;

Deno.test("containment switch: off unless explicitly on", () => {
  for (const v of [undefined, "", "0", "false", "off", "no", "maybe"]) {
    assertEquals(sharedKeyContainmentOn(envWith(v)), false, String(v));
  }
  for (const v of ["1", "true", "on", "yes", " TRUE ", "On"]) {
    assertEquals(sharedKeyContainmentOn(envWith(v)), true, v);
  }
});

Deno.test("shared key accepted while containment is off", () => {
  assert(sharedKeyAccepted(SHARED, SHARED, envWith(undefined)));
});

Deno.test("shared key refused while containment is on", () => {
  assertEquals(sharedKeyAccepted(SHARED, SHARED, envWith("on")), false);
});

Deno.test("wrong, empty or missing values never match", () => {
  assertEquals(sharedKeyAccepted("other", SHARED, envWith(undefined)), false);
  assertEquals(sharedKeyAccepted("", SHARED, envWith(undefined)), false);
  assertEquals(sharedKeyAccepted(null, SHARED, envWith(undefined)), false);
  assertEquals(sharedKeyAccepted(SHARED, "", envWith(undefined)), false);
  assertEquals(sharedKeyAccepted(SHARED, undefined, envWith(undefined)), false);
  assertEquals(isSharedKey(SHARED, SHARED), true);
  assertEquals(isSharedKey("", ""), false);
});

Deno.test("server call headers carry the service credential, never the shared key", () => {
  const h = serverCallHeaders(SERVICE, SHARED);
  assertEquals(h["Authorization"], `Bearer ${SERVICE}`);
  assertEquals(h["apikey"], SERVICE);
  assertEquals(h["x-api-key"], undefined);
  assertEquals(h["Content-Type"], "application/json");
});

Deno.test("server call headers fall back to the shared key only without a service key", () => {
  const h = serverCallHeaders("", SHARED);
  assertEquals(h["x-api-key"], SHARED);
  assertEquals(h["Authorization"], undefined);
});

Deno.test("gate: absent when no presented value is the shared key", () => {
  assertEquals(
    sharedKeyGate({ presented: [null, "jwt.like.token", SERVICE], sharedKey: SHARED, fn: "t", env: envWith("on") }),
    "absent",
  );
  assertEquals(sharedKeyGate({ presented: [SHARED], sharedKey: "", fn: "t" , env: envWith(undefined)}), "absent");
});

Deno.test("gate: accepted with containment off, refused with it on, from any header slot", () => {
  for (const presented of [[SHARED, null], [null, SHARED], [SHARED, SHARED]]) {
    assertEquals(sharedKeyGate({ presented, sharedKey: SHARED, fn: "t", env: envWith(undefined) }), "accepted");
    assertEquals(sharedKeyGate({ presented, sharedKey: SHARED, fn: "t", env: envWith("true") }), "refused");
  }
});
