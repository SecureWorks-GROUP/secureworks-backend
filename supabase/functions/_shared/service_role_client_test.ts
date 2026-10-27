// Proves a service-role client does not leave GoTrue's refresh interval running.
// persistSession: false alone still starts it (the control). Deno's sanitizer
// is left on, so a timer that survives the test fails the run.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { createServiceRoleClient } from "./service_role_client.ts";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = "service-role-test-key";

type AuthShape = {
  autoRefreshToken: boolean;
  persistSession: boolean;
  autoRefreshTicker: unknown;
  autoRefreshTickTimeout: unknown;
  initialize(): Promise<unknown>;
  stopAutoRefresh(): Promise<unknown>;
};

function authOf(
  client: { auth: { initialize(): Promise<unknown> } },
): AuthShape {
  return client.auth as AuthShape;
}

Deno.test("service-role client leaves no GoTrue refresh interval", async () => {
  const client = createServiceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const auth = authOf(client);
  await auth.initialize();
  assertEquals(auth.autoRefreshToken, false);
  assertEquals(auth.persistSession, false);
  assertEquals(auth.autoRefreshTicker, null);
  assertEquals(auth.autoRefreshTickTimeout, null);
});

Deno.test("persistSession false alone still starts the refresh interval", async () => {
  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const auth = authOf(client);
  try {
    await auth.initialize();
    assertEquals(auth.autoRefreshToken, true);
    assert(auth.autoRefreshTicker != null);
  } finally {
    await auth.stopAutoRefresh();
    assertEquals(auth.autoRefreshTicker, null);
  }
});

const SERVICE_ROLE_FUNCTIONS = [
  "ghl-call-transcript-fetch",
  "ghl-history-load",
  "ghl-message-reconcile",
  "context-document-text",
  "context-document-vision",
  "outlook-mail-capture",
];

Deno.test("the six service-role doors build their client through the helper", async () => {
  for (const name of SERVICE_ROLE_FUNCTIONS) {
    const text = await Deno.readTextFile(
      new URL(`../${name}/index.ts`, import.meta.url),
    );
    assert(
      text.includes("createServiceRoleClient("),
      `${name} does not call createServiceRoleClient`,
    );
    assert(
      !text.includes("createClient("),
      `${name} still constructs a Supabase client itself`,
    );
  }
});
