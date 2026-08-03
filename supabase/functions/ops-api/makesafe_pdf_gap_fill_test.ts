// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveSuburbFromAddress,
  gapFillFromWorkOrderPdf,
} from "./makesafe_pdf_gap_fill.ts";

const WO_TEXT = `Work Order
Work Order Number
MLB-26770PO-55296
Policyholders Name
Amanda Parker
Policyholders Contact
Mobile: 0422 636 182
Site Address
8 Syrinx Pl, Mullaloo, WA 6027
Scope of Works
Install temporary roof tarps and make the storm-damaged property safe.
Notes
Contact the supervisor after attendance.`;

function input(current: Record<string, string> = {}) {
  return {
    current,
    pdfText: WO_TEXT,
    extractor: "unpdf@1.6.2",
    sourcePostId: "post-1",
    attachmentId: "attachment-1",
    attachmentName: "MLB Work Order.pdf",
  };
}

Deno.test("work-order PDF fills missing intake fields with per-field provenance", () => {
  const result = gapFillFromWorkOrderPdf(input());
  assertEquals(result.fields.client_name, "Amanda Parker");
  assertEquals(result.fields.client_phone, "0422636182");
  assertEquals(result.fields.site_address, "8 Syrinx Pl, Mullaloo, WA 6027");
  assertEquals(result.fields.site_suburb, "Mullaloo");
  assertEquals(result.fields.external_ref, "MLB-26770PO-55296");
  assertEquals(
    result.fields.description,
    "Install temporary roof tarps and make the storm-damaged property safe.",
  );
  assertEquals(result.filledFields.sort(), [
    "client_name",
    "client_phone",
    "description",
    "external_ref",
    "site_address",
    "site_suburb",
  ]);
  for (const field of result.filledFields) {
    const provenance = result.provenance[field];
    assert(provenance, `missing provenance for ${field}`);
    assertEquals(provenance.source, "work_order_pdf_text");
    assertEquals(provenance.extractor, "unpdf@1.6.2");
    assertEquals(provenance.attachmentId, "attachment-1");
  }
  assertEquals(
    result.provenance.site_suburb?.rule,
    "derived_from_site_address:work_order_pdf_gap_fill@v1",
  );
});

Deno.test("suburb derivation normalises verified WA address-tail variants", () => {
  assertEquals(
    deriveSuburbFromAddress("TEST SITE, HIGH WYCOMBE WA 6057"),
    "High Wycombe",
  );
  assertEquals(
    deriveSuburbFromAddress(
      "TEST SITE, HIGH WYCOMBE, W.A. 6057, Australia",
    ),
    "High Wycombe",
  );
  assertEquals(
    deriveSuburbFromAddress(
      "TEST SITE, HIGH WYCOMBE Western Australia 6057",
    ),
    "High Wycombe",
  );
});

Deno.test("email-derived values win and receive no PDF provenance", () => {
  const result = gapFillFromWorkOrderPdf(input({
    client_name: "Email Client",
    external_ref: "EMAIL-REF-1",
    site_address: "10 Email St, Perth, WA 6000",
    description: "Email supplied scope",
  }));
  assertEquals(result.fields.client_name, "Email Client");
  assertEquals(result.fields.external_ref, "EMAIL-REF-1");
  assertEquals(result.fields.site_address, "10 Email St, Perth, WA 6000");
  assertEquals(result.fields.description, "Email supplied scope");
  assertEquals(result.provenance.client_name, undefined);
  assertEquals(result.provenance.external_ref, undefined);
  assertEquals(result.provenance.site_address, undefined);
  assertEquals(result.provenance.description, undefined);
  assertEquals(result.fields.client_phone, "0422636182");
  assertEquals(result.fields.site_suburb, undefined);
  assertEquals(result.provenance.client_phone?.source, "work_order_pdf_text");
});

Deno.test("conflicting client blocks fail closed without inventing client fields", () => {
  const result = gapFillFromWorkOrderPdf({
    ...input(),
    pdfText: `${WO_TEXT}
Policyholders Name
Different Person`,
  });
  assertEquals(result.fields.client_name, undefined);
  assertEquals(result.fields.client_phone, undefined);
  assertEquals(result.fields.site_address, undefined);
  assert(
    result.warnings.some((warning) =>
      warning.startsWith("pdf_client_fields:ambiguous_client_name")
    ),
  );
});
