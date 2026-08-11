// Wiring tests for the outbound-SMS sender default (+61489267771 Group Admin).
//
// The behavioral contract lives in _shared/sms_from_number_test.ts (default,
// override, rejection). These tests pin the two deployed send paths to that
// shared policy by inspecting their source, the same pattern test_mode_test.ts
// uses — ghl-proxy/index.ts starts serve() at import time, so its handler
// cannot be imported into a test directly. No network, no live GHL calls.
import { assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ghlProxySource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const opsApiSource = await Deno.readTextFile(
  new URL("../ops-api/index.ts", import.meta.url),
);

Deno.test("ghl-proxy send_sms resolves the sender through the shared policy and always carries fromNumber in the GHL payload", () => {
  assertStrictEquals(
    ghlProxySource.includes(
      "import { resolveSmsFromNumber } from '../_shared/sms_from_number.ts'",
    ),
    true,
  );
  const smsHandler = ghlProxySource.indexOf("action === 'send_sms'");
  assertStrictEquals(smsHandler >= 0, true);
  const resolveCall = ghlProxySource.indexOf(
    "resolveSmsFromNumber(body.fromNumber)",
    smsHandler,
  );
  assertStrictEquals(resolveCall > smsHandler, true);
  // The GHL payload names fromNumber unconditionally — the old conditional
  // spread that let GHL fall back to the +61489267774 location default is gone.
  assertStrictEquals(
    ghlProxySource.includes("...(fromNumber ? { fromNumber } : {})"),
    false,
  );
  const payloadFrom = ghlProxySource.indexOf("fromNumber,", resolveCall);
  assertStrictEquals(payloadFrom > resolveCall, true);
});

Deno.test("ghl-proxy send_sms keeps the 400 rejection for a non-allowlisted override", () => {
  const smsHandler = ghlProxySource.indexOf("action === 'send_sms'");
  const rejection = ghlProxySource.indexOf(
    "return json({ error: resolvedFrom.error }, 400)",
    smsHandler,
  );
  assertStrictEquals(rejection > smsHandler, true);
});

Deno.test("ops-api sendCommsMessageAction (the direct-to-GHL path) applies the same default for every SMS, not only when an override is supplied", () => {
  assertStrictEquals(
    opsApiSource.includes(
      "import { resolveSmsFromNumber } from '../_shared/sms_from_number.ts'",
    ),
    true,
  );
  const handler = opsApiSource.indexOf("async function sendCommsMessageAction(");
  assertStrictEquals(handler >= 0, true);
  const resolveCall = opsApiSource.indexOf(
    "resolveSmsFromNumber(body.fromNumber)",
    handler,
  );
  assertStrictEquals(resolveCall > handler, true);
  const assign = opsApiSource.indexOf(
    "payload.fromNumber = resolvedFrom.fromNumber",
    handler,
  );
  assertStrictEquals(assign > handler, true);
  // The old guard only ran when the Comms tab picked a number; every SMS must
  // now pass through the policy so an omitted choice lands on +61489267771.
  assertStrictEquals(
    opsApiSource.includes("type === 'SMS' && body.fromNumber"),
    false,
  );
});

Deno.test("no send path keeps a private copy of the sender allowlist that could drift from the shared policy", () => {
  assertStrictEquals(ghlProxySource.includes("SW_FROM_NUMBERS"), false);
  assertStrictEquals(opsApiSource.includes("SW_FROM_NUMBERS"), false);
});
