// deno-lint-ignore-file no-import-prefix
// Party roles reader (B-6, migration 20261005200000): what a reader shows for
// a message's sender and recipient.
//
// Pins:
//   L1d label    audience internal with recipient_role crew or staff reads
//                "internal: crew" / "internal: staff", staff to crew/staff,
//                whatever party_roles says (the ladder wins).
//   Stamp        party_roles is read as stamped: customer to staff, staff to
//                supplier, insurer_builder in plain words; an internal stamp
//                (a crew member texting in) reads "internal: crew".
//   other_party  the ladder's other_party audience stands over a stamp.
//   No roles     a row with neither reads unknown, never internal, never a
//                customer.
//   Junk         an unknown role or audience value reads unknown.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  customerThreadPartyRoles,
  partyRoleWords,
  readMessagePartyRoles,
  staffNotePartyRoles,
} from "./party_roles.ts";

Deno.test("L1d label: a crew text reads internal: crew, whatever the stamp says", () => {
  const r = readMessagePartyRoles({
    audience: "internal",
    recipient_role: "crew",
    recipient_role_source: "wording",
    party_roles: {
      sender_role: "staff",
      recipient_role: "customer",
      audience: "customer",
    },
  });
  assertEquals(r, {
    sender_role: "staff",
    recipient_role: "crew",
    counterpart_role: "crew",
    audience: "internal",
    internal: true,
    label: "internal: crew",
    basis: "ladder_internal",
  });
  const s = readMessagePartyRoles({
    audience: "internal",
    recipient_role: "staff",
  });
  assertEquals([s.label, s.recipient_role, s.internal], [
    "internal: staff",
    "staff",
    true,
  ]);
});

Deno.test("stamp: customer, supplier and insurer or builder rows read as stamped", () => {
  const c = readMessagePartyRoles({
    party_roles: {
      version: "party_roles_v1",
      sender_role: "customer",
      recipient_role: "staff",
      counterpart_role: "customer",
      basis: "job_customer",
      audience: "customer",
    },
  });
  assertEquals([c.label, c.audience, c.internal, c.basis], [
    "customer to staff",
    "customer",
    false,
    "job_customer",
  ]);
  const s = readMessagePartyRoles({
    party_roles: {
      sender_role: "staff",
      recipient_role: "insurer_builder",
      counterpart_role: "insurer_builder",
      basis: "builder_company",
      audience: "other_party",
    },
  });
  assertEquals([s.label, s.audience, s.internal], [
    "staff to insurer or builder",
    "other_party",
    false,
  ]);
  assertEquals(partyRoleWords("supplier"), "supplier");
});

Deno.test("stamp: a crew member texting in reads internal: crew", () => {
  const r = readMessagePartyRoles({
    party_roles: {
      sender_role: "crew",
      recipient_role: "staff",
      counterpart_role: "crew",
      basis: "writer_marked_contact",
      audience: "internal",
    },
  });
  assertEquals([r.label, r.internal, r.sender_role], [
    "internal: crew",
    true,
    "crew",
  ]);
});

Deno.test("other_party: the ladder's label stands over a stamp", () => {
  const r = readMessagePartyRoles({
    audience: "other_party",
    recipient_role: "other",
    party_roles: {
      sender_role: "staff",
      recipient_role: "customer",
      counterpart_role: "customer",
      basis: "any_job_customer",
      audience: "customer",
    },
  });
  assertEquals([r.audience, r.internal], ["other_party", false]);
});

Deno.test("no roles: unknown, never internal and never a customer", () => {
  for (const m of [null, undefined, {}, { party_roles: "x" }, []]) {
    const r = readMessagePartyRoles(m);
    assertEquals([
      r.sender_role,
      r.recipient_role,
      r.audience,
      r.internal,
      r.basis,
    ], ["unknown", "unknown", "unknown", false, "none"]);
  }
});

Deno.test("junk role or audience values read unknown", () => {
  const r = readMessagePartyRoles({
    party_roles: {
      sender_role: "boss",
      recipient_role: "staff",
      audience: "everyone",
    },
  });
  assertEquals([r.sender_role, r.audience, r.internal], [
    "unknown",
    "unknown",
    false,
  ]);
});

Deno.test("the customer's CRM thread and staff notes", () => {
  assertEquals(customerThreadPartyRoles("outbound").label, "staff to customer");
  assertEquals(customerThreadPartyRoles("inbound").label, "customer to staff");
  assertEquals(staffNotePartyRoles().label, "internal: staff");
});
