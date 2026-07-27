// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractSyntheticLivefireMarker,
  signSyntheticLivefireMarker,
  stripSyntheticLivefireSignature,
  SYNTHETIC_LIVEFIRE_MAILBOX,
  SYNTHETIC_LIVEFIRE_MARKER_PREFIX,
  SYNTHETIC_LIVEFIRE_SENDER,
  verifySyntheticLivefireMarker,
} from "./makesafe_synthetic_livefire.ts";

const SECRET = "unit-test-service-role-secret";
const RECEIVED_AT_MS = Date.parse("2026-07-27T04:00:00.000Z");

async function token(
  overrides: Partial<Parameters<typeof signSyntheticLivefireMarker>[0]> = {},
) {
  return await signSyntheticLivefireMarker({
    runId: "RUN-20260727-001",
    fixtureId: "PHYSICAL",
    ref: "SYNTHLIVE-001",
    expiresAtMs: RECEIVED_AT_MS + 10 * 60 * 1000,
    secret: SECRET,
    ...overrides,
  });
}

Deno.test("synthetic live-fire marker round-trips through the exact controlled lane", async () => {
  const signed = await token();
  const parsed = extractSyntheticLivefireMarker(
    `NEW WORK ORDER ${signed} Work Order: SYNTHLIVE-001`,
  );
  assert(parsed);
  assertEquals(
    parsed.marker,
    `${SYNTHETIC_LIVEFIRE_MARKER_PREFIX}RUN-20260727-001`,
  );
  assertEquals(parsed.fixtureId, "PHYSICAL");
  assertEquals(parsed.ref, "SYNTHLIVE-001");
  assertEquals(parsed.expiresAtMs, RECEIVED_AT_MS + 10 * 60 * 1000);

  const verified = await verifySyntheticLivefireMarker({
    value: `NEW WORK ORDER ${signed} Work Order: SYNTHLIVE-001`,
    sender: SYNTHETIC_LIVEFIRE_SENDER,
    mailbox: SYNTHETIC_LIVEFIRE_MAILBOX,
    nowMs: RECEIVED_AT_MS,
    secret: SECRET,
  });
  assertEquals(verified, parsed);
});

Deno.test("synthetic marker rejects wrong boundaries, tampering and expiry", async () => {
  const signed = await token();
  const base = {
    value: signed,
    sender: SYNTHETIC_LIVEFIRE_SENDER,
    mailbox: SYNTHETIC_LIVEFIRE_MAILBOX,
    nowMs: RECEIVED_AT_MS,
    secret: SECRET,
  };
  assertEquals(
    await verifySyntheticLivefireMarker({
      ...base,
      sender: "someone-else@secureworkswa.com.au",
    }),
    null,
  );
  assertEquals(
    await verifySyntheticLivefireMarker({
      ...base,
      mailbox: "marnin@secureworkswa.com.au",
    }),
    null,
  );
  assertEquals(
    await verifySyntheticLivefireMarker({
      ...base,
      value: signed.replace("SYNTHLIVE-001", "SYNTHLIVE-002"),
    }),
    null,
  );
  assertEquals(
    await verifySyntheticLivefireMarker({
      ...base,
      nowMs: RECEIVED_AT_MS + 10 * 60 * 1000,
    }),
    null,
  );
  assertEquals(
    await verifySyntheticLivefireMarker({
      ...base,
      nowMs: RECEIVED_AT_MS - 6 * 60 * 1000,
    }),
    null,
  );
  assertEquals(
    await verifySyntheticLivefireMarker({ ...base, secret: "" }),
    null,
  );
});

Deno.test("synthetic marker strips only the signature and retains cleanup identity", async () => {
  const signed = await token();
  const scrubbed = stripSyntheticLivefireSignature(
    `NEW WORK ORDER ${signed} Work Order: SYNTHLIVE-001`,
  );
  assert(
    scrubbed.includes(`${SYNTHETIC_LIVEFIRE_MARKER_PREFIX}RUN-20260727-001`),
  );
  assert(scrubbed.includes("SYNTHLIVE-001"));
  assert(!scrubbed.includes(signed));
  assert(!/[0-9a-f]{64}/.test(scrubbed));
});

Deno.test("synthetic marker signer refuses non-reserved or unsafe identities", async () => {
  await assertRejects(
    () => token({ ref: "MLB-12345" }),
    Error,
    "reserved SYNTHLIVE-",
  );
  await assertRejects(
    () => token({ fixtureId: "physical fixture" }),
    Error,
    "uppercase ASCII",
  );
});
