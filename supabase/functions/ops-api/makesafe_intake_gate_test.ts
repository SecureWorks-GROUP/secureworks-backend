// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE GATE TESTS
// Mission: makesafe-inbound-filter-2026-06-16
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Exercises the intake gate with the REAL subjects pulled
// from the live makesafe_intake_drafts flood (Photo Evidence / Report / Invoice /
// Crew Report) plus the real genuine work orders that MUST still come through
// (NEW WORK ORDER - MLB-..., Make Safe - <suburb> - Job No <ref>).
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_intake_gate_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isGenuineNewWorkOrder,
  subjectHasReplyForwardPrefix,
  subjectIsExcludedNonWorkOrder,
  subjectLooksLikeNewWorkOrder,
} from "./makesafe_intake_gate.ts";

// A non-own, inbound builder sender (so the outbound filter never fires here).
const BUILDER = "noreply@ajs.build";

// ── Real junk subjects from the live flood — MUST be excluded ─────────────────
const JUNK_SUBJECTS = [
  "Photo Evidence - AJBR 67251 - Doubleview",
  "Photo Evidence - AJBR 67040 / SWMS-26422 - 20 Nanson Street, Wembley",
  "Photos - Make Safe - AJBR 66897 - Singleton",
  "Make Safe Report and Invoice - MLB-25369 - Coolbinia",
  "Invoice - AJBR 66902 - Dianella",
  "WhatsApp Crew Report - Yokine - Sylvia Perrin - 10 June 2026",
  "Correction - AJBR 66902 - Dianella",
];

// ── Real genuine NEW work orders — MUST still come through ─────────────────────
const GENUINE_WO_SUBJECTS = [
  "NEW WORK ORDER - MLB-25096 7 Broughton St, Balcatta, WA 6021",
  "Make Safe - QUINNS ROCKS - Job No 67996",
  "Make Safe - PEPPERMINT GROVE - Job No 67938",
  "Make Safe - BICTON - Job No 67998",
];

// Legit WOs from the General's brief that must NOT be dropped (suburb-only subjects
// that came through as real work orders previously).
const LEGIT_SUBURB_WOS = [
  "NEW WORK ORDER - Dalkeith",
  "Make Safe - WOODVALE - Job No 70011",
  "Make Safe - CARINE - Job No 70022",
  "NEW WORK ORDER - MLB-25400 Bicton",
  "Make Safe - QUINNS ROCKS - Job No 71000",
  "Make Safe - NOLLAMARA - Job No 71001",
  "Make Safe - BALCATTA - Job No 71002",
];

Deno.test("subjectIsExcludedNonWorkOrder: real junk subjects are excluded", () => {
  for (const s of JUNK_SUBJECTS) {
    assert(subjectIsExcludedNonWorkOrder(s), `expected EXCLUDED: ${s}`);
  }
});

Deno.test("subjectIsExcludedNonWorkOrder: genuine WO subjects are NOT excluded", () => {
  for (const s of [...GENUINE_WO_SUBJECTS, ...LEGIT_SUBURB_WOS]) {
    assert(!subjectIsExcludedNonWorkOrder(s), `expected NOT excluded: ${s}`);
  }
});

Deno.test("subjectIsExcludedNonWorkOrder: RE/FW valid work orders are risk-flagged, not excluded", () => {
  for (
    const s of [
      "RE: Make Safe - QUINNS ROCKS - Job No 67996",
      "FW: NEW WORK ORDER - MLB-25096",
      "Fwd: Make Safe - BICTON - Job No 67998",
    ]
  ) {
    assert(
      subjectHasReplyForwardPrefix(s),
      `expected reply/forward risk flag: ${s}`,
    );
    assert(!subjectIsExcludedNonWorkOrder(s), `expected NOT excluded: ${s}`);
  }
});

Deno.test("subjectLooksLikeNewWorkOrder: genuine WO subjects carry a positive signal", () => {
  for (const s of [...GENUINE_WO_SUBJECTS, ...LEGIT_SUBURB_WOS]) {
    assert(
      subjectLooksLikeNewWorkOrder(s),
      `expected positive new-WO signal: ${s}`,
    );
  }
});

