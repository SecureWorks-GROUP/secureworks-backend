import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _verifyAndSendInvoiceEmail } from "./index.ts";
import {
  happyFixture,
  makeBody,
  makeStubClient,
  makeStubFetch,
  makeStubGetToken,
  makeStubLogBusinessEvent,
  makeStubXeroGet,
  STUB_ENV,
} from "./_test_helpers.ts";

for (const status of ["DRAFT", "SUBMITTED", "VOIDED", undefined]) {
  Deno.test(`Outlook invoice email refuses live ${String(status)} before PDF or email`, async () => {
    const fix = happyFixture();
    const { client } = makeStubClient(fix.seed);
    const { xeroGet } = makeStubXeroGet({
      invoices: {
        "inv-123": { ...fix.xeroInvoice, Status: status },
      },
    });
    const { fetch, calls } = makeStubFetch(fix.fetchRoutes);
    const { getToken } = makeStubGetToken();
    const { logBusinessEvent, events } = makeStubLogBusinessEvent();
    const response = await _verifyAndSendInvoiceEmail({
      client,
      body: makeBody(),
      getToken,
      xeroGet,
      logBusinessEvent,
      fetch,
      xeroFetch: fetch,
      env: STUB_ENV,
    });
    assertEquals(response.status, status ? 409 : 503);
    assertEquals(calls.length, 0);
    assertEquals(events.length, 0);
  });
}
