import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AJS_WORK_ORDERS_MAILBOX } from "./ses_graph_mail_gateway.ts";
import {
  applySesSampleDestinationOverride,
  assertSesSampleSendAllowed,
  isSesSampleDocket,
  isSesSampleJobNumber,
  SES_SAMPLE_DESTINATION_ENV,
} from "./ses_sample_destination.ts";

const PERSONAL = "captain-personal@example.test";

Deno.test("SAMPLE job numbers are the only numbers that trigger rewrite", () => {
  assertEquals(isSesSampleJobNumber("SAMPLE-AJS-0001"), true);
  assertEquals(isSesSampleJobNumber("SWMS-SAMPLE-0001"), true);
  assertEquals(isSesSampleJobNumber("SWMS-261205"), false);
  assertEquals(isSesSampleJobNumber("AJBR-70100"), false);
});

Deno.test("SAMPLE docket is detected from job_number or SAMPLE builder_reference", () => {
  assertEquals(
    isSesSampleDocket({ job_number: "SAMPLE-AJS-0001" }),
    true,
  );
  assertEquals(
    isSesSampleDocket({
      job_number: "SWMS-261205",
      local_invoice_proposal: { builder_reference: "SAMPLE-AJS-0001" },
    }),
    true,
  );
  assertEquals(
    isSesSampleDocket({
      job_number: "SWMS-261205",
      local_invoice_proposal: { builder_reference: "AJBR-70100" },
    }),
    false,
  );
});

Deno.test("live docket recipients are untouched", () => {
  const routes = applySesSampleDestinationOverride(
    { job_number: "SWMS-261205" },
    [{
      recipients: [AJS_WORK_ORDERS_MAILBOX],
      cc: ["ses@secureworkswa.com.au"],
      ready: true,
    }],
    { get: () => PERSONAL },
  );
  assertEquals(routes[0].recipients, [AJS_WORK_ORDERS_MAILBOX]);
  assertEquals(routes[0].cc, ["ses@secureworkswa.com.au"]);
  assertEquals(routes[0].ready, true);
});

Deno.test("SAMPLE with personal inbox env rewrites To and blanks cc", () => {
  const routes = applySesSampleDestinationOverride(
    { job_number: "SAMPLE-AJS-0001" },
    [{
      recipients: [AJS_WORK_ORDERS_MAILBOX],
      cc: ["ses@secureworkswa.com.au", "vanessa@ajs.build"],
      ready: true,
    }],
    { get: (key) => key === SES_SAMPLE_DESTINATION_ENV ? PERSONAL : undefined },
  );
  assertEquals(routes[0].recipients, [PERSONAL]);
  assertEquals(routes[0].cc, []);
  assertEquals(routes[0].ready, true);
  assertEquals(routes[0].sample_destination_override, true);
});

Deno.test("SAMPLE without env blanks the envelope so Send it cannot light", () => {
  const routes = applySesSampleDestinationOverride(
    { job_number: "SAMPLE-AJS-0001" },
    [{
      recipients: [AJS_WORK_ORDERS_MAILBOX],
      cc: ["ses@secureworkswa.com.au"],
      ready: true,
    }],
    { get: () => undefined },
  );
  assertEquals(routes[0].recipients, []);
  assertEquals(routes[0].cc, []);
  assertEquals(routes[0].ready, false);
  assertEquals(routes[0].sample_destination_blocked, true);
});

Deno.test("SAMPLE override that is itself a builder mailbox is refused", () => {
  const routes = applySesSampleDestinationOverride(
    { job_number: "SAMPLE-AJS-0001" },
    [{ recipients: [AJS_WORK_ORDERS_MAILBOX], cc: [], ready: true }],
    { get: () => AJS_WORK_ORDERS_MAILBOX },
  );
  assertEquals(routes[0].recipients, []);
  assertEquals(routes[0].ready, false);
});

Deno.test("Graph send refuses a SAMPLE envelope that still names a builder", () => {
  assertThrows(
    () =>
      assertSesSampleSendAllowed({
        sample_destination_override: true,
        recipients: [AJS_WORK_ORDERS_MAILBOX],
        cc: [],
      }),
    Error,
    "live builder",
  );
  assertThrows(
    () => assertSesSampleSendAllowed({ sample_destination_blocked: true }),
    Error,
    "SES_SAMPLE_DESTINATION_OVERRIDE",
  );
});
