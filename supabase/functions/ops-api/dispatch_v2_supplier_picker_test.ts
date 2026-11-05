// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 Tweak 4: the simpler supplier picker's rules
// (dispatch_v2_supplier_picker.ts), each on its own. No database: the rows
// are handed in. Supplier names are the real approved names; contacts and
// ids are made up.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_V2_NO_APPROVED_EMAIL_NOTE,
  DISPATCH_V2_NO_XERO_NOTE,
  dispatchV2BuildSupplierPicker,
  type DispatchV2LinkedContact,
  dispatchV2MainReason,
  dispatchV2RankLinkedContacts,
  dispatchV2SupplierDisplayName,
  dispatchV2SupplierNameMatches,
  dispatchV2SupplierSearchKey,
  dispatchV2SupplierSearchWords,
} from "./dispatch_v2_supplier_picker.ts";

// ── Search words ────────────────────────────────────────────────────────────

Deno.test("search key: B&D, BD, b and d, bnd all read as bd", () => {
  for (const v of ["B&D", "BD", "b and d", "B & D", "bnd", "B n D", "b+d"]) {
    assertEquals(dispatchV2SupplierSearchKey(v), "bd", v);
  }
  assertEquals(dispatchV2SupplierSearchKey("B&D Metals Group"), "bdmetalsgroup");
  assertEquals(dispatchV2SupplierSearchKey("BD Metals"), "bdmetals");
});

Deno.test("search key: R&R, RnR, r and r all read as rr", () => {
  for (const v of ["R&R", "RnR", "rnr", "r and r", "R & R", "R n R", "R+R"]) {
    assertEquals(dispatchV2SupplierSearchKey(v), "rr", v);
  }
  assertEquals(dispatchV2SupplierSearchKey("RnR Fencing"), "rrfencing");
  assertEquals(dispatchV2SupplierSearchKey("R&R FENCING"), "rrfencing");
});

Deno.test("search words: ordinary words with an n are left alone", () => {
  assertEquals(dispatchV2SupplierSearchWords("and one sun"), ["and", "one", "sun"]);
  assertEquals(dispatchV2SupplierSearchWords("Bunnings Group Limited"), ["bunnings", "group", "limited"]);
  // A lone "and" between two longer words stays a word.
  assertEquals(dispatchV2SupplierSearchWords("Fencing and Gates"), ["fencing", "and", "gates"]);
  // Punctuation is a space.
  assertEquals(dispatchV2SupplierSearchWords("Stratco (WA) Pty. Ltd"), ["stratco", "wa", "pty", "ltd"]);
  assertEquals(dispatchV2SupplierSearchWords(null), []);
});

Deno.test("name matches: every short form finds both the approved and the Xero names", () => {
  const names = ["BD Metals", "B&D Metals Group", "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty"];
  for (const q of ["bd", "b&d", "b and d", "B&D metals"]) {
    for (const name of names) {
      assertEquals(dispatchV2SupplierNameMatches(name, q), true, `${q} -> ${name}`);
    }
  }
  for (const q of ["rnr", "r&r", "r and r"]) {
    assertEquals(dispatchV2SupplierNameMatches("RnR Fencing", q), true, q);
    assertEquals(dispatchV2SupplierNameMatches("R&R FENCING", q), true, q);
  }
  assertEquals(dispatchV2SupplierNameMatches("Metroll Perth", "bd"), false);
  // An empty search matches everything.
  assertEquals(dispatchV2SupplierNameMatches("Metroll Perth", ""), true);
  assertEquals(dispatchV2SupplierNameMatches("Metroll Perth", "  "), true);
});

// ── The main Xero contact ───────────────────────────────────────────────────

function contact(over: Partial<DispatchV2LinkedContact>): DispatchV2LinkedContact {
  return {
    supplier_id: "s-x",
    name: "Contact",
    is_active: true,
    has_xero_contact: true,
    bills_12m: 0,
    last_bill_date: null,
    is_pinned: false,
    ...over,
  };
}

