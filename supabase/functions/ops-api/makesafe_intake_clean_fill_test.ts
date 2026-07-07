// ════════════════════════════════════════════════════════════
// MISSION M-A — INTAKE CLEAN-FILL (WO-PDF client fields), PROOF + REGRESSION SUITE
// ════════════════════════════════════════════════════════════
//
// Goal of the mission: genuine MLB "NEW WORK ORDER" emails should be BORN CLEAN
// (client_name / client_phone / site_address filled from the work-order PDF at scan
// time, BEFORE shouldAutoApproveCleanIntake evaluates) so they auto-approve on the
// UNCHANGED strict gate — and FAIL CLOSED (leave the field blank, stay manual) when
// no confident value is available, never guessing.
//
// LIVE FINDING (2026-07-07, verified against 35 real MLB WO PDFs pulled read-only from
// the public job-documents bucket): every live MLB WO PDF is generated with CID-subset
// (Identity-H) fonts and NO ToUnicode map, so its recovered text layer decodes to pure
// locale noise — exactly `Array(100).fill("en-AU").join(" ")` (599 chars, zero digits,
// zero residue). Consequences, all locked in by this suite:
//
//   1. The DETERMINISTIC reader (makesafe_pdf_client_fields.ts) can find no client-block
//      labels in that noise, so it returns nothing and the fill decision does NOT apply —
//      i.e. it FAILS CLOSED on every live MLB WO and can never invent a homeowner. This
//      is why the reader is safe to enable, even though on today's MLB WOs it fills
//      nothing (it only earns its keep for a builder that ships a real text-layer WO).
//
//   2. The path that actually makes MLB WOs born-clean is the PRIMARY model's
//      document-block (vision) extraction: because extractPdfText returns mode:'none' on
//      the noise (the #294 looksLikeText gate — regression-locked in
//      makesafe_pdf_text_test.ts), the WO PDF is handed to the model as a document block,
//      the model reads the rendered page and fills client_name/site_address/phone, and
//      the UNCHANGED gate then returns clean_high_confidence_work_order. Section 2 pins
//      that born-clean → auto-approve chain; section 3 pins the fail-closed-at-the-gate
//      behaviour a blank client field must produce.
//
// The gate itself is asserted UNCHANGED throughout — no new reasons, no relaxed
// conditions. Fixtures use synthetic (PII-free) homeowner values; the only real captured
// artifact is the CID text-layer noise, which contains no PII.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decidePdfClientFill,
  extractClientFieldsFromPdfText,
} from "./makesafe_pdf_client_fields.ts";
import { _shouldAutoApproveCleanIntakeForTest } from "./index.ts";

// The EXACT recovered text layer of every live MLB WO PDF sampled 2026-07-07 (35/35
// identical). CID-subset fonts + no ToUnicode => pure "en-AU" locale noise. PII-free.
const REAL_MLB_WO_RAWTEXT = Array(100).fill("en-AU").join(" ");

// A builder WO that DOES carry a real text layer — the label layout the deterministic
// reader is built for (mirrors the live MLB "Policyholders Name / Contact / Site Address"
// block). Homeowner values are synthetic.
const TEXT_LAYER_WO_BLOCK = `Work Order
Work Order Number
WB-12345PO-99999
Policyholders Name
Jane Citizen & Mr John Citizen
Policyholders Contact
Mobile: 0412000111
Home:
Email:
jane.citizen@example.test
Insurer Name
Example Insurance
Site Address
12 Example Way, Sampletown, WA 6000
Other Contact Details`;

// A single servable, designated work-order PDF (what the gate needs present).
const WO_ATTACH = [{
  file_name: "Work Order.pdf",
  pdf_url: "https://example.test/wo.pdf",
  is_work_order: true,
}];

// ── 1. FAIL CLOSED on the live MLB CID-noise text layer ──────────────────────

Deno.test("M-A fail-closed: live MLB WO text layer (CID noise) yields no client fields", () => {
  const r = extractClientFieldsFromPdfText(REAL_MLB_WO_RAWTEXT);
  assertEquals(r.unambiguous, false);
  assertEquals(r.found, []);
  assertEquals(r.fields, {
    client_name: null,
    client_phone: null,
    site_address: null,
  });
  assert(
    (r.note ?? "").includes("no_client_name_label"),
    `expected no_client_name_label, got note=${r.note}`,
  );
});

