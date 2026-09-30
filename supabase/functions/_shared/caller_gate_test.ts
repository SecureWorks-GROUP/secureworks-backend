// deno test --allow-env supabase/functions/_shared/caller_gate_test.ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { authorizeServerCaller } from "./caller_gate.ts";
import type { LegacyKeyVerdict } from "./service_credential.ts";

const SECRET = "sb_secret_fx_gate";
const LEGACY = "legacy.fixture.injected";
function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}
const CRON_JWT = `${b64url({ alg: "HS256" })}.${
  b64url({ role: "service_role" })
}.sig`;
const ANON_JWT = `${b64url({ alg: "HS256" })}.${b64url({ role: "anon" })}.sig`;
const USER_JWT = "user.session.jwt";

function opts(verdict: LegacyKeyVerdict, allowUserSession: boolean) {
  const users: string[] = [];
  return {
    users,
    deps: {
      allowUserSession,
      isUserSession: (jwt: string) => {
        users.push(jwt);
        return Promise.resolve(jwt === USER_JWT);
      },
      credentialOptions: {
        env: (n: string) =>
          ({
            SUPABASE_SECRET_KEYS: JSON.stringify({ cron: SECRET }),
            SUPABASE_SERVICE_ROLE_KEY: LEGACY,
          } as Record<
            string,
            string
          >)[n],
        probe: () => Promise.resolve(verdict),
      },
    },
  };
}
function req(headers: Record<string, string>) {
  return new Request("https://x/fn", { method: "POST", headers });
}

Deno.test("no credentials: refused (the gateway used to be the only check)", async () => {
  assertEquals(
    await authorizeServerCaller(req({}), opts("accepted", true).deps),
    false,
  );
});

Deno.test("the public anon key is refused even though it is a valid project JWT", async () => {
  const o = opts("accepted", true);
  assertEquals(
    await authorizeServerCaller(
      req({ authorization: `Bearer ${ANON_JWT}` }),
      o.deps,
    ),
    false,
  );
});

Deno.test("a new secret key in apikey is accepted", async () => {
  assertEquals(
    await authorizeServerCaller(
      req({ apikey: SECRET }),
      opts("rejected", false).deps,
    ),
    true,
  );
});

Deno.test("the cron's service_role JWT is accepted while the platform vouches for it, refused after", async () => {
  const h = { authorization: `Bearer ${CRON_JWT}` };
  assertEquals(
    await authorizeServerCaller(req(h), opts("accepted", false).deps),
    true,
  );
  assertEquals(
    await authorizeServerCaller(req(h), opts("rejected", false).deps),
    false,
  );
});

Deno.test("the injected legacy key stops working once legacy keys are off", async () => {
  const h = { authorization: `Bearer ${LEGACY}` };
  assertEquals(
    await authorizeServerCaller(req(h), opts("accepted", false).deps),
    true,
  );
  assertEquals(
    await authorizeServerCaller(req(h), opts("rejected", false).deps),
    false,
  );
});

Deno.test("a signed-in user session passes only where the function allows it", async () => {
  const h = { authorization: `Bearer ${USER_JWT}` };
  assertEquals(
    await authorizeServerCaller(req(h), opts("rejected", true).deps),
    true,
  );
  const service = opts("rejected", false);
  assertEquals(await authorizeServerCaller(req(h), service.deps), false);
  assertEquals(service.users, []);
});