Deno.test("rank: most bills first; a tie goes to the newest bill; inactive contacts are dropped", () => {
  const ranked = dispatchV2RankLinkedContacts([
    contact({ supplier_id: "a", name: "A", bills_12m: 5, last_bill_date: "2026-09-01" }),
    contact({ supplier_id: "b", name: "B", bills_12m: 36, last_bill_date: "2026-10-01" }),
    contact({ supplier_id: "c", name: "C", bills_12m: 36, last_bill_date: "2026-10-29" }),
    contact({ supplier_id: "d", name: "D", bills_12m: 99, is_active: false }),
  ]);
  assertEquals(ranked.map((c) => c.supplier_id), ["c", "b", "a"]);
  assertEquals(dispatchV2MainReason(ranked), "most_bills");
});

Deno.test("rank: a pin always wins (the CMI pin)", () => {
  const ranked = dispatchV2RankLinkedContacts([
    contact({ supplier_id: "trustee", name: "Trustee 36", bills_12m: 40, last_bill_date: "2026-10-15" }),
    contact({ supplier_id: "cmiwa", name: "CMI WA", bills_12m: 21, last_bill_date: "2026-10-29", is_pinned: true }),
  ]);
  assertEquals(ranked.map((c) => c.supplier_id), ["cmiwa", "trustee"]);
  assertEquals(dispatchV2MainReason(ranked), "pinned");
});

Deno.test("rank: with no bills, a contact Xero knows comes first, then by name", () => {
  const ranked = dispatchV2RankLinkedContacts([
    contact({ supplier_id: "z", name: "Zed", has_xero_contact: true }),
    contact({ supplier_id: "h", name: "Hand made", has_xero_contact: false }),
    contact({ supplier_id: "a", name: "Able", has_xero_contact: true }),
  ]);
  assertEquals(ranked.map((c) => c.supplier_id), ["a", "z", "h"]);
  assertEquals(dispatchV2MainReason(ranked), "no_bills");
  assertEquals(dispatchV2MainReason(ranked.slice(0, 1)), "only_contact");
  assertEquals(dispatchV2MainReason([]), null);
});

Deno.test("rank: unreadable bill counts (null) rank by name, never throw", () => {
  const ranked = dispatchV2RankLinkedContacts([
    contact({ supplier_id: "b", name: "Bee", bills_12m: null }),
    contact({ supplier_id: "a", name: "Ay", bills_12m: null }),
  ]);
  assertEquals(ranked.map((c) => c.supplier_id), ["a", "b"]);
});

// ── The name a box shows ────────────────────────────────────────────────────

