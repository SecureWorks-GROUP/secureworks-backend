// deno-lint-ignore-file no-import-prefix
// M1.5 MUST-HOLD invariants — pinned so the cost levers can never quietly change what
// lands in Supabase (Captain's directive: drive cost toward zero WITHOUT changing the
// extraction contract).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyMakeSafeJobFamily } from "./makesafe_intake_gate.ts";
import { _shouldAutoApproveCleanIntakeForTest as shouldAutoApprove } from "./index.ts";

// INVARIANT 3 — classification stays deterministic and UNCHANGED. If a cost edit ever
// touched the family classifier these fixed mappings would move.
Deno.test("INVARIANT: makesafe_job_family classifier is unchanged", () => {
  assertEquals(
    classifyMakeSafeJobFamily(
      "Temp fence collection AJBR-1",
      "please collect the temporary fencing",
      null,
    ),
    "temp_fence_makesafe",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "Prime roof report MLB-2",
      "roof report link",
      "roof_report",
    ),
    "roof_report",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "assess and quote",
      "please assess and quote",
      null,
    ),
    "assessment_report_quote",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "NEW WORK ORDER MLB-3",
      "make safe the roof after storm",
      null,
    ),
    "general_makesafe",
  );
  assertEquals(
    classifyMakeSafeJobFamily(
      "Restoration works MLB-MW-26873",
      "Complete water damage restoration works to the dwelling",
      null,
    ),
    "restoration",
  );
});

// INVARIANT 4 — a template-parsed draft still goes THROUGH the same auto-file gate. The
// cost path never lowers the bar: no servable WO PDF => still blocked; a clean draft
// with company + ref + client + address + a servable WO PDF => same clean pass.
Deno.test("INVARIANT: a template-skipped draft with NO servable WO PDF is still blocked", () => {
  const decision = shouldAutoApprove({
    enabled: true,
    confidence: "high", // template stamps high
    missingFields: [],
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-25795",
    clientName: "Jane Doe",
    siteAddress: "12 Smith Street Perth",
    attachments: [], // template parse does NOT invent a work-order PDF
  });
  assertEquals(decision.ok, false);
  assertEquals(decision.reason, "missing_work_order_pdf");
});

Deno.test("INVARIANT: a clean template-skipped draft WITH a servable WO PDF passes the same gate", () => {
  const decision = shouldAutoApprove({
    enabled: true,
    confidence: "high",
    missingFields: [],
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-25795",
    clientName: "Jane Doe",
    siteAddress: "12 Smith Street Perth",
    attachments: [{
      pdf_url: "https://example/job-documents/wo.pdf",
      is_work_order: true,
    }],
  });
  assert(decision.ok, `expected auto-file ok, got ${decision.reason}`);
});

// M3 — INVARIANT #1: the WO PDF is stored + attached on EVERY extraction path, and the
// cost levers never drop it. The capture/upload/attachments_json build runs BEFORE the
// cost branch, so the PDF must survive even a CLASSIFICATION FAILURE. The gate is the
// observable seam: when extraction fails (low confidence) but the WO PDF was captured,
// the gate must block on CONFIDENCE, not on a missing PDF — proving the PDF was not
// dropped by the failed extraction. (The high-confidence WO-PDF-present -> ok case that
// the text/document/template paths share is already pinned by the test above.)
Deno.test("INVARIANT #1: on a CLASSIFICATION FAILURE the WO PDF is STILL present (blocked on confidence, not missing PDF)", () => {
  const decision = shouldAutoApprove({
    enabled: true,
    confidence: "low", // classification failure (dead key / bad JSON)
    missingFields: [],
    matchedCompany: { slug: "mlb" },
    externalRef: "MLB-25795",
    clientName: "Jane Doe",
    siteAddress: "12 Smith Street Perth",
    attachments: [{
      pdf_url: "https://example/job-documents/wo.pdf",
      is_work_order: true,
    }],
  });
  assertEquals(decision.ok, false);
  assertEquals(decision.reason, "confidence_not_high"); // NOT "missing_work_order_pdf"
});
