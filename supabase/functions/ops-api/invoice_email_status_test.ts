import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendIssuedInvoiceEmail } from "./invoice_email_status.ts";

for (
  const status of [
    "DRAFT",
    "SUBMITTED",
    "VOIDED",
    "DELETED",
    "unknown",
    "",
    null,
    undefined,
  ]
) {
  Deno.test(`invoice email refuses ${String(status)} without calling the email provider`, async () => {
    let sends = 0;
    const result = await sendIssuedInvoiceEmail(
      () => Promise.resolve({ Invoices: [{ Status: status }] }),
      () => {
        sends++;
        return Promise.resolve();
      },
    );
    assertEquals(result?.status_code, status ? 409 : 503);
    assertEquals(sends, 0);
  });
}

Deno.test("missing live invoice refuses email", async () => {
  let sends = 0;
  const result = await sendIssuedInvoiceEmail(
    () => Promise.resolve({ Invoices: [] }),
    () => {
      sends++;
      return Promise.resolve();
    },
  );
  assertEquals(result?.code, "invoice_email_status_unknown");
  assertEquals(sends, 0);
});

Deno.test("unreadable live invoice preserves the read error and sends nothing", async () => {
  let sends = 0;
  await assertRejects(
    () =>
      sendIssuedInvoiceEmail(
        () => Promise.reject(new Error("read unavailable")),
        () => {
          sends++;
          return Promise.resolve();
        },
      ),
    Error,
    "read unavailable",
  );
  assertEquals(sends, 0);
});

for (const status of ["AUTHORISED", "PAID"]) {
  Deno.test(`issued ${status} invoice emails once after its live read`, async () => {
    const effects: string[] = [];
    const result = await sendIssuedInvoiceEmail(
      () => {
        effects.push("read");
        return Promise.resolve({ Invoices: [{ Status: status }] });
      },
      () => {
        effects.push("email");
        return Promise.resolve();
      },
    );
    assertEquals(result, null);
    assertEquals(effects, ["read", "email"]);
  });
}
