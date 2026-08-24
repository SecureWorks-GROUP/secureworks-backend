// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  makesafeDocBooleans,
  makesafePackArtifactRequirements,
  makesafeReportDocumentTypesForFamily,
  resolveMakesafePackDocumentPointers,
} from "./makesafe_document_truth.ts";

Deno.test("pack document pointers resolve only through their exact document rows", () => {
  const documents = [
    {
      id: "report-bound",
      type: "makesafe_report",
      file_name: "report.pdf",
      storage_url: "https://documents.example/report.pdf",
    },
    {
      id: "report-other",
      type: "makesafe_report",
      file_name: "other.pdf",
      storage_url: "https://documents.example/other.pdf",
    },
    {
      id: "invoice-bound",
      type: "invoice",
      file_name: "INV-1001.pdf",
      pdf_url: "https://documents.example/invoice.pdf",
    },
    {
      id: "swms-bound",
      type: "swms",
      file_name: "SWMS.pdf",
      storage_url: "https://documents.example/swms.pdf",
    },
  ];

  assertEquals(
    resolveMakesafePackDocumentPointers({
      report_doc_id: "report-bound",
      invoice_doc_id: "invoice-bound",
      swms_doc_id: "swms-bound",
    }, documents),
    {
      report_doc_resolved: true,
      invoice_doc_resolved: true,
      swms_doc_resolved: true,
    },
  );

  // Another document of the right class cannot launder a dangling pointer.
  assertEquals(
    resolveMakesafePackDocumentPointers({
      report_doc_id: "report-missing",
      invoice_doc_id: "report-other",
      swms_doc_id: null,
    }, documents),
    {
      report_doc_resolved: false,
      invoice_doc_resolved: false,
      swms_doc_resolved: false,
    },
  );
});

Deno.test("pointer resolution preserves the legacy general-document filename rules", () => {
  const legacyDocuments = [
    {
      id: "legacy-report",
      type: "general",
      file_name: "Make Safe Report - SWMS-1.pdf",
      storage_url: "https://documents.example/legacy-report.pdf",
    },
    {
      id: "legacy-invoice",
      type: null,
      file_name: "Invoice - INV-1.pdf",
      storage_url: "https://documents.example/legacy-invoice.pdf",
    },
    {
      id: "legacy-swms",
      type: "general",
      file_name: "Safe Work Method Statement SWMS.pdf",
      storage_url: "https://documents.example/legacy-swms.pdf",
    },
  ];

  assertEquals(makesafeDocBooleans(legacyDocuments), {
    has_wo: false,
    has_report_doc: true,
    has_invoice_doc: true,
    has_swms_doc: true,
  });
  assertEquals(
    resolveMakesafePackDocumentPointers({
      report_doc_id: "legacy-report",
      invoice_doc_id: "legacy-invoice",
      swms_doc_id: "legacy-swms",
    }, legacyDocuments),
    {
      report_doc_resolved: true,
      invoice_doc_resolved: true,
      swms_doc_resolved: true,
    },
  );
});

Deno.test("roof report pointers resolve only through the sanctioned roof_report artifact", () => {
  const documents = [{
    id: "roof-bound",
    type: "roof_report",
    file_name: "Roof Report - SWMS-26980.pdf",
    storage_url: "https://documents.example/roof-report.pdf",
  }];
  assertEquals(
    resolveMakesafePackDocumentPointers(
      { report_doc_id: "roof-bound" },
      documents,
      {
        report_document_types: makesafeReportDocumentTypesForFamily(
          "ordinary_roof_portal",
        ),
      },
    ).report_doc_resolved,
    true,
  );
  assertEquals(
    resolveMakesafePackDocumentPointers(
      { report_doc_id: "roof-bound" },
      documents,
    ).report_doc_resolved,
    false,
  );
});

Deno.test("roof legacy filename fallback accepts roof semantics and rejects generic make-safe semantics", () => {
  const reportTypes = makesafeReportDocumentTypesForFamily(
    "ordinary_roof_portal",
  );
  const resolve = (id: string, fileName: string) =>
    resolveMakesafePackDocumentPointers(
      { report_doc_id: id },
      [{
        id,
        type: "general",
        file_name: fileName,
        storage_url: `https://documents.example/${id}.pdf`,
      }],
      { report_document_types: reportTypes },
    ).report_doc_resolved;

  assertEquals(resolve("legacy-roof", "Roof Report - SWMS-26980.pdf"), true);
  assertEquals(
    resolve("generic-makesafe", "Make Safe Report - SWMS-26980.pdf"),
    false,
  );
});

Deno.test("a typed pointer without retrievable document storage is unresolved", () => {
  assertEquals(
    resolveMakesafePackDocumentPointers(
      { report_doc_id: "empty-report" },
      [{
        id: "empty-report",
        type: "makesafe_report",
        file_name: "Make Safe Report.pdf",
        storage_url: null,
        pdf_url: null,
      }],
    ).report_doc_resolved,
    false,
  );
});

Deno.test("assessment and no-charge releases keep their named artifact exceptions", () => {
  assertEquals(
    makesafePackArtifactRequirements({
      ses_family: "assessment_quote",
      pricing_disposition: "no_additional_charge",
    }),
    {
      requires_bound_report_doc: false,
      requires_bound_invoice_doc: false,
    },
  );
  assertEquals(
    makesafePackArtifactRequirements({
      ses_family: "ordinary_roof_portal",
      pricing_disposition: "priced_from_canon",
    }),
    {
      requires_bound_report_doc: true,
      requires_bound_invoice_doc: true,
    },
  );
});
