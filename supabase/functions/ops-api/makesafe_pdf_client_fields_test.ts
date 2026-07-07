// Intake item 5 — deterministic WO-PDF client-block reader. Fixtures mirror the
// REAL MLB "Work Order" text-layer layout (Policyholders Name / Policyholders
// Contact / Site Address), captured from live WO PDFs, plus the failure shapes
// that MUST return nothing so a draft stays manual.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidePdfClientFill,
  extractClientFieldsFromPdfText,
} from "./makesafe_pdf_client_fields.ts";

// The MLB WO client block exactly as the text layer renders it (label line then
// value line). This is the canonical live layout (site 8 Syrinx Pl, MLB-26770).
const MLB_BLOCK = `Work Order
Work Order Number
MLB-26770PO-55296
Supervisor
Jesse Trutwein
Policyholders Name
Amanda Parker & Mr Steven Walter Fredrick Parker
Policyholders Contact
Mobile: 0422636182
Home:
Email:
amandaleeparker@yahoo.com
Insurer Name
RAC Insurance
Site Address
8 Syrinx Pl, Mullaloo, WA 6027
Other Contact Details`;

Deno.test("item5: a clean MLB block yields name + mobile + address, unambiguous", () => {
  const r = extractClientFieldsFromPdfText(MLB_BLOCK);
  assert(r.unambiguous, `expected unambiguous; note=${r.note}`);
  assertEquals(
    r.fields.client_name,
    "Amanda Parker & Mr Steven Walter Fredrick Parker",
  );
  assertEquals(r.fields.client_phone, "0422636182");
  assertEquals(r.fields.site_address, "8 Syrinx Pl, Mullaloo, WA 6027");
  assertEquals(r.found.sort(), ["client_name", "client_phone", "site_address"]);
});

Deno.test("item5: home-only phone (no mobile) is accepted as a landline", () => {
  const t = `Policyholders Name
Yew Ngui & Mr Sik Ngui
Policyholders Contact
Mobile:
Home: 0894982553
Site Address
19 Stuart Ct, Bateman, WA 6150`;
  const r = extractClientFieldsFromPdfText(t);
  assert(r.unambiguous);
  assertEquals(r.fields.client_name, "Yew Ngui & Mr Sik Ngui");
  assertEquals(r.fields.client_phone, "0894982553");
});

Deno.test("item5: prefers the mobile when both mobile and home are present", () => {
  const t = `Policyholders Name
Anne Dunbar & Mr Phillip Wadley
Policyholders Contact
Mobile: 0417 940 314
Home: 08 9417 9999
Site Address
80 San Jacinta Rd, Seville Grove, WA 6112`;
  const r = extractClientFieldsFromPdfText(t);
  assertEquals(r.fields.client_phone, "0417940314");
});

Deno.test("item5: colon-inline single-line labels are read", () => {
  const t = `Policyholder Name: John Smith
Mobile: 0431 000 111
Site Address: 12 Keane Ct, Noranda WA 6062`;
  const r = extractClientFieldsFromPdfText(t);
  assert(r.unambiguous);
  assertEquals(r.fields.client_name, "John Smith");
  assertEquals(r.fields.client_phone, "0431000111");
  assertEquals(r.fields.site_address, "12 Keane Ct, Noranda WA 6062");
});

Deno.test("item5: TWO conflicting policyholder names => ambiguous, fills NOTHING", () => {
  const t = `Policyholders Name
Adrian Allen
Mobile: 0435519636
...later in the doc...
Policyholders Name
Someone Else Entirely`;
  const r = extractClientFieldsFromPdfText(t);
  assertEquals(r.unambiguous, false);
  assertEquals(r.fields.client_name, null);
  assertEquals(r.fields.client_phone, null);
  assert(String(r.note).startsWith("ambiguous_client_name"));
});

Deno.test("item5: the same name repeated is NOT ambiguous (dedup)", () => {
  const t = `Policyholders Name
Adrian Allen
Site Address
3 Culloden Rd, Duncraig, WA 6023
Policyholders Name
Adrian Allen`;
  const r = extractClientFieldsFromPdfText(t);
  assert(r.unambiguous);
  assertEquals(r.fields.client_name, "Adrian Allen");
});

