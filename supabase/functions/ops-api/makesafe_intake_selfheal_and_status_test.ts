// ════════════════════════════════════════════════════════════
// A2 self-heal decision + shared draft-status (pure)
// ════════════════════════════════════════════════════════════
// RUN: deno test --no-check supabase/functions/ops-api/makesafe_intake_selfheal_and_status_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideInsertConflictAction } from "./makesafe_intake_dedup.ts";
import { computeIntakeDraftStatus } from "./makesafe_intake_gate.ts";

// ── A2 — insert-conflict self-heal decision ──
Deno.test("A2 decide: a non-live shell (superseded/rejected/absent) HEALS in place", () => {
  assertEquals(decideInsertConflictAction("superseded"), "heal");
  assertEquals(decideInsertConflictAction("rejected"), "heal");
  assertEquals(decideInsertConflictAction("SUPERSEDED"), "heal");
  assertEquals(decideInsertConflictAction(null), "heal");
  assertEquals(decideInsertConflictAction(undefined), "heal");
  assertEquals(decideInsertConflictAction(""), "heal");
});

Deno.test("A2 decide: a LIVE row is a collision and is NEVER clobbered", () => {
  for (const s of ["draft", "needs_review", "approved", "reopen_candidate"]) {
    assertEquals(decideInsertConflictAction(s), "live_collision");
  }
});

// ── shared draft-status (used by scanner + reextract) ──
Deno.test("status: degraded or report-capture is always needs_review", () => {
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: true, isReportCapture: false, hasCompany: true, externalRef: "x", clientName: "x", siteAddress: "x", availableWoCount: 1 }),
    "needs_review",
  );
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: false, isReportCapture: true, hasCompany: true, externalRef: "x", clientName: "x", siteAddress: "x", availableWoCount: 1 }),
    "needs_review",
  );
});

Deno.test("status: a complete WO is needs_review; any missing required field stays draft", () => {
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: false, isReportCapture: false, hasCompany: true, externalRef: "MLB-1", clientName: "Jo", siteAddress: "1 A St", availableWoCount: 1 }),
    "needs_review",
  );
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: false, isReportCapture: false, hasCompany: true, externalRef: null, clientName: "Jo", siteAddress: "1 A St", availableWoCount: 1 }),
    "draft",
  );
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: false, isReportCapture: false, hasCompany: true, externalRef: "MLB-1", clientName: "Jo", siteAddress: "1 A St", availableWoCount: 0 }),
    "draft",
  );
  assertEquals(
    computeIntakeDraftStatus({ extractionDegraded: false, isReportCapture: false, hasCompany: false, externalRef: "MLB-1", clientName: "Jo", siteAddress: "1 A St", availableWoCount: 1 }),
    "draft",
  );
});
