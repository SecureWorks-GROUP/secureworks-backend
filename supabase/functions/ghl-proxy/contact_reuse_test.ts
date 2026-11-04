import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { contactReuseDecision } from "./contact_reuse.ts";
import { executeFenceJobMint, FenceMintError, validateFenceMintInput } from "./fence_mint.ts";

Deno.test("an email match is reused", () => {
  assertEquals(contactReuseDecision({
    matchedBy: "email",
    wantedFirst: "Marnin",
    wantedLast: "Test",
    wantedEmail: "a@example.com",
    existingFirst: "Other",
    existingLast: "Name",
    existingEmail: "a@example.com",
  }).action, "reuse");
});

Deno.test("a phone match with the same name and email is reused", () => {
  assertEquals(contactReuseDecision({
    matchedBy: "phone",
    wantedFirst: "Ada",
    wantedLast: "Lovelace",
    wantedEmail: "ada@example.com",
    existingFirst: "Ada",
    existingLast: "Lovelace",
    existingEmail: "ada@example.com",
  }).action, "reuse");
});

Deno.test("a phone match whose email differs is not linked and does not change the contact", () => {
  const decision = contactReuseDecision({
    matchedBy: "phone",
    wantedFirst: "New",
    wantedLast: "Person",
    wantedEmail: "new@example.com",
    existingFirst: "Old",
    existingLast: "Person",
    existingEmail: "old@example.com",
  });
  assertEquals(decision.action, "choose");
  if (decision.action !== "choose") return;
  assertEquals(decision.message.includes("was not changed"), true);
  assertEquals(decision.message.includes("was not linked"), true);
  assertEquals(decision.existingEmail, "old@example.com");
});

Deno.test("a phone match whose name differs is not linked", () => {
  assertEquals(contactReuseDecision({
    matchedBy: "phone",
    wantedFirst: "New",
    wantedLast: "Name",
    wantedEmail: "",
    existingName: "Old Name",
    existingEmail: "",
  }).action, "choose");
});

Deno.test("mint does not link or create when the phone is already on a different contact", async () => {
  const created: string[] = [];
  const bound: string[] = [];
  const input = validateFenceMintInput({
    requestId: "11111111-1111-4111-8111-111111111111",
    organisationId: "00000000-0000-0000-0000-000000000001",
    intent: "RESOLVED_NO_JOB",
    firstName: "New",
    lastName: "Person",
    email: "new@example.com",
    phone: "0400000000",
    address: "1 Test Street",
    suburb: "Perth",
  });
  const error = await assertRejects(() => executeFenceJobMint({
    input,
    actorId: "user-1",
    deps: {
      fencePipelineId: "pipe",
      reserve: async () => ({
        ownerRequestId: input.requestId,
        state: "reserved",
        joined: false,
        executor: true,
        contactId: null,
        opportunityId: null,
        attemptCount: 1,
        canonical: null,
      }),
      bindIdentity: async () => {
        bound.push("bound");
        throw new Error("should not bind");
      },
      recordOpportunity: async () => { throw new Error("should not record"); },
      complete: async () => { throw new Error("should not complete"); },
      awaitCanonical: async () => null,
      getContact: async () => { throw new Error("should not get"); },
      findContacts: async () => [{
        id: "existing-contact",
        firstName: "Old",
        lastName: "Person",
        email: "old@example.com",
        phone: "0400000000",
      }],
      createContact: async () => {
        created.push("created");
        return { id: "new-contact" };
      },
      getOpportunity: async () => { throw new Error("should not get opportunity"); },
      findStampedOpportunity: async () => null,
      createStampedOpportunity: async () => { throw new Error("should not create opportunity"); },
    },
  }), FenceMintError);
  assertEquals(error.code, "contact_choice_required");
  assertEquals(created, []);
  assertEquals(bound, []);
});
