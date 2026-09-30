// deno test --allow-env supabase/functions/_shared/service_credential_test.ts
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  configuredSecretKeys,
  createLegacyKeyProbe,
  type LegacyKeyVerdict,
  presentedCredentials,
  timingSafeEqualString,
  verifyServiceCredential,
} from "./service_credential.ts";

// Fixtures only. None of these is, or is shaped from, a real project key.
const SECRET = "sb_secret_fx_cron";
const OTHER_SECRET = "sb_secret_fx_edge";
const LEGACY = "legacy.fixture.injected-key";

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}
function jwt(role: string): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${
    b64url({ role })
  }.fixture-signature`;
}

function envOf(values: Record<string, string>) {
  return (name: string) => values[name];
}
const ENV = envOf({
  SUPABASE_SECRET_KEYS: JSON.stringify({ cron: SECRET, edge: OTHER_SECRET }),
  SUPABASE_SERVICE_ROLE_KEY: LEGACY,
});

function probeReturning(verdict: LegacyKeyVerdict) {
  const calls: string[] = [];
  return {
    calls,
    probe: (token: string) => {
      calls.push(token);
      return Promise.resolve(verdict);
    },
  };
}

function h(init: Record<string, string>): Headers {
  return new Headers(init);
}

Deno.test("configuredSecretKeys reads the platform JSON and keeps only sb_secret_ values", () => {
  assertEquals(
    configuredSecretKeys(
      JSON.stringify({ default: SECRET, junk: "anon", n: 1 }),
    ),
    [SECRET],
  );
  assertEquals(configuredSecretKeys(undefined), []);
  assertEquals(configuredSecretKeys(""), []);
  assertEquals(configuredSecretKeys("not json"), []);
  assertEquals(
    configuredSecretKeys(JSON.stringify({ empty: "sb_secret_" })),
    [],
  );
});

Deno.test("presentedCredentials reads x-api-key, Bearer and apikey", () => {
  assertEquals(
    presentedCredentials(
      h({ "x-api-key": "a", authorization: "bearer b", apikey: "c" }),
    ),
    [
      { header: "x-api-key", token: "a" },
      { header: "authorization", token: "b" },
      { header: "apikey", token: "c" },
    ],
  );
  assertEquals(presentedCredentials(h({ authorization: "Basic xyz" })), []);
});

Deno.test("timingSafeEqualString", () => {
  assert(timingSafeEqualString("abc", "abc"));
  assert(!timingSafeEqualString("abc", "abd"));
  assert(!timingSafeEqualString("abc", "abcd"));
});

Deno.test("a new secret key is accepted in the apikey header without any probe", async () => {
  const p = probeReturning("rejected");
  const got = await verifyServiceCredential(h({ apikey: OTHER_SECRET }), {
    env: ENV,
    probe: p.probe,
  });
  assertEquals(got, {
    kind: "secret_key",
    token: OTHER_SECRET,
    header: "apikey",
  });
  assertEquals(p.calls.length, 0);
});

Deno.test("a new secret key is accepted as Bearer or x-api-key too", async () => {
  const p = probeReturning("rejected");
  assertEquals(
    (await verifyServiceCredential(h({ authorization: `Bearer ${SECRET}` }), {
      env: ENV,
      probe: p.probe,
    }))?.kind,
    "secret_key",
  );
  assertEquals(
    (await verifyServiceCredential(h({ "x-api-key": SECRET }), {
      env: ENV,
      probe: p.probe,
    }))?.kind,
    "secret_key",
  );
});

Deno.test("an unlisted sb_secret_ key is refused and never probed", async () => {
  const p = probeReturning("accepted");
  const got = await verifyServiceCredential(
    h({ apikey: "sb_secret_not_ours" }),
    {
      env: ENV,
      probe: p.probe,
      legacy: "service_role_claim",
    },
  );
  assertEquals(got, null);
  assertEquals(p.calls.length, 0);
});

Deno.test("while the platform still accepts the legacy key, it keeps working", async () => {
  const p = probeReturning("accepted");
  const got = await verifyServiceCredential(
    h({ authorization: `Bearer ${LEGACY}` }),
    { env: ENV, probe: p.probe },
  );
  assertEquals(got, {
    kind: "legacy_service_role",
    token: LEGACY,
    header: "authorization",
  });
  assertEquals(p.calls, [LEGACY]);
});

Deno.test("once the legacy keys are switched off, the injected key is refused even though it still matches", async () => {
  const p = probeReturning("rejected");
  for (
    const headers of [
      h({ authorization: `Bearer ${LEGACY}` }),
      h({ "x-api-key": LEGACY }),
      h({ apikey: LEGACY }),
    ]
  ) {
    assertEquals(
      await verifyServiceCredential(headers, { env: ENV, probe: p.probe }),
      null,
    );
  }
});

Deno.test("an unreachable gateway does not lock out the exact injected key", async () => {
  const p = probeReturning("unknown");
  const got = await verifyServiceCredential(h({ "x-api-key": LEGACY }), {
    env: ENV,
    probe: p.probe,
  });
  assertEquals(got?.kind, "legacy_service_role");
});

Deno.test("a token that is neither key is refused without a probe", async () => {
  const p = probeReturning("accepted");
  assertEquals(
    await verifyServiceCredential(h({ authorization: "Bearer someone-else" }), {
      env: ENV,
      probe: p.probe,
    }),
    null,
  );
  assertEquals(
    await verifyServiceCredential(h({}), { env: ENV, probe: p.probe }),
    null,
  );
  assertEquals(p.calls.length, 0);
});

Deno.test("exact mode ignores a service_role claim that is not the injected key", async () => {
  const p = probeReturning("accepted");
  assertEquals(
    await verifyServiceCredential(
      h({ authorization: `Bearer ${jwt("service_role")}` }),
      { env: ENV, probe: p.probe },
    ),
    null,
  );
  assertEquals(p.calls.length, 0);
});

Deno.test("claim mode accepts a service_role JWT only when the platform vouches for it", async () => {
  const token = jwt("service_role");
  const ok = probeReturning("accepted");
  assertEquals(
    (await verifyServiceCredential(h({ authorization: `Bearer ${token}` }), {
      env: ENV,
      probe: ok.probe,
      legacy: "service_role_claim",
    }))?.kind,
    "legacy_service_role",
  );
  // A forged claim: the gateway refuses it.
  const forged = probeReturning("rejected");
  assertEquals(
    await verifyServiceCredential(h({ authorization: `Bearer ${token}` }), {
      env: ENV,
      probe: forged.probe,
      legacy: "service_role_claim",
    }),
    null,
  );
  // No answer from the gateway: a bare claim proves nothing, so refuse.
  const silent = probeReturning("unknown");
  assertEquals(
    await verifyServiceCredential(h({ authorization: `Bearer ${token}` }), {
      env: ENV,
      probe: silent.probe,
      legacy: "service_role_claim",
    }),
    null,
  );
});

Deno.test("claim mode never accepts an anon JWT", async () => {
  const p = probeReturning("accepted");
  assertEquals(
    await verifyServiceCredential(
      h({ authorization: `Bearer ${jwt("anon")}` }),
      {
        env: ENV,
        probe: p.probe,
        legacy: "service_role_claim",
      },
    ),
    null,
  );
  assertEquals(p.calls.length, 0);
});

Deno.test("legacyKeyEnvNames falls back to SUPABASE_SERVICE_KEY", async () => {
  const p = probeReturning("accepted");
  const got = await verifyServiceCredential(
    h({ authorization: `Bearer ${LEGACY}` }),
    {
      env: envOf({ SUPABASE_SERVICE_KEY: LEGACY }),
      probe: p.probe,
      legacyKeyEnvNames: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
    },
  );
  assertEquals(got?.kind, "legacy_service_role");
});

// ── The probe itself ──

function fakeFetch(statuses: Array<number | "throw">) {
  const seen: Array<{ url: string; apikey: string | null }> = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const status = statuses.shift();
    seen.push({
      url: String(input),
      apikey: new Headers(init?.headers).get("apikey"),
    });
    if (status === undefined || status === "throw") {
      return Promise.reject(new Error("network down"));
    }
    return Promise.resolve(new Response("{}", { status }));
  }) as typeof fetch;
  return { impl, seen };
}

Deno.test("probe asks the project's own gateway with the key as apikey", async () => {
  const f = fakeFetch([200]);
  const probe = createLegacyKeyProbe({
    supabaseUrl: () => "https://project.example/",
    fetchImpl: f.impl,
  });
  assertEquals(await probe(LEGACY), "accepted");
  assertEquals(f.seen, [{
    url: "https://project.example/auth/v1/settings",
    apikey: LEGACY,
  }]);
});

Deno.test("probe maps 401/403 to rejected and other failures to unknown", async () => {
  for (
    const [status, verdict] of [[401, "rejected"], [403, "rejected"], [
      500,
      "unknown",
    ], [429, "unknown"]] as const
  ) {
    const probe = createLegacyKeyProbe({
      supabaseUrl: () => "https://p",
      fetchImpl: fakeFetch([status]).impl,
    });
    assertEquals(await probe(LEGACY), verdict);
  }
  const noUrl = createLegacyKeyProbe({
    supabaseUrl: () => undefined,
    fetchImpl: fakeFetch([200]).impl,
  });
  assertEquals(await noUrl(LEGACY), "unknown");
});

Deno.test("probe caches a definite verdict for the TTL, then asks again", async () => {
  let t = 0;
  const f = fakeFetch([200, 401]);
  const probe = createLegacyKeyProbe({
    supabaseUrl: () => "https://p",
    fetchImpl: f.impl,
    now: () => t,
    ttlMs: 1000,
  });
  assertEquals(await probe(LEGACY), "accepted");
  t = 999;
  assertEquals(await probe(LEGACY), "accepted");
  assertEquals(f.seen.length, 1);
  t = 1000;
  assertEquals(await probe(LEGACY), "rejected");
  assertEquals(f.seen.length, 2);
});

Deno.test("probe keeps the last definite verdict when the gateway stops answering", async () => {
  let t = 0;
  const f = fakeFetch([401, "throw", 503]);
  const probe = createLegacyKeyProbe({
    supabaseUrl: () => "https://p",
    fetchImpl: f.impl,
    now: () => t,
    ttlMs: 10,
  });
  assertEquals(await probe(LEGACY), "rejected");
  t = 100;
  assertEquals(await probe(LEGACY), "rejected");
  t = 200;
  assertEquals(await probe(LEGACY), "rejected");
});

Deno.test("concurrent probes for one token share a single request", async () => {
  const f = fakeFetch([200]);
  const probe = createLegacyKeyProbe({
    supabaseUrl: () => "https://p",
    fetchImpl: f.impl,
  });
  const verdicts = await Promise.all([
    probe(LEGACY),
    probe(LEGACY),
    probe(LEGACY),
  ]);
  assertEquals(verdicts, ["accepted", "accepted", "accepted"]);
  assertEquals(f.seen.length, 1);
});
