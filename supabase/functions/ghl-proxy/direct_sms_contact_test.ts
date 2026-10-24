import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DIRECT_SMS_TAG,
  contactIdFromDuplicateError,
  duplicateSearchPhones,
  plainContactCreateBody,
  toAuE164,
} from "./direct_sms_contact.ts";

Deno.test("Australian mobiles and landlines become E.164", () => {
  assertEquals(toAuE164("0412 345 678"), { ok: true, e164: "+61412345678" });
  assertEquals(toAuE164("+61 412 345 678"), { ok: true, e164: "+61412345678" });
  assertEquals(toAuE164("61412345678"), { ok: true, e164: "+61412345678" });
  assertEquals(toAuE164("412345678"), { ok: true, e164: "+61412345678" });
  assertEquals(toAuE164("(08) 9444 1234"), { ok: true, e164: "+61894441234" });
  assertEquals(toAuE164("+61489267771"), { ok: true, e164: "+61489267771" });
});

Deno.test("a non-Australian number is refused before any contact is created", () => {
  for (const raw of ["", "  ", "not-a-number", "+447911123456", "1300123456", "1800 123 456", "+1 202 555 0123", "04123"]) {
    const parsed = toAuE164(raw);
    assertEquals(parsed.ok, false, raw);
  }
  assertEquals(toAuE164(412345678).ok, false);
});

Deno.test("a new direct contact is a named phone with the direct-sms tag and no opportunity", () => {
  const body = plainContactCreateBody("+61412345678", "Office Test", "loc-1");
  assertEquals(body, {
    firstName: "Office",
    lastName: "Test",
    phone: "+61412345678",
    locationId: "loc-1",
    tags: [DIRECT_SMS_TAG],
  });
  assertEquals(body.tags, ["direct-sms"]);
  for (const absent of ["opportunityId", "pipelineId", "toolType", "skipOpportunity", "email"]) {
    assertEquals(Object.hasOwn(body, absent), false, absent);
  }
  assertEquals(duplicateSearchPhones("+61412345678"), ["0412345678", "+61412345678"]);
  assertEquals(
    contactIdFromDuplicateError('duplicate {"contactId":"ghl-existing","message":"already exists"}'),
    "ghl-existing",
  );
});

Deno.test("the direct-sms send path tags only a contact it creates and never opens an opportunity", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("action === 'send_sms'");
  const end = source.indexOf("action === 'send_email'", start);
  const handler = source.slice(start, end);
  assertEquals(start > 0 && end > start, true);
  assertEquals(handler.includes("plainContactCreateBody"), true);
  assertEquals(handler.includes("directSms === true"), true);
  assertEquals(handler.includes("toAuE164(phone)"), true);
  assertEquals(handler.includes("/opportunities/"), false);
  assertEquals(handler.includes("create_contact_and_opportunity"), false);
  // Crew and staff texts keep the phone-only find-or-create. They are not retagged.
  assertEquals(handler.includes("{ phone, locationId: GHL_LOCATION_ID }"), true);
});