Deno.test("item5: unreadable CID text (repeated en-AU locale tokens) fills NOTHING", () => {
  // This is what makesafe_pdf_text recovers from a live MLB Identity-H WO — no
  // client labels survive, so the reader must return nothing (stay manual).
  const t = ("en-AU ".repeat(120)).trim();
  const r = extractClientFieldsFromPdfText(t);
  assertEquals(r.unambiguous, false);
  assertEquals(r.found.length, 0);
  assertEquals(r.note, "no_client_name_label");
});

Deno.test("item5: a non-address value at Site Address is not filled", () => {
  const t = `Policyholders Name
Jane Doe
Mobile: 0400 000 000
Site Address
See portal`;
  const r = extractClientFieldsFromPdfText(t);
  assert(r.unambiguous); // name+phone still clean
  assertEquals(r.fields.client_name, "Jane Doe");
  assertEquals(r.fields.site_address, null); // "See portal" is not a street address
});

Deno.test("item5: empty / tiny input returns nothing without throwing", () => {
  assertEquals(extractClientFieldsFromPdfText("").unambiguous, false);
  assertEquals(extractClientFieldsFromPdfText(null).unambiguous, false);
  assertEquals(extractClientFieldsFromPdfText("   ").found.length, 0);
});

Deno.test("item5: a body with a name label but no phone/address fills only the name", () => {
  const t = `Policyholders Name
Robert Brown
Insurer Name
RAC Insurance`;
  const r = extractClientFieldsFromPdfText(t);
  assert(r.unambiguous);
  assertEquals(r.fields.client_name, "Robert Brown");
  assertEquals(r.fields.client_phone, null);
  assertEquals(r.fields.site_address, null);
  assertEquals(r.found, ["client_name"]);
});

// ── decidePdfClientFill — the fill policy the scan/reextract wiring calls ──────

Deno.test("fill: fills ONLY nulls, tags fields, clears matching missing_fields", () => {
  const d = decidePdfClientFill(MLB_BLOCK, {
    clientName: null,
    clientPhone: null,
    siteAddress: "18 First Ave", // already present → must NOT be overwritten
    confidence: "medium",
    missingFields: ["client_name", "client_phone", "description"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assert(d.applied);
  assertEquals(
    d.fill.client_name,
    "Amanda Parker & Mr Steven Walter Fredrick Parker",
  );
  assertEquals(d.fill.client_phone, "0422636182");
  assertEquals(d.fill.site_address, undefined); // not overwritten
  assertEquals(d.filledFields.sort(), ["client_name", "client_phone"]);
  // client_name + client_phone dropped from missing_fields; description kept.
  assertEquals(d.missingFields, ["description"]);
});

Deno.test("fill: medium→high ONLY when unambiguous and otherwise clean", () => {
  const cleanInput = {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "medium",
    missingFields: ["client_name", "client_phone"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  };
  const d = decidePdfClientFill(MLB_BLOCK, cleanInput);
  assertEquals(d.confidence, "high");

  // Missing external_ref → NOT clean → no bump.
  const d2 = decidePdfClientFill(MLB_BLOCK, {
    ...cleanInput,
    externalRefPresent: false,
  });
  assertEquals(d2.confidence, "medium");
});

Deno.test("fill: NEVER bumps confidence from low", () => {
  const d = decidePdfClientFill(MLB_BLOCK, {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "low",
    missingFields: ["client_name", "client_phone"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assert(d.applied);
  assertEquals(d.confidence, "low"); // filled, but stays low → stays manual
});

Deno.test("fill: ambiguous read applies nothing and leaves confidence untouched", () => {
  const t = `Policyholders Name
Adrian Allen
Policyholders Name
Someone Else`;
  const d = decidePdfClientFill(t, {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "medium",
    missingFields: ["client_name", "client_phone"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assertEquals(d.applied, false);
  assertEquals(d.filledFields.length, 0);
  assertEquals(d.confidence, "medium");
  assertEquals(d.missingFields, ["client_name", "client_phone"]);
});

Deno.test("fill: unreadable CID text is a no-op (today's live MLB WOs)", () => {
  const d = decidePdfClientFill(("en-AU ".repeat(120)).trim(), {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "medium",
    missingFields: ["client_name", "client_phone"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assertEquals(d.applied, false);
  assertEquals(d.filledFields.length, 0);
});
