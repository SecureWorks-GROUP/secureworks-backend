// deno test supabase/functions/_shared/shared_key_route_auth_test.ts
//
// Behaviour of the route auth decisions ops-ai, agent-runner, completion-pack
// and send-po-email run, driven with real Request headers. The key below is a
// made-up test value, not any real credential.
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  authorizeKeyOrServiceCaller,
  authorizeKeyServiceOrUser,
} from "./shared_key_route_auth.ts";

const SHARED = "test-shared-browser-key-not-real";
const SERVICE = "test-service-credential-not-real";
const USER_JWT = "test-user-jwt-not-real";
const SHARED_SLOTS: Record<string, string>[] = [
  { "x-api-key": SHARED },
  { authorization: `Bearer ${SHARED}` },
];

const envWith = (value: string | undefined) => (name: string) =>
  name === "SW_SHARED_KEY_CONTAINMENT" ? value : undefined;
const OFF = envWith(undefined);
const ON = envWith("on");

const req = (headers: Record<string, string>) =>
  new Request("https://example.test/functions/v1/x", { method: "POST", headers });

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log, error = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
};

function verifiers() {
  const calls = { service: 0, jwt: [] as string[] };
  return {
    calls,
    verifyService: (h: Headers) => {
      calls.service++;
      return Promise.resolve(
        h.get("authorization") === `Bearer ${SERVICE}` || h.get("apikey") === SERVICE,
      );
    },
    verifyUserJwt: (token: string) => {
      calls.jwt.push(token);
      return Promise.resolve(token === USER_JWT);
    },
  };
}

// ── completion-pack / send-po-email ──

for (const fn of ["completion-pack", "send-po-email"]) {
  Deno.test(`${fn}: shared key in either slot passes only while containment is off`, async () => {
    for (const headers of SHARED_SLOTS) {
      const v = verifiers();
      assertEquals(await quietly(() => authorizeKeyOrServiceCaller({ req: req(headers), fn, sharedKey: SHARED, verifyService: v.verifyService, env: OFF })), true);
      assertEquals(await quietly(() => authorizeKeyOrServiceCaller({ req: req(headers), fn, sharedKey: SHARED, verifyService: v.verifyService, env: ON })), false);
    }
  });

  Deno.test(`${fn}: a service credential passes with containment on`, async () => {
    const v = verifiers();
    const headers = { authorization: `Bearer ${SERVICE}`, apikey: SERVICE };
    assertEquals(await authorizeKeyOrServiceCaller({ req: req(headers), fn, sharedKey: SHARED, verifyService: v.verifyService, env: ON }), true);
  });

  Deno.test(`${fn}: no credential, a wrong key, or a typo'd switch with the shared key is refused`, async () => {
    const v = verifiers();
    assertEquals(await authorizeKeyOrServiceCaller({ req: req({}), fn, sharedKey: SHARED, verifyService: v.verifyService, env: OFF }), false);
    assertEquals(await authorizeKeyOrServiceCaller({ req: req({ "x-api-key": "nope" }), fn, sharedKey: SHARED, verifyService: v.verifyService, env: OFF }), false);
    assertEquals(await quietly(() => authorizeKeyOrServiceCaller({ req: req({ "x-api-key": SHARED }), fn, sharedKey: SHARED, verifyService: v.verifyService, env: envWith("onn") })), false);
  });
}

// ── ops-ai / agent-runner ──

for (const fn of ["ops-ai", "agent-runner"]) {
  Deno.test(`${fn}: service credential passes without touching the user check`, async () => {
    const v = verifiers();
    const ok = await authorizeKeyServiceOrUser({ req: req({ authorization: `Bearer ${SERVICE}` }), fn, sharedKey: SHARED, verifyService: v.verifyService, verifyUserJwt: v.verifyUserJwt, env: ON });
    assertEquals(ok, true);
    assertEquals(v.calls.jwt, []);
  });

  Deno.test(`${fn}: shared key passes while off and is refused while on`, async () => {
    for (const headers of SHARED_SLOTS) {
      const off = verifiers();
      assertEquals(await quietly(() => authorizeKeyServiceOrUser({ req: req(headers), fn, sharedKey: SHARED, verifyService: off.verifyService, verifyUserJwt: off.verifyUserJwt, env: OFF })), true);
      const on = verifiers();
      assertEquals(await quietly(() => authorizeKeyServiceOrUser({ req: req(headers), fn, sharedKey: SHARED, verifyService: on.verifyService, verifyUserJwt: on.verifyUserJwt, env: ON })), false);
      // A Bearer that is the shared key is never offered to the user JWT check.
      assertEquals(on.calls.jwt, []);
    }
  });

  Deno.test(`${fn}: a signed-in user passes with containment on, even beside a refused shared key`, async () => {
    const v = verifiers();
    assertEquals(await authorizeKeyServiceOrUser({ req: req({ authorization: `Bearer ${USER_JWT}` }), fn, sharedKey: SHARED, verifyService: v.verifyService, verifyUserJwt: v.verifyUserJwt, env: ON }), true);
    const mixed = verifiers();
    assertEquals(await quietly(() => authorizeKeyServiceOrUser({ req: req({ "x-api-key": SHARED, authorization: `Bearer ${USER_JWT}` }), fn, sharedKey: SHARED, verifyService: mixed.verifyService, verifyUserJwt: mixed.verifyUserJwt, env: ON })), true);
    assertEquals(mixed.calls.jwt, [USER_JWT]);
  });

  Deno.test(`${fn}: a bad or throwing user check is refused`, async () => {
    const v = verifiers();
    assertEquals(await authorizeKeyServiceOrUser({ req: req({ authorization: "Bearer stale" }), fn, sharedKey: SHARED, verifyService: v.verifyService, verifyUserJwt: v.verifyUserJwt, env: ON }), false);
    assertEquals(await authorizeKeyServiceOrUser({ req: req({ authorization: "Bearer stale" }), fn, sharedKey: SHARED, verifyService: v.verifyService, verifyUserJwt: () => Promise.reject(new Error("boom")), env: ON }), false);
    assertEquals(await authorizeKeyServiceOrUser({ req: req({}), fn, sharedKey: SHARED, verifyService: v.verifyService, verifyUserJwt: v.verifyUserJwt, env: OFF }), false);
  });
}
