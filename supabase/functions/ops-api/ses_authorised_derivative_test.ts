// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SES_AUTHORISED_DERIVATIVE_CONTRACT,
  SesAuthorisedDerivativeError,
  verifySesAuthorisedDerivative,
} from "./ses_authorised_derivative.ts";

const encode = (value: string) => new TextEncoder().encode(value);

function validTextPdf(lines: string[]): Uint8Array {
  const escaped = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const content = `BT /F1 10 Tf 72 760 Td ${
    escaped.map((line) => `(${line}) Tj 0 -14 Td`).join(" ")
  } ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encode(pdf);
}

const BASE_LINES = [
  "Xero tax invoice for synthetic make-safe services",
  "Reference SES-TEST-REF-4477",
  "Customer Synthetic Insurance Builder",
  "Site Suburb Joondalup Western Australia",
  "Description Emergency roof make-safe attendance and temporary weatherproofing",
  "Line one attendance labour quantity 1 unit price 400.00",
  "Line two approved materials quantity 1 unit price 100.00",
  "Subtotal 454.55 GST 45.45 Total AUD 500.00",
  "Payment terms are thirty days from the authorised invoice date",
];

function invoice(
  status: "DRAFT" | "AUTHORISED",
  invoiceNumber: string,
  total = 500,
) {
  return {
    xero_invoice_id: "xero-synthetic-4477",
    invoice_number: invoiceNumber,
    status,
    reference: "SES-TEST-REF-4477",
    total,
  };
}

function invoicePdf(
  status: "DRAFT" | "AUTHORISED",
  invoiceNumber: string,
  lines = BASE_LINES,
): Uint8Array {
  return validTextPdf([
    `Invoice Number ${invoiceNumber}`,
    `Invoice Status ${status}`,
    ...lines,
  ]);
}

Deno.test("authorised derivative accepts only the invoice number and status changes", async () => {
  const draftPdf = invoicePdf("DRAFT", "DRAFT-4477");
  const authorisedPdf = invoicePdf("AUTHORISED", "INV-4477");
  const proof = await verifySesAuthorisedDerivative({
    draft_invoice: invoice("DRAFT", "DRAFT-4477"),
    authorised_invoice: invoice("AUTHORISED", "INV-4477"),
    draft_pdf: draftPdf,
    authorised_pdf: authorisedPdf,
  });

  assertEquals(proof.contract, SES_AUTHORISED_DERIVATIVE_CONTRACT);
  assertEquals(proof.xero_invoice_id, "xero-synthetic-4477");
  assertEquals(proof.reference, "SES-TEST-REF-4477");
  assertEquals(proof.total, 500);
  assertEquals(proof.page_count, 1);
  assert(proof.canonical_text_hash.startsWith("sha256:"));
  assertNotEquals(
    proof.draft_pdf_content_hash,
    proof.authorised_pdf_content_hash,
  );
});

Deno.test("authorised derivative hard-refuses an altered invoice line", async () => {
  const alteredLines = BASE_LINES.map((line) =>
    line.startsWith("Line two")
      ? "Line two UNAPPROVED surcharge quantity 1 unit price 100.00"
      : line
  );
  const error = await assertRejects(
    () =>
      verifySesAuthorisedDerivative({
        draft_invoice: invoice("DRAFT", "DRAFT-4477"),
        authorised_invoice: invoice("AUTHORISED", "INV-4477"),
        draft_pdf: invoicePdf("DRAFT", "DRAFT-4477"),
        authorised_pdf: invoicePdf(
          "AUTHORISED",
          "INV-4477",
          alteredLines,
        ),
      }),
    SesAuthorisedDerivativeError,
  );
  assertEquals(error.code, "authorised_derivative_mismatch");
  assertEquals(error.reason, "pdf_content_changed");
});

Deno.test("authorised derivative hard-refuses a changed structured total", async () => {
  const error = await assertRejects(
    () =>
      verifySesAuthorisedDerivative({
        draft_invoice: invoice("DRAFT", "DRAFT-4477"),
        authorised_invoice: invoice("AUTHORISED", "INV-4477", 501),
        draft_pdf: invoicePdf("DRAFT", "DRAFT-4477"),
        authorised_pdf: invoicePdf("AUTHORISED", "INV-4477"),
      }),
    SesAuthorisedDerivativeError,
  );
  assertEquals(error.code, "authorised_derivative_mismatch");
  assertEquals(error.reason, "invoice_total_changed");
});

Deno.test("authorised derivative hard-refuses an unreadable PDF", async () => {
  const error = await assertRejects(
    () =>
      verifySesAuthorisedDerivative({
        draft_invoice: invoice("DRAFT", "DRAFT-4477"),
        authorised_invoice: invoice("AUTHORISED", "INV-4477"),
        draft_pdf: invoicePdf("DRAFT", "DRAFT-4477"),
        authorised_pdf: encode("%PDF-1.7\nbroken"),
      }),
    SesAuthorisedDerivativeError,
  );
  assertEquals(error.code, "authorised_derivative_mismatch");
  assertEquals(error.reason, "pdf_unreadable");
});