Deno.test("subjectLooksLikeNewWorkOrder: junk subjects carry NO positive signal", () => {
  // Photo Evidence / Invoice / Crew Report should not look like a new WO.
  for (
    const s of [
      "Photo Evidence - AJBR 67251 - Doubleview",
      "Invoice - AJBR 66902 - Dianella",
      "WhatsApp Crew Report - Yokine - Sylvia Perrin",
    ]
  ) {
    assert(!subjectLooksLikeNewWorkOrder(s), `unexpected new-WO signal: ${s}`);
  }
});

Deno.test("isGenuineNewWorkOrder: real junk subjects are gated OUT (no PDF)", () => {
  for (const s of JUNK_SUBJECTS) {
    const r = isGenuineNewWorkOrder(s, BUILDER, 0);
    assertEquals(r.ok, false, `expected gated OUT: ${s} (reason=${r.reason})`);
  }
});

Deno.test("isGenuineNewWorkOrder: junk subject stays OUT even WITH a PDF attached", () => {
  // A "Report and Invoice" / "Photo Evidence" PDF is not a work order — the
  // unambiguous non-WO subject wins over a PDF.
  const r = isGenuineNewWorkOrder(
    "Make Safe Report and Invoice - MLB-25369 - Coolbinia",
    BUILDER,
    1,
  );
  assertEquals(r.ok, false);
  assertEquals(r.reason, "excluded_non_work_order_subject");
});

Deno.test("isGenuineNewWorkOrder: genuine NEW WORK ORDER subject is let IN (no PDF needed)", () => {
  for (const s of [...GENUINE_WO_SUBJECTS, ...LEGIT_SUBURB_WOS]) {
    const r = isGenuineNewWorkOrder(s, BUILDER, 0);
    assertEquals(r.ok, true, `expected let IN: ${s} (reason=${r.reason})`);
    assertEquals(r.reason, "new_work_order_subject");
  }
});

Deno.test("isGenuineNewWorkOrder: RE/FW work-order evidence still comes IN for review", () => {
  for (
    const s of [
      "RE: Make Safe - QUINNS ROCKS - Job No 67996",
      "FW: NEW WORK ORDER - MLB-25096",
      "Fwd: Make Safe - BICTON - Job No 67998",
    ]
  ) {
    const r = isGenuineNewWorkOrder(s, BUILDER, 0);
    assertEquals(r.ok, true, `expected let IN: ${s} (reason=${r.reason})`);
  }
});

Deno.test("isGenuineNewWorkOrder: builder WO with a PDF but no keyword still comes IN (adversarial)", () => {
  // A builder who emails a work order WITHOUT the words "work order" and without
  // "Job No", but WITH a work-order PDF, must still be intaken. PDF is a positive
  // signal on its own.
  const r = isGenuineNewWorkOrder(
    "Emergency attend - 12 Smith St Carine",
    BUILDER,
    1,
  );
  assertEquals(r.ok, true);
  assertEquals(r.reason, "work_order_pdf");
});

Deno.test("isGenuineNewWorkOrder: unknown subject with no PDF and no keyword is gated OUT", () => {
  const r = isGenuineNewWorkOrder("Quick question about the site", BUILDER, 0);
  assertEquals(r.ok, false);
  assertEquals(r.reason, "no_work_order_signal");
});

Deno.test("isGenuineNewWorkOrder: our OWN outbound domain is gated OUT", () => {
  // ses@ poll sees sent items. A NEW WORK ORDER subject from our own domain is our
  // own outbound (e.g. a forward) — must not become an inbound intake draft.
  const r = isGenuineNewWorkOrder(
    "NEW WORK ORDER - MLB-25096",
    "quotes@secureworksgroup.app",
    1,
  );
  assertEquals(r.ok, false);
  assert(
    r.reason.startsWith("outbound:"),
    `expected outbound reason, got ${r.reason}`,
  );
});

Deno.test("isGenuineNewWorkOrder: empty/whitespace subject with no PDF is gated OUT", () => {
  assertEquals(isGenuineNewWorkOrder("", BUILDER, 0).ok, false);
  assertEquals(isGenuineNewWorkOrder("   ", BUILDER, 0).ok, false);
});