Deno.test("display name: the approved name when linked to an active entry, else the Xero name", () => {
  assertEquals(
    dispatchV2SupplierDisplayName({ name: "BD Metals", active: true }, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty"),
    "BD Metals",
  );
  assertEquals(dispatchV2SupplierDisplayName({ name: "BD Metals", active: false }, "Jaiama"), "Jaiama");
  assertEquals(dispatchV2SupplierDisplayName(null, "Plain Hardware"), "Plain Hardware");
  assertEquals(dispatchV2SupplierDisplayName(undefined, "  "), null);
});

// ── The picker's answer ─────────────────────────────────────────────────────

function pickerInput(q: string, over: Record<string, any> = {}) {
  const contacts = new Map<string, any>([
    ["bd1", { id: "bd1", name: "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty", is_active: true, xero_contact_id: "x1" }],
    ["bd2", { id: "bd2", name: "B & D Metals", is_active: true, xero_contact_id: "x2" }],
    ["bd3", { id: "bd3", name: "B&D Metals Group (old)", is_active: false, xero_contact_id: "x3" }],
    ["rr1", { id: "rr1", name: "R&R FENCING", is_active: true, xero_contact_id: "x4" }],
  ]);
  return {
    entries: [
      { id: "e-bd", name: "BD Metals", used_for: "fencing", to_emails: ["o@bd.test"], cc_emails: [], on_account: false },
      { id: "e-fi", name: "Fielders", used_for: "patio", to_emails: ["o@fi.test"], cc_emails: [], on_account: false },
      { id: "e-rr", name: "RnR Fencing", used_for: "fencing", to_emails: ["o@rr.test"], cc_emails: ["c@rr.test"], on_account: true },
    ],
    links: [
      { supplier_id: "bd1", approved_id: "e-bd" },
      { supplier_id: "bd2", approved_id: "e-bd" },
      { supplier_id: "bd3", approved_id: "e-bd" },
      { supplier_id: "rr1", approved_id: "e-rr" },
    ],
    contacts,
    bills: new Map([
      ["bd1", { bills_12m: 36, last_bill_date: "2026-10-30", is_pinned: false }],
      ["bd2", { bills_12m: 3, last_bill_date: "2026-08-01", is_pinned: false }],
      ["rr1", { bills_12m: 217, last_bill_date: "2026-11-04", is_pinned: false }],
    ]),
    others: [
      { id: "o1", name: "B and D Steel Supplies" },
      { id: "o2", name: "Plain Hardware" },
    ],
    q,
    limit: 25,
    ...over,
  };
}

Deno.test("picker: b&d gives one BD Metals row, its other active contact under Show more, and a one-off match", () => {
  const out = dispatchV2BuildSupplierPicker(pickerInput("b&d"));
  assertEquals(out.approved.length, 1);
  const row = out.approved[0];
  assertEquals(
    [row.name, row.approved_name, row.supplier_id, row.xero_name, row.main_reason, row.other_contacts, row.can_add, row.note],
    ["BD Metals", "BD Metals", "bd1", "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty", "most_bills", 1, true, null],
  );
  assertEquals(row.to, ["o@bd.test"]);
  // The inactive contact is never offered.
  assertEquals(out.more_approved.map((m: any) => [m.name, m.supplier_id, m.approved_id]), [["B & D Metals", "bd2", "e-bd"]]);
  // A one-off supplier is still found by typing.
  assertEquals(out.others.map((o: any) => [o.name, o.has_approved_email, o.note]), [
    ["B and D Steel Supplies", false, DISPATCH_V2_NO_APPROVED_EMAIL_NOTE],
  ]);
});

Deno.test("picker: an empty search lists all approved suppliers in order, greyed when there is no Xero contact", () => {
  const out = dispatchV2BuildSupplierPicker(pickerInput(""));
  assertEquals(out.approved.map((a: any) => [a.name, a.supplier_id, a.can_add]), [
    ["BD Metals", "bd1", true],
    ["Fielders", null, false],
    ["RnR Fencing", "rr1", true],
  ]);
  assertEquals(out.approved[1].note, DISPATCH_V2_NO_XERO_NOTE);
  assertEquals(out.approved[1].main_reason, null);
  assertEquals(out.approved[2].on_account, true);
  assertEquals(out.others.map((o: any) => o.name), ["B and D Steel Supplies", "Plain Hardware"]);
});

Deno.test("picker: rnr finds RnR Fencing by the approved or the Xero name; the limit caps the others", () => {
  const out = dispatchV2BuildSupplierPicker(pickerInput("rnr"));
  assertEquals(out.approved.map((a: any) => [a.name, a.supplier_id, a.main_reason]), [["RnR Fencing", "rr1", "only_contact"]]);
  assertEquals(out.more_approved, []);
  assertEquals(out.others, []);
  const capped = dispatchV2BuildSupplierPicker(pickerInput("", { limit: 1 }));
  assertEquals(capped.others.map((o: any) => o.name), ["B and D Steel Supplies"]);
});

Deno.test("picker: unreadable bill counts leave bills_12m null and still pick a main contact", () => {
  const out = dispatchV2BuildSupplierPicker(pickerInput("bd", { bills: null }));
  assertEquals(out.approved.length, 1);
  assertEquals(out.approved[0].bills_12m, null);
  // By name: "B & D Metals" sorts before "Jaiama ...".
  assertEquals(out.approved[0].supplier_id, "bd2");
});
