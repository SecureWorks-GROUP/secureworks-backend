// Tests for the M1.5 local PDF text-layer extractor (makesafe_pdf_text.ts).
//
// DENO-COMPATIBILITY PROOF: the FlateDecode cases below build a real deflate-compressed
// PDF content stream with the Web `CompressionStream` and decode it back through the
// extractor's `DecompressionStream` path — proving the extractor's core dependency runs
// under this runtime (the same Deno family the Supabase edge function executes on).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractPdfText,
  looksLikeText,
  PDF_TEXT_MIN_CHARS,
} from "./makesafe_pdf_text.ts";

const enc = (s: string) => new TextEncoder().encode(s);

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  w.write(new Uint8Array(bytes));
  w.close();
  const chunks: Uint8Array[] = [];
  const r = cs.readable.getReader();
  for (;;) {
    const { value, done } = await r.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Build a minimal single-object PDF whose content stream is FlateDecode-compressed.
async function flatePdf(content: string): Promise<Uint8Array> {
  let deflated = await deflate(enc(content));
  // Guard the fixture against the extractor's trailing-EOL strip: ensure the deflate
  // frame doesn't end in CR/LF (else the added stream EOL strip could clip data).
  let padded = content;
  while (
    deflated[deflated.length - 1] === 0x0a ||
    deflated[deflated.length - 1] === 0x0d
  ) {
    padded += " ";
    deflated = await deflate(enc(padded));
  }
  const head = enc(
    `%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const tail = enc(`\nendstream\nendobj\n%%EOF\n`);
  return concat(head, deflated, tail);
}

const WO_CONTENT = "BT /F1 12 Tf 72 720 Td (Client: Jane Doe) Tj 0 -14 Td " +
  "(Site Address: 12 Smith Street Perth Western Australia 6000) Tj 0 -14 Td " +
  "(Reference MLB-25795 make safe roof works after storm damage) Tj 0 -14 Td " +
  "(Scope: tarp the damaged roof section and make the site safe for the homeowner) Tj 0 -14 Td " +
  "(Contact phone 0400 000 000 attend within 24 hours per the insurer instruction) Tj ET";

Deno.test("FlateDecode text-layer PDF -> mode 'text' with the recovered fields (Deno DecompressionStream proof)", async () => {
  const pdf = await flatePdf(WO_CONTENT);
  const r = await extractPdfText(pdf);
  assertEquals(r.mode, "text");
  assert(
    r.charCount >= PDF_TEXT_MIN_CHARS,
    `expected >= ${PDF_TEXT_MIN_CHARS} chars, got ${r.charCount}`,
  );
  assert(r.text.includes("Jane Doe"), "client name recovered");
  assert(r.text.includes("MLB-25795"), "ref recovered");
  assert(r.text.includes("Smith Street"), "address recovered");
  assert(r.streamsDecoded >= 1);
});

Deno.test("short text layer (< threshold) -> mode 'none' (falls back to document path)", async () => {
  const pdf = await flatePdf("BT (Ref MLB-1) Tj ET");
  const r = await extractPdfText(pdf);
  assertEquals(r.mode, "none");
});

Deno.test("image-only PDF (no text operators) -> mode 'none'", async () => {
  // A DCTDecode image stream — not page text; the extractor must skip it.
  const body = enc(
    "\xff\xd8\xff\xe0 fake jpeg bytes here padding padding padding",
  );
  const head = enc(
    `%PDF-1.4\n1 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length ${body.length} >>\nstream\n`,
  );
  const tail = enc(`\nendstream\nendobj\n%%EOF\n`);
  const pdf = concat(head, body, tail);
  const r = await extractPdfText(pdf);
  assertEquals(r.mode, "none");
});

Deno.test("non-PDF bytes -> mode 'none' (never throws)", async () => {
  const r = await extractPdfText(enc("<html><body>not a pdf</body></html>"));
  assertEquals(r.mode, "none");
  assertEquals(r.note, "not_pdf");
});

Deno.test("empty / tiny input -> mode 'none'", async () => {
  assertEquals((await extractPdfText(new Uint8Array())).mode, "none");
  assertEquals((await extractPdfText(enc("%PD"))).mode, "none");
});

Deno.test("looksLikeText: real text passes, garbage / short fails", () => {
  // Must exceed the PDF_TEXT_MIN_CHARS (200) floor to be considered a usable text layer.
  const real =
    "Client Jane Doe Site Address 12 Smith Street Perth Western Australia make safe " +
    "the roof after storm damage attend within twenty four hours per the insurer " +
    "instruction and tarp the damaged section to protect the homeowner property today";
  assert(real.length >= PDF_TEXT_MIN_CHARS);
  assert(looksLikeText(real));
  assert(!looksLikeText("short"));
  // Mostly non-printable control bytes over the length threshold.
  const garbage = "\x01\x02\x03\x04".repeat(80);
  assert(!looksLikeText(garbage));
});

Deno.test("looksLikeText: repeated locale-tag text layer fails", () => {
  const localeNoise = Array(80).fill("en-AU").join(" ");
  assert(localeNoise.length >= PDF_TEXT_MIN_CHARS);
  assert(!looksLikeText(localeNoise));
});

Deno.test("looksLikeText: low-diversity repeated metadata fails", () => {
  const lowDiversity = Array(12).fill(
    "en-AU language metadata x-default stream artifact",
  ).join(" ");
  assert(lowDiversity.length >= PDF_TEXT_MIN_CHARS);
  assert(!looksLikeText(lowDiversity));
});

Deno.test("locale-tag-only PDF text layer -> mode 'none' (falls back to document path)", async () => {
  const localeNoise = Array(80).fill("en-AU").join(" ");
  const pdf = await flatePdf(`BT (${localeNoise}) Tj ET`);
  const r = await extractPdfText(pdf);
  assertEquals(r.mode, "none");
  assertEquals(r.note, "low_quality_text");
});

Deno.test("uncompressed (no /Filter) content stream is still read", async () => {
  const content = WO_CONTENT;
  const head = enc(
    `%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n`,
  );
  const tail = enc(`\nendstream\nendobj\n%%EOF\n`);
  const pdf = concat(head, enc(content), tail);
  const r = await extractPdfText(pdf);
  assertEquals(r.mode, "text");
  assert(r.text.includes("MLB-25795"));
});
