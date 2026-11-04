// deno-lint-ignore-file no-import-prefix
// The old monitor-inbox path never files inline email pictures (signature
// logos) onto a job (attachments.ts). Before this rule, 12 signature images
// on one supplier thread landed on SWP-261382 as receipt photos.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { storableAttachmentKind } from "./attachments.ts";

const BYTES = "JVBERi0xLjQK"; // "%PDF-1.4\n", base64

Deno.test("inline signature pictures are never filed", () => {
  assertEquals(
    storableAttachmentKind({
      name: "image001.png",
      contentType: "image/png",
      contentBytes: BYTES,
      size: 4000,
      isInline: true,
    }),
    null,
  );
  // Even an inline item that calls itself a PDF.
  assertEquals(
    storableAttachmentKind({
      name: "logo.pdf",
      contentType: "application/pdf",
      contentBytes: BYTES,
      size: 4000,
      isInline: true,
    }),
    null,
  );
});

Deno.test("attached PDFs and pictures are still filed, as before", () => {
  assertEquals(
    storableAttachmentKind({
      name: "SO123.pdf",
      contentType: "application/octet-stream",
      contentBytes: BYTES,
      size: 9000,
      isInline: false,
    }),
    "pdf",
  );
  assertEquals(
    storableAttachmentKind({
      name: "delivery.jpg",
      contentType: "image/jpeg",
      contentBytes: BYTES,
      size: 9000,
    }),
    "image",
  );
});

Deno.test("no content, too big or another file type: not filed", () => {
  assertEquals(storableAttachmentKind({ name: "a.pdf", contentType: "application/pdf", size: 10 }), null);
  assertEquals(
    storableAttachmentKind({ name: "a.pdf", contentType: "application/pdf", contentBytes: BYTES, size: 10_000_001 }),
    null,
  );
  assertEquals(
    storableAttachmentKind({ name: "a.xlsx", contentType: "application/vnd.ms-excel", contentBytes: BYTES, size: 10 }),
    null,
  );
});

Deno.test("source pin: the attachment loop in index.ts asks this rule", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes("import { storableAttachmentKind } from './attachments.ts'"));
  const loop = src.slice(src.indexOf("for (const att of (attachData.value || []))"));
  assert(loop.length > 0);
  const head = loop.slice(0, 400);
  assert(/const kind = storableAttachmentKind\(att\)/.test(head), head);
  assert(/if \(!kind\) continue/.test(head), head);
});
