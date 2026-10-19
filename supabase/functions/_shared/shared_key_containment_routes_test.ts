// deno test --allow-read supabase/functions/_shared/shared_key_containment_routes_test.ts
//
// Source guard for the shared browser key containment. Each contained route
// must decide the shared key through sharedKeyGate (so SW_SHARED_KEY_CONTAINMENT
// governs it) and must not keep a direct equality check against SW_API_KEY
// that would bypass the switch. ops-ai, agent-runner and completion-pack boot
// serve() on import, so their handlers cannot be imported in a unit test.
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, root));

const CONTAINED: Record<string, string> = {
  "ops-ai/index.ts": "ops-ai",
  "agent-runner/index.ts": "agent-runner",
  "completion-pack/index.ts": "completion-pack",
  "send-po-email/index.ts": "send-po-email",
  "send-outlook-email/index.ts": "send-outlook-email",
  "send-quote/quote_send_auth.ts": "send-quote",
};

// Direct comparisons that would accept the shared key whatever the switch says.
const BYPASS = [
  /xApiKey\s*===\s*validKey/,
  /bearerToken\s*===\s*validKey/,
  /apiKey\s*===\s*validKey/,
  /suppliedCredential\s*===\s*validKey/,
  /===\s*swApiKey/,
];

for (const [file, fn] of Object.entries(CONTAINED)) {
  Deno.test(`${fn}: shared key decided by sharedKeyGate, no bypass`, () => {
    const src = read(file);
    assert(src.includes("../_shared/shared_key_containment.ts"), "imports the containment module");
    assert(src.includes(`fn: '${fn}'`), "calls sharedKeyGate with its own function name");
    for (const re of BYPASS) {
      assertEquals(re.test(src), false, `direct shared-key comparison ${re} must not remain`);
    }
  });
}

Deno.test("ops-ai and agent-runner never treat a shared-key Bearer as a user JWT", () => {
  for (const file of ["ops-ai/index.ts", "agent-runner/index.ts"]) {
    assert(read(file).includes("bearerToken && !isSharedKey(bearerToken, validKey)"), file);
  }
});

Deno.test("ops-api sends its own Outlook emails with the server credential", () => {
  const src = read("ops-api/index.ts");
  const outlookCalls = src.split("/functions/v1/send-outlook-email`").slice(1)
    .map((after) => after.slice(0, 200));
  assert(outlookCalls.length >= 4);
  for (const call of outlookCalls) {
    assertEquals(/'x-api-key':\s*(env\.)?SW_API_KEY/.test(call), false, call);
  }
  assertEquals(src.split("serverCallHeaders(").length - 1 >= 4, true);
});

Deno.test("browser-facing routes the scoping tools use are not contained", () => {
  // ghl-proxy browser actions stay on their own switch; send-quote /send keeps the key.
  assertEquals(read("ghl-proxy/index.ts").includes("shared_key_containment.ts"), false);
  assert(read("send-quote/quote_send_auth.ts").includes("path === 'send-invoice'"));
});
