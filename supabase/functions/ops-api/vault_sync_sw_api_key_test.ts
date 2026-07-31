// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resolveOpsApiAuthIntent,
  _vaultSyncSwApiKeyActionForTest,
} from "./index.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731152254_vault_sync_sw_api_key.sql",
    import.meta.url,
  ),
);
const schemaRequirements = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);

function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(result);
    },
  };
}

Deno.test("vault sync accepts the existing service credential path and returns only a receipt", async () => {
  const authMode = _resolveOpsApiAuthIntent({
    xApiKey: null,
    bearerToken: "service-role-key",
    validKey: "master-key",
    serviceKey: "service-role-key",
  });
  assertEquals(authMode, "api_key");

  const client = fakeClient({
    data: { name: "sw_api_key", value_md5_prefix: "0123abcd" },
    error: null,
  });
  const response = await _vaultSyncSwApiKeyActionForTest(
    client,
    authMode,
    null,
    "POST",
    (name) => name === "SW_API_KEY" ? "unit-test-secret" : undefined,
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    synced: true,
    name: "sw_api_key",
    value_md5_prefix: "0123abcd",
  });
  assertEquals(client.calls, [{
    name: "vault_upsert_sw_api_key",
    args: { p_secret: "unit-test-secret" },
  }]);
});

Deno.test("vault sync refuses non-privileged callers before reading env or writing", async () => {
  for (
    const [authMode, role] of [
      ["routine", null],
      ["jwt", "trade"],
      ["none", null],
    ] as const
  ) {
    const client = fakeClient({ data: null, error: null });
    let envReads = 0;
    const response = await _vaultSyncSwApiKeyActionForTest(
      client,
      authMode,
      role ? { role } : null,
      "POST",
      () => {
        envReads += 1;
        return "must-not-be-read";
      },
    );

    assertEquals(response.status, 403);
    assertEquals(envReads, 0);
    assertEquals(client.calls, []);
  }
});

Deno.test("vault sync refuses an absent or empty runtime key without an RPC", async () => {
  for (const value of [undefined, "", "   "]) {
    const client = fakeClient({ data: null, error: null });
    const response = await _vaultSyncSwApiKeyActionForTest(
      client,
      "api_key",
      null,
      "POST",
      () => value,
    );

    assertEquals(response.status, 503);
    assertStringIncludes((await response.json()).error, "missing or empty");
    assertEquals(client.calls, []);
  }
});

Deno.test("vault sync requires POST and does not read the runtime key on GET", async () => {
  const client = fakeClient({ data: null, error: null });
  let envReads = 0;
  const response = await _vaultSyncSwApiKeyActionForTest(
    client,
    "api_key",
    null,
    "GET",
    () => {
      envReads += 1;
      return "must-not-be-read";
    },
  );

  assertEquals(response.status, 405);
  assertEquals(envReads, 0);
  assertEquals(client.calls, []);
});

Deno.test("vault sync hides database error details and never returns the key", async () => {
  const client = fakeClient({
    data: null,
    error: { message: "database rejected request" },
  });
  const secret = "unit-test-secret";
  const response = await _vaultSyncSwApiKeyActionForTest(
    client,
    "api_key",
    null,
    "POST",
    () => secret,
  );
  const rawBody = await response.text();

  assertEquals(response.status, 500);
  assert(!rawBody.includes(secret));
  assert(!rawBody.includes("database rejected request"));
  assertEquals(JSON.parse(rawBody), { error: "vault_sync_sw_api_key failed" });
});

Deno.test("vault migration is service-role-only, serialized, and uses Vault SQL functions", () => {
  assertStringIncludes(migration, "SECURITY DEFINER");
  assertStringIncludes(migration, "SET search_path = ''");
  assertStringIncludes(migration, "pg_advisory_xact_lock");
  assertStringIncludes(migration, "FROM vault.secrets");
  assertStringIncludes(migration, "vault.create_secret(");
  assertStringIncludes(migration, "vault.update_secret(");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.vault_upsert_sw_api_key(text)",
  );
  assertStringIncludes(migration, "FROM PUBLIC, anon, authenticated");
  assertStringIncludes(migration, "TO service_role, postgres");
  assertStringIncludes(migration, "pg_catalog.md5(p_secret)");
  assert(!migration.includes("vault.decrypted_secrets"));
  assertStringIncludes(
    schemaRequirements,
    "ops-api|supabase/migrations/20260731152254_vault_sync_sw_api_key.sql|function|vault_upsert_sw_api_key",
  );
});
