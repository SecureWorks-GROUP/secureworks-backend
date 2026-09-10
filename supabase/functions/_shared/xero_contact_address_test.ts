import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { contactAddressUpdate, contactNeedsPostalAddress, parseAuAddress, xeroAddressesFor } from "./xero_contact_address.ts";

Deno.test("Google-style address splits into street, suburb, state, postcode", () => {
  assertEquals(parseAuAddress("12 Pebbly Way, Clarkson WA 6030, Australia", "Clarkson"),
    { street: "12 Pebbly Way", suburb: "Clarkson", state: "WA", postcode: "6030" });
  assertEquals(parseAuAddress("3/3 Alga St, Scarborough WA 6019, Australia"),
    { street: "3/3 Alga St", suburb: "Scarborough", state: "WA", postcode: "6019" });
  assertEquals(parseAuAddress("117A St Leonards Ave, West Leederville WA 6007, Australia"),
    { street: "117A St Leonards Ave", suburb: "West Leederville", state: "WA", postcode: "6007" });
});

Deno.test("state without postcode, and no state at all, still parse", () => {
  assertEquals(parseAuAddress("18 Tallow Way, Bennett Springs WA", "Bennett Springs"),
    { street: "18 Tallow Way", suburb: "Bennett Springs", state: "WA", postcode: "" });
  assertEquals(parseAuAddress("20 Iselin Rd, Two Rocks", "Two Rocks"),
    { street: "20 Iselin Rd", suburb: "Two Rocks", state: "WA", postcode: "" });
});

Deno.test("make-safe SHOUTING intake is title-cased; suburb hint fills a bare street", () => {
  assertEquals(parseAuAddress("3 HODGSON STREET, Tuart Hill", "Tuart Hill"),
    { street: "3 Hodgson Street", suburb: "Tuart Hill", state: "WA", postcode: "" });
  assertEquals(parseAuAddress("16 Wright Ave", "Swanbourne"),
    { street: "16 Wright Ave", suburb: "Swanbourne", state: "WA", postcode: "" });
  assertEquals(parseAuAddress("16 Wright Ave Swanbourne", "Swanbourne"),
    { street: "16 Wright Ave", suburb: "Swanbourne", state: "WA", postcode: "" });
  assertEquals(parseAuAddress("", ""), null);
  assertEquals(parseAuAddress(null, "Joondalup"), { street: "", suburb: "Joondalup", state: "WA", postcode: "" });
});

Deno.test("a new contact gets POBOX (invoices print it) and STREET, no raw string in line 1", () => {
  const list = xeroAddressesFor("10 Cameron St, Embleton WA 6062, Australia", "Embleton");
  assertEquals(list, [
    { AddressType: "POBOX", Country: "Australia", AddressLine1: "10 Cameron St", City: "Embleton", Region: "WA", PostalCode: "6062" },
    { AddressType: "STREET", Country: "Australia", AddressLine1: "10 Cameron St", City: "Embleton", Region: "WA", PostalCode: "6062" },
  ]);
  assertEquals(xeroAddressesFor(undefined, undefined), []);
});

Deno.test("existing contact: only patched when the postal address is empty", () => {
  const blank = { ContactID: "c1", Addresses: [{ AddressType: "POBOX" }, { AddressType: "STREET" }] };
  assertEquals(contactNeedsPostalAddress(blank), true);
  const patch = contactAddressUpdate(blank, "7 Sava Cove, Stratton WA 6056, Australia", "Stratton");
  assertEquals(patch, { ContactID: "c1", Addresses: [
    { AddressType: "POBOX", Country: "Australia", AddressLine1: "7 Sava Cove", City: "Stratton", Region: "WA", PostalCode: "6056" },
    { AddressType: "STREET", Country: "Australia", AddressLine1: "7 Sava Cove", City: "Stratton", Region: "WA", PostalCode: "6056" },
  ] });

  const filled = { ContactID: "c2", Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 9", City: "Perth" }] };
  assertEquals(contactNeedsPostalAddress(filled), false);
  assertEquals(contactAddressUpdate(filled, "7 Sava Cove, Stratton WA 6056", "Stratton"), null);

  // The old automation wrote a STREET only: keep it, add the postal copy.
  const streetOnly = { ContactID: "c3", Addresses: [{ AddressType: "STREET", AddressLine1: "10 Cameron St, Embleton WA 6062, Australia", City: "Embleton", Region: "WA" }] };
  const p3 = contactAddressUpdate(streetOnly, "10 Cameron St, Embleton WA 6062, Australia", "Embleton");
  assertEquals(p3?.Addresses.length, 2);
  assertEquals(p3?.Addresses[0].AddressType, "POBOX");
  assertEquals(p3?.Addresses[0].AddressLine1, "10 Cameron St");
  assertEquals(p3?.Addresses[1].AddressType, "STREET");

  assertEquals(contactAddressUpdate(blank, "", ""), null);
  assertEquals(contactAddressUpdate({ Addresses: [] }, "1 A St", "B"), null);
});
