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

Deno.test("sendRecipientMetadata stamps one recipient and marks several", () => {
  assertEquals(
    sendRecipientMetadata({
      recipients: ["client@example.test"],
      contactId: "ghl-customer-1",
      clientEmail: "client@example.test",
      matchCustomer: true,
    }),
    { contact_id: "ghl-customer-1" },
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["reports@builder.test"],
      contactId: "ghl-customer-1",
      clientEmail: "client@example.test",
      matchCustomer: true,
    }),
    {},
  )
  assertEquals(
    sendRecipientMetadata({
      recipients: ["a@b.test", "c@d.test"],
      contactId: "ghl-customer-1",
    }),
    { several_recipients: true },
  )
  assertEquals(
    sendRecipientMetadata({ recipients: ["client@example.test"], contactId: "ghl-customer-1" }),
    { contact_id: "ghl-customer-1" },
  )
  assertEquals(sendRecipientMetadata({ recipients: [] }), {})
})