Deno.test("M-A fail-closed: decidePdfClientFill invents nothing on live MLB CID noise", () => {
  const d = decidePdfClientFill(REAL_MLB_WO_RAWTEXT, {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "medium",
    missingFields: ["client_name", "client_phone"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assertEquals(d.applied, false);
  assertEquals(d.filledFields, []);
  assertEquals(d.fill, {});
  // Confidence is never bumped off a non-read, and missing_fields is untouched, so the
  // draft stays dirty and queues for a human.
  assertEquals(d.confidence, "medium");
  assertEquals(d.missingFields, ["client_name", "client_phone"]);
});

Deno.test("M-A replay: no live-MLB / empty / noise rawText ever produces a fill", () => {
  // Stand-ins for the real corpus (all 35 live MLB WOs decode to the same noise) plus the
  // degenerate empties. None may fill a field — proves no draft passes on invented values.
  const corpus = [
    REAL_MLB_WO_RAWTEXT,
    "",
    "en-AU",
    Array(120).fill("en-AU").join(" "),
    "language metadata x-default stream artifact en-AU",
  ];
  for (const raw of corpus) {
    const d = decidePdfClientFill(raw, {
      clientName: null,
      clientPhone: null,
      siteAddress: null,
      confidence: "medium",
      missingFields: ["client_name", "client_phone", "site_address"],
      externalRefPresent: true,
      matchedCompanyPresent: true,
    });
    assertEquals(
      d.applied,
      false,
      `expected fail-closed on ${JSON.stringify(raw.slice(0, 24))}`,
    );
    assertEquals(d.filledFields, []);
  }
});

// ── 2. BORN CLEAN via the model-vision path → UNCHANGED gate auto-approves ────
// Mirrors live post-#294 MLB drafts (document mode: extractPdfText returns 'none' on the
// CID noise, the WO PDF goes to the model as a document block, the model reads the
// rendered page and fills the client fields on the draft BEFORE the gate runs).

Deno.test("M-A born-clean: model-vision-filled client fields pass the unchanged gate", () => {
  const decision = _shouldAutoApproveCleanIntakeForTest({
    confidence: "high",
    matchedCompany: { slug: "mlb", name: "MLB" },
    externalRef: "MLB-26705PO-55608",
    // In live data these are filled by the model from the WO PDF document block.
    clientName: "Jane Citizen",
    siteAddress: "197 Example Ave, Sampletown WA 6000",
    missingFields: [],
    attachments: WO_ATTACH,
  });
  assertEquals(decision, {
    ok: true,
    reason: "clean_high_confidence_work_order",
  });
});

// ── 3. FAIL CLOSED at the gate: a blank client field keeps the draft manual ──
// Proves the gate is unchanged — a null client_name / site_address blocks auto-approval
// with the exact, specific reason (so a failed/absent fill can never sneak through).

Deno.test("M-A fail-closed at gate: blank client_name blocks auto-approval", () => {
  const d = _shouldAutoApproveCleanIntakeForTest({
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26533",
    clientName: null,
    siteAddress: "18 First Ave, Mount Lawley WA 6050",
    missingFields: [],
    attachments: WO_ATTACH,
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "missing_client_name");
});

Deno.test("M-A fail-closed at gate: blank site_address blocks auto-approval", () => {
  const d = _shouldAutoApproveCleanIntakeForTest({
    confidence: "high",
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-26533",
    clientName: "Jane Citizen",
    siteAddress: null,
    missingFields: [],
    attachments: WO_ATTACH,
  });
  assertEquals(d.ok, false);
  assertEquals(d.reason, "missing_site_address");
});

// ── 4. DETERMINISTIC reader value case: a real text-layer WO fills, then auto-approves ─
// The path the flagged deterministic reader exists for — a builder that ships a genuine
// text-layer WO (labels the reader can anchor on). No live MLB WO does this today, but
// this proves the fill → confidence-bump → UNCHANGED-gate chain works end to end.

Deno.test("M-A text-layer WO: deterministic reader fills the null client fields", () => {
  const r = extractClientFieldsFromPdfText(TEXT_LAYER_WO_BLOCK);
  assert(r.unambiguous, `expected unambiguous; note=${r.note}`);
  assertEquals(r.fields.client_name, "Jane Citizen & Mr John Citizen");
  assertEquals(r.fields.client_phone, "0412000111");
  assertEquals(r.fields.site_address, "12 Example Way, Sampletown, WA 6000");
  assertEquals(r.found.sort(), [
    "client_name",
    "client_phone",
    "site_address",
  ]);
});

Deno.test("M-A text-layer WO: fill bumps medium->high, then the unchanged gate auto-approves", () => {
  // Same call shape as the scan-time wiring (index.ts ~13685): fill nulls from the WO PDF.
  const fill = decidePdfClientFill(TEXT_LAYER_WO_BLOCK, {
    clientName: null,
    clientPhone: null,
    siteAddress: null,
    confidence: "medium",
    missingFields: ["client_name", "client_phone", "site_address"],
    externalRefPresent: true,
    matchedCompanyPresent: true,
  });
  assert(fill.applied);
  assertEquals(fill.confidence, "high");
  assertEquals(fill.filledFields.sort(), [
    "client_name",
    "client_phone",
    "site_address",
  ]);
  assertEquals(fill.missingFields, []);

  // Feed the freshly-filled draft into the UNCHANGED gate exactly as the scanner does.
  const decision = _shouldAutoApproveCleanIntakeForTest({
    confidence: fill.confidence,
    matchedCompany: { slug: "wb", name: "Western Building" },
    externalRef: "WB-12345PO-99999",
    clientName: fill.fill.client_name ?? null,
    siteAddress: fill.fill.site_address ?? null,
    missingFields: fill.missingFields,
    attachments: WO_ATTACH,
  });
  assertEquals(decision, {
    ok: true,
    reason: "clean_high_confidence_work_order",
  });
});
