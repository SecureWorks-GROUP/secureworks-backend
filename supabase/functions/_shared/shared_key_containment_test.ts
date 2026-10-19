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
  callerHints,
} from "./shared_key_containment.ts";

// Placeholders only. None of these is, or is shaped from, a real key.
const SHARED = "fixture-shared-browser-key";
const SERVICE = "sb_secret_fixture_service";

const envWith = (v?: string) => (name: string) =>
  name === SHARED_KEY_CONTAINMENT_ENV ? v : undefined;

Deno.test("containment switch: off unless explicitly on", () => {
  for (const v of [undefined, "", "0", "false", "off", "no", " OFF "]) {
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

Deno.test("containment switch: an unrecognised value fails closed and logs a config error", () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (m: string) => lines.push(m);
  try {
    for (const v of ["maybe", "onn", "enable", "tru"]) {
      assertEquals(sharedKeyContainmentOn(envWith(v)), true, v);
    }
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 4);
  for (const l of lines) {
    assertEquals(JSON.parse(l).event, "shared_key_containment_bad_value");
    assert(!l.includes("onn") && !l.includes("enable"), "the raw value is not logged");
  }
});

Deno.test("census hints are allowlisted enums, never header text", () => {
  const leaky = "someone@example.com " + SHARED;
  const h = new Headers({
    origin: "https://evil.example/" ,
    "user-agent": "CustomAgent " + leaky,
    referer: "https://marninms98-dotcom.github.io/patio/" + leaky,
    "x-sw-actor": leaky,
  });
  const hints = callerHints(h);
  assertEquals(hints, { origin: "other", client: "other", actor_header: true });
  const text = JSON.stringify(hints);
  assert(!text.includes("@") && !text.includes(SHARED) && !text.includes("evil"));
  assertEquals(callerHints(new Headers({ origin: "https://marninms98-dotcom.github.io", "user-agent": "Mozilla/5.0" })),
    { origin: "https://marninms98-dotcom.github.io", client: "browser", actor_header: false });
  assertEquals(callerHints(null), { origin: "none", client: "none", actor_header: false });
});

Deno.test("census log lines carry only the allowlisted hints", () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (m: string) => lines.push(m);
  try {
    sharedKeyGate({
      presented: [SHARED],
      sharedKey: SHARED,
      fn: "t",
      env: envWith(undefined),
      headers: new Headers({ "user-agent": "curl/8 " + SHARED, "x-sw-actor": "a@b.c" }),
    });
  } finally {
    console.log = original;
  }
  assertEquals(lines.length, 1);
  assertEquals(Object.keys(JSON.parse(lines[0])).sort(), ["actor_header", "client", "event", "function", "origin", "route"]);
  assert(!lines[0].includes(SHARED) && !lines[0].includes("@"));
});
