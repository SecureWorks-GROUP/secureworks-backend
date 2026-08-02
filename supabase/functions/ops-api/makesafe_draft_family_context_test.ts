// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyMakeSafeJobFamily } from "./makesafe_intake_gate.ts";
import {
  DraftFamilyContextRefusal,
  MULTIPLE_WORK_ORDERS_REASON,
  PDF_EXTRACTION_PENDING_REASON,
  resolveDraftFamilyClassifierContext,
} from "./makesafe_draft_family_context.ts";

Deno.test("F1: draft WO Roof Reports header outranks generic NEW WORK ORDER boilerplate", () => {
  const context = resolveDraftFamilyClassifierContext({
    builder: "mlb",
    workOrderCount: 1,
    pdfDocuments: [{
      status: "extracted",
      text: [
        "Work Order",
        "Allocation Work Order",
        "Roof Reports",
        "EXTERNAL",
      ].join("\n"),
    }],
  });

  const family = classifyMakeSafeJobFamily(
    "NEW WORK ORDER - MLB-00000",
    "NEW WORK ORDER. You have been assigned the above work order.",
    null,
    context,
  );

  assertEquals(family, "roof_report");
});

Deno.test("F1: draft context also carries the AJS builder floor", () => {
  const context = resolveDraftFamilyClassifierContext({
    builder: "aj",
    workOrderCount: 1,
    pdfDocuments: [{
      status: "extracted",
      text: "Allocation Work Order\nRoof Reports",
    }],
  });

  assertEquals(
    classifyMakeSafeJobFamily(
      "NEW WORK ORDER - AJBR-00000",
      "NEW WORK ORDER",
      null,
      context,
    ),
    "general_makesafe",
  );
});

Deno.test("F1: draft family classification refuses while WO PDF extraction is pending", () => {
  const error = assertThrows(
    () =>
      resolveDraftFamilyClassifierContext({
        builder: "mlb",
        workOrderCount: 1,
        pdfDocuments: [{
          status: "deferred",
          text: null,
          reason: PDF_EXTRACTION_PENDING_REASON,
        }],
      }),
    DraftFamilyContextRefusal,
  );

  assertEquals(error.reason, PDF_EXTRACTION_PENDING_REASON);
});

Deno.test("F1: draft family classification refuses multiple work orders instead of choosing one", () => {
  const error = assertThrows(
    () =>
      resolveDraftFamilyClassifierContext({
        builder: "mlb",
        workOrderCount: 2,
        pdfDocuments: [
          { status: "extracted", text: "Allocation Work Order\nRoof Reports" },
          {
            status: "extracted",
            text: "Allocation Work Order\nAssessment Report & Quote",
          },
        ],
      }),
    DraftFamilyContextRefusal,
  );

  assertEquals(error.reason, MULTIPLE_WORK_ORDERS_REASON);
});
