import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _INTAKE_EXTRACTION_DOWN_MARKER,
  _isAnthropicAuthFailureForTest as isAuthFailure,
} from "./index.ts";

// D-a: a DEAD/absent key (auth failure) must be distinguished from a transient blip.
// Auth failure degrades the whole scan loud; a transient failure only flags one email.

Deno.test("isAnthropicAuthFailure: HTTP 401 is an auth failure (dead key)", () => {
  assert(isAuthFailure({ status: 401, message: "Unauthorized" }));
});

Deno.test("isAnthropicAuthFailure: HTTP 403 is an auth failure", () => {
  assert(isAuthFailure({ status: 403 }));
});

Deno.test("isAnthropicAuthFailure: SDK authentication_error type is an auth failure", () => {
  assert(isAuthFailure({ error: { type: "authentication_error" }, message: "x" }));
});

Deno.test("isAnthropicAuthFailure: 'invalid x-api-key' message is an auth failure", () => {
  assert(isAuthFailure(new Error("invalid x-api-key: the key is revoked")));
});

Deno.test("isAnthropicAuthFailure: AuthenticationError name is an auth failure", () => {
  const e = new Error("bad key");
  e.name = "AuthenticationError";
  assert(isAuthFailure(e));
});

Deno.test("isAnthropicAuthFailure: a 500 / network blip is NOT an auth failure (transient)", () => {
  assertEquals(isAuthFailure({ status: 500, message: "internal server error" }), false);
  assertEquals(isAuthFailure(new Error("connection reset by peer")), false);
  assertEquals(isAuthFailure(new Error("JSON parse error")), false);
});

Deno.test("extraction-down marker is the stable blocking-field constant", () => {
  // It must NOT be one of the AUTO_APPROVE_ALLOWED_MISSING_FIELDS values, so its
  // presence blocks auto-file. (The value is asserted so a rename is a visible diff.)
  assertEquals(_INTAKE_EXTRACTION_DOWN_MARKER, "extraction_down_key_dead");
});
