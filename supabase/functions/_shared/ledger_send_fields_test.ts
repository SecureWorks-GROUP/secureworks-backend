import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  customerContactForAddress,
  knownContactId,
  sendRecipientMetadata,
  singleEmailAddress,
} from "./ledger_send_fields.ts"

Deno.test("singleEmailAddress keeps one address and refuses everything else", () => {
  assertEquals(singleEmailAddress("  client@example.test "), "client@example.test")
  assertEquals(singleEmailAddress("Client@Example.Test"), "Client@Example.Test")
  assertEquals(singleEmailAddress("client"), null)
  assertEquals(singleEmailAddress("0400000000"), null)
  assertEquals(singleEmailAddress("19f00000-0000-4000-8000-000000000099"), null)
  assertEquals(singleEmailAddress("a@b.test, c@d.test"), null)
  assertEquals(singleEmailAddress("Name <client@example.test>"), null)
  assertEquals(singleEmailAddress(""), null)
  assertEquals(singleEmailAddress(null), null)
})

Deno.test("knownContactId is a stored id, never an address", () => {
  assertEquals(knownContactId(" ghl-customer-1 "), "ghl-customer-1")
  assertEquals(knownContactId("client@example.test"), null)
  assertEquals(knownContactId("  "), null)
  assertEquals(knownContactId(null), null)
})

Deno.test("customerContactForAddress matches the job client email only", () => {
  assertEquals(
    customerContactForAddress("Client@Example.Test", "client@example.test", "ghl-customer-1"),
    "ghl-customer-1",
  )
  assertEquals(
    customerContactForAddress("reports@builder.test", "client@example.test", "ghl-customer-1"),
    null,
  )
  assertEquals(
    customerContactForAddress("client@example.test", "client@example.test", "not-an-id@x"),
    null,
  )
  assertEquals(customerContactForAddress("client@example.test", "client@example.test", null), null)
})

Deno.test("sendRecipientMetadata stamps several_recipients from to, cc and bcc", () => {
  assertEquals(
    sendRecipientMetadata({
      recipients: ["client@example.test"],
      cc: [],
      bcc: [],
      contactId: "ghl-customer-1",
      clientEmail: "  Client@Example.Test ",
      matchCustomer: true,
    }),
    { several_recipients: false, contact_id: "ghl-customer-1" },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["reports@builder.test"],
      contactId: "ghl-customer-1",
      clientEmail: "client@example.test",
      matchCustomer: true,
    }),
    { several_recipients: false },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["client@example.test"],
      cc: ["ops@secureworks.test"],
      contactId: "ghl-customer-1",
      clientEmail: "client@example.test",
      matchCustomer: true,
    }),
    { several_recipients: true, cc_emails: ["ops@secureworks.test"] },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["client@example.test"],
      bcc: ["records@secureworks.test"],
      contactId: "ghl-customer-1",
      matchCustomer: true,
    }),
    { several_recipients: true, bcc_emails: ["records@secureworks.test"] },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["a@b.test", "c@d.test"],
      contactId: "ghl-customer-1",
    }),
    { several_recipients: true },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["client@example.test"],
      contactId: "ghl-customer-1",
      uncertainExtra: true,
    }),
    { several_recipients: true },
  )
  assertEquals(
    sendRecipientMetadata({ recipients: ["client@example.test"], contactId: "ghl-customer-1" }),
    { several_recipients: false, contact_id: "ghl-customer-1" },
  )
  assertEquals(sendRecipientMetadata({ recipients: [] }), {})
})

Deno.test("outlook writes stamp several_recipients and client_email matches the job", async () => {
  const outlook = await Deno.readTextFile(
    new URL("../send-outlook-email/index.ts", import.meta.url),
  )
  const forward = outlook.slice(
    outlook.indexOf("const forwardRecipient = sendRecipientMetadata("),
    outlook.indexOf("email_type: 'forward'"),
  )
  assertEquals(forward.includes("cc,"), true)
  assertEquals(forward.includes("bcc: forwardBcc"), true)
  assertEquals(forward.includes("uncertainExtra: forwardBccUnreadable"), true)
  const client = outlook.slice(outlook.indexOf("let clientEmail: unknown = null"))
  assertEquals(client.includes("recipients: to,"), true)
  assertEquals(client.includes("cc,"), true)
  assertEquals(client.includes("bcc,"), true)
  assertEquals(client.includes("matchCustomer: true"), true)
  assertEquals(client.includes(".select('client_email')"), true)
  const ops = await Deno.readTextFile(new URL("../ops-api/index.ts", import.meta.url))
  const reconcile = ops.slice(
    ops.indexOf("async function reconcilePayment("),
    ops.indexOf("async function createWorkOrder("),
  )
  assertEquals(reconcile.includes("job_id: gated.job_id"), false)
  assertEquals(reconcile.includes("event_type: 'payment_recorded'"), true)
  const insert = reconcile.slice(reconcile.indexOf("await client.from('job_events').insert({"))
  assertEquals(insert.includes("job_id"), false)
})
