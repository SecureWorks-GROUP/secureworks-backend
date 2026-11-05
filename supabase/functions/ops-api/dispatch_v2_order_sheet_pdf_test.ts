// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 Tweak 1, part 3: our own one-page Material order sheet when the
// supplier sends no PDF (dispatch_v2_order_sheet_pdf.ts, and the save in
// dispatch_v2_order_documents.ts; contract section 3e.3). The PDF's text is
// read back by inflating its content streams, as dispatch_order_pdf_test.ts
// does, so the test checks what a person would read.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchOrderSheetLines,
  dispatchOrderSheetWhen,
  renderDispatchOrderSheet,
} from "./dispatch_v2_order_sheet_pdf.ts";
import {
  type DispatchOrderConfirmedDeps,
  runDispatchV2OrderConfirmed,
} from "./dispatch_v2_order_confirmed_write.ts";
import {
  makeFakeClient,
  type Row,
} from "./dispatch_v2_order_confirmed_test_fakes.ts";
import {
  dispatchDocBytesAre,
  dispatchOrderIsPhotoOnly,
  dispatchOrderPhotoName,
  sha256HexOf,
} from "./dispatch_v2_order_documents.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "a1000000-0000-4000-8000-000000000001";
const SUP = "b1000000-0000-4000-8000-000000000001";
const ORDER = "e1000000-0000-4000-8000-000000000001";
const NOW = "2026-11-03T02:00:00.000Z";

async function pdfText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    const chunk = bytes.slice(start, end);
    let text: string;
    try {
      const ds = new Blob([chunk]).stream().pipeThrough(
        new DecompressionStream("deflate"),
      );
      text = new TextDecoder("latin1").decode(
        await new Response(ds).arrayBuffer(),
      );
    } catch {
      text = new TextDecoder("latin1").decode(chunk);
    }
    for (const t of text.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)) {
      out.push(t[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join("\n");
}

const SHEET = {
  orderId: ORDER,
  jobNumber: "SWP-90001",
  supplierName: "Stratco",
  fulfilment: "pickup" as const,
  branch: "Neerabup",
  when: { kind: "date" as const, date: "2026-11-03" },
  sentAt: "2026-11-01T02:00:00Z",
  supplierRef: null,
  lines: ["10 x 6.1m Lengths of 76 x 38\nColour: Surfmist", "4 x Brackets"],
};

Deno.test("sheet: what the crew needs, and no price, client or contact", async () => {
  const sheet = await renderDispatchOrderSheet(SHEET);
  const text = await pdfText(sheet.bytes);
  for (
    const expected of [
      "MATERIAL ORDER",
      "SecureWorks Group",
      "Stratco",
      "Pickup from Neerabup",
      "Tue 3 Nov 2026",
      "SWP-90001",
      "01/11/2026",
      "10 x 6.1m Lengths of 76 x 38",
      "Colour: Surfmist",
      "4 x Brackets",
      "Made by SecureWorks Group from our order email. The supplier sent no document for this order.",
    ]
  ) {
    assert(text.includes(expected), `missing: ${expected}\n${text}`);
  }
  assertEquals([sheet.rowsShown, sheet.rowsLeftOut], [3, 0]);
  assert(!/\$|price|total|@|phone/i.test(text), text);
  assert(!/work\s*order|\bwo\b/i.test(text), text);
  // One page, the same bytes for the same order.
  assertEquals((new TextDecoder("latin1").decode(sheet.bytes).match(/\/Type \/Page\b/g) || []).length, 1);
  const again = await renderDispatchOrderSheet(SHEET);
  assertEquals(again.sha256, sheet.sha256);
});

Deno.test("sheet: ASAP, a delivery and a ref; a long order stays on one page", async () => {
  const sheet = await renderDispatchOrderSheet({
    ...SHEET,
    fulfilment: "delivery",
    branch: null,
    when: { kind: "asap" },
    supplierRef: "W207774",
    lines: Array.from({ length: 80 }, (_, i) => `${i + 1} x Item ${i + 1}`),
  });
  const text = await pdfText(sheet.bytes);
  for (const expected of ["Delivery", "ASAP", "W207774", "1 x Item 1"]) {
    assert(text.includes(expected), `missing: ${expected}`);
  }
  assert(sheet.rowsLeftOut > 0);
  assertEquals(sheet.rowsShown + sheet.rowsLeftOut, 80);
  assert(text.includes(`and ${sheet.rowsLeftOut} more lines on the order email`));
  assertEquals((new TextDecoder("latin1").decode(sheet.bytes).match(/\/Type \/Page\b/g) || []).length, 1);
});

Deno.test("sheet lines: the saved order lines, else the email body between its first line and Date", () => {
  assertEquals(
    dispatchOrderSheetLines({ order_lines: [{ text: " 5 x Posts " }, { text: "" }, {}] }),
    ["5 x Posts"],
  );
  assertEquals(
    dispatchOrderSheetLines({
      order_lines: [],
      body_text: "Hi Team, for pickup:\n\n5 x Posts\n2 x Rails\n\nDate: ASAP\nThanks",
    }),
    ["5 x Posts", "2 x Rails"],
  );
  assertEquals(dispatchOrderSheetWhen({ kind: "none" }), "No date yet");
});

// ── Saved when no matched reply has a PDF ───────────────────────────────────

function tables(): Record<string, Row[]> {
  return {
    jobs: [{ id: JOB, org_id: ORG, job_number: "SWP-90001" }],
    dispatch_supplier_order_emails: [{
      id: ORDER,
      org_id: ORG,
      job_id: JOB,
      supplier_id: SUP,
      supplier_name: "Stratco",
      status: "sent",
      sent_at: "2026-11-01T02:00:00Z",
      delivery_date: "2026-11-03",
      body_text: "Hi Team, could we please order the following for pickup from Neerabup:\n\n10 x Lengths\n\nDate: 3 November 2026",
      order_lines: [{ text: "10 x Lengths" }],
    }],
    job_material_suppliers: [],
    dispatch_v2_order_crew_lines: [],
    dispatch_v2_supplier_order_refs: [],
    dispatch_v2_supplier_emails: [],
    context_email_attachments: [],
    dispatch_v2_order_documents: [],
    job_documents: [],
    job_events: [],
  };
}

const UNIQUE = {
  dispatch_v2_order_documents: [["job_id", "content_sha256"]],
  dispatch_v2_order_crew_lines: [["order_id", "seq"]],
};

const deps: DispatchOrderConfirmedDeps = {
  writeNote: () => Promise.resolve({ id: "9e000000-0000-4000-8000-000000000001" }),
  now: () => NOW,
};

const confirm = (client: any) =>
  runDispatchV2OrderConfirmed(client, {
    orgId: ORG,
    jobId: JOB,
    supplierId: SUP,
    trigger: "stage_set",
    operator: { userId: null, email: "shaun@ops.test" },
  }, deps);

Deno.test("confirmed with no supplier PDF: our Material order sheet is saved once, crew-visible", async () => {
  const t = makeFakeClient(tables(), { unique: UNIQUE });
  const r = await confirm(t.client);
  assertEquals(r.documents?.saved.map((s) => s.name), ["Stratco material order.pdf"]);
  const [doc] = t.tables.job_documents;
  assertEquals([doc.type, doc.visible_to_trades, doc.metadata.document_source], [
    "material_order",
    true,
    "order_sheet",
  ]);
  const bytes = t.objects.get(`job-documents/${doc.metadata.storage_path}`)!;
  const text = await pdfText(bytes);
  assert(text.includes("Pickup from Neerabup"));
  assert(text.includes("Tue 3 Nov 2026"));
  assertEquals(t.tables.dispatch_v2_order_documents[0].source, "order_sheet");
  // Pressed again: no second sheet.
  const again = await confirm(t.client);
  assertEquals(again.documents?.saved, []);
  assertEquals(t.tables.job_documents.length, 1);
});

Deno.test("confirmed with a supplier PDF: no order sheet", async () => {
  const f = tables();
  const file = new TextEncoder().encode("%PDF-1.4\n% confirmation\n%%EOF\n");
  f.dispatch_v2_supplier_emails.push({
    id: "r1",
    org_id: ORG,
    order_id: ORDER,
    state: "matched",
    provider_message_id: "email:m1",
    subject: "Order confirmation",
    snippet: "",
    received_at: "2026-11-01T03:00:00Z",
  });
  f.context_email_attachments.push({
    id: "a1",
    provider_message_id: "email:m1",
    file_name: "SO123.pdf",
    content_type: "application/pdf",
    sha256: await sha256HexOf(file),
    storage_bucket: "context-email-attachments",
    storage_path: "m1/SO123.pdf",
    status: "stored",
  });
  const t = makeFakeClient(f, {
    unique: UNIQUE,
    objects: new Map([["context-email-attachments/m1/SO123.pdf", file]]),
  });
  const r = await confirm(t.client);
  assertEquals(r.documents?.saved.map((s) => s.name), ["Stratco order confirmation.pdf"]);
  assertEquals(t.tables.dispatch_v2_order_documents.map((d) => d.source), ["supplier_reply"]);
});

Deno.test("confirmed with the replies unreadable: no order sheet (we do not know there is no PDF)", async () => {
  const t = makeFakeClient(tables(), {
    unique: UNIQUE,
    fail: { dispatch_v2_supplier_emails: { select: { code: "42501", message: "denied" } } },
  });
  const r = await confirm(t.client);
  assertEquals(r.documents?.read, "failed");
  assertEquals(t.tables.job_documents.length, 0);
});

// ── Tweak 5: the order's own photos when the supplier sends no PDF ─────────

const PHOTO_BUCKET = "dispatch-material-photos";
const PHOTO_1 = "c5000000-0000-4000-8000-000000000001";
const PHOTO_2 = "c5000000-0000-4000-8000-000000000002";

function jpeg(label: string): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(label)]);
}
function png(label: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, ...new TextEncoder().encode(label)]);
}

// The order with its photos on file. lines: the order's saved order_lines.
async function photoOrder(lines: Row[]) {
  const f = tables();
  const order = f.dispatch_supplier_order_emails[0];
  order.order_lines = lines;
  order.photo_ids = [PHOTO_1, PHOTO_2];
  if (lines.length === 0) {
    order.body_text = [
      "Hi Team, could we please order the following for pickup from Neerabup:",
      "",
      "Date: 3 November 2026",
      "",
      "Materials Needed:",
      "",
      "Please see attached for materials needed.",
    ].join("\n");
  }
  const files = { one: jpeg("drawing"), two: png("parts") };
  f.dispatch_material_photos = [
    {
      id: PHOTO_1,
      job_id: JOB,
      file_name: "drawing.jpg",
      content_type: "image/jpeg",
      sha256: await sha256HexOf(files.one),
      storage_path: `${JOB}/one.jpg`,
    },
    {
      id: PHOTO_2,
      job_id: JOB,
      file_name: "parts.png",
      content_type: "image/png",
      sha256: await sha256HexOf(files.two),
      storage_path: `${JOB}/two.png`,
    },
  ];
  const objects = new Map<string, Uint8Array>([
    [`${PHOTO_BUCKET}/${JOB}/one.jpg`, files.one],
    [`${PHOTO_BUCKET}/${JOB}/two.png`, files.two],
  ]);
  return makeFakeClient(f, { unique: UNIQUE, objects });
}

Deno.test("photo rules: photo-only is no line and a photo; names; the bytes must be the kind we save", () => {
  assert(dispatchOrderIsPhotoOnly({ order_lines: [], photo_ids: ["p"] }));
  assert(!dispatchOrderIsPhotoOnly({ order_lines: [{ text: "1 x A" }], photo_ids: ["p"] }));
  assert(!dispatchOrderIsPhotoOnly({ order_lines: [], photo_ids: [] }));
  assert(!dispatchOrderIsPhotoOnly({}));
  assertEquals(dispatchOrderPhotoName("Ampelite", 1), "Ampelite order photo 1");
  assertEquals(dispatchOrderPhotoName("", 2), "Supplier order photo 2");
  assert(dispatchDocBytesAre(jpeg("x"), "image/jpeg"));
  assert(dispatchDocBytesAre(png("x"), "image/png"));
  assert(!dispatchDocBytesAre(png("x"), "image/jpeg"));
  assert(!dispatchDocBytesAre(jpeg("x"), "application/pdf"));
  assert(!dispatchDocBytesAre(jpeg("x"), "image/gif"));
});

Deno.test("confirmed photo-only order, no supplier PDF: the crew line is written and the photos are saved instead of a sheet", async () => {
  const t = await photoOrder([]);
  const r = await confirm(t.client);
  // The crew pickup line is written as for any order.
  assertEquals(r.crew_line.written, true);
  assertEquals((r.crew_line as any).text, "Stratco pickup Tue 3 Nov \u00b7 from Neerabup");
  assertEquals(r.documents?.saved.map((s) => s.name), [
    "Stratco order photo 1.jpg",
    "Stratco order photo 2.png",
  ]);
  // No order sheet: it would have no lines.
  assertEquals(
    t.tables.dispatch_v2_order_documents.map((d) => [d.source, d.kind, d.state]),
    [["order_photo", "order_photo", "saved"], ["order_photo", "order_photo", "saved"]],
  );
  for (const doc of t.tables.job_documents) {
    assertEquals([doc.type, doc.visible_to_trades, doc.metadata.document_source], [
      "material_order",
      true,
      "order_photo",
    ]);
    assert(!/work order|\bWO\b/i.test(doc.file_name));
  }
  assertEquals(t.uploads.map((u) => [u.bucket, u.contentType]), [
    ["job-documents", "image/jpeg"],
    ["job-documents", "image/png"],
  ]);
  assert(t.uploads[0].path.endsWith("-Stratco-order-photo-1.jpg"));
  // The copy is the photo itself, byte for byte.
  assertEquals(
    t.objects.get(`job-documents/${t.uploads[0].path}`),
    jpeg("drawing"),
  );
  // One audit row per photo.
  assertEquals(
    t.tables.job_events.filter((e) => e.event_type === "dispatch_v2_order_document_saved").length,
    2,
  );
  // Pressed again: nothing saved twice.
  const again = await confirm(t.client);
  assertEquals(again.documents?.saved, []);
  assertEquals(t.tables.job_documents.length, 2);
});

Deno.test("confirmed order with lines and photos, no supplier PDF: the sheet AND the photos are saved", async () => {
  const t = await photoOrder([{ text: "10 x Lengths" }]);
  const r = await confirm(t.client);
  assertEquals(r.documents?.saved.map((s) => s.name), [
    "Stratco material order.pdf",
    "Stratco order photo 1.jpg",
    "Stratco order photo 2.png",
  ]);
  assertEquals(
    t.tables.dispatch_v2_order_documents.map((d) => d.source),
    ["order_sheet", "order_photo", "order_photo"],
  );
});

Deno.test("confirmed order with a supplier PDF: no sheet and no photos", async () => {
  const t = await photoOrder([]);
  const file = new TextEncoder().encode("%PDF-1.4\n% confirmation\n%%EOF\n");
  t.tables.dispatch_v2_supplier_emails.push({
    id: "r1",
    org_id: ORG,
    order_id: ORDER,
    state: "matched",
    provider_message_id: "email:m1",
    subject: "Order confirmation",
    snippet: "",
    received_at: "2026-11-01T03:00:00Z",
  });
  t.tables.context_email_attachments.push({
    id: "a1",
    provider_message_id: "email:m1",
    file_name: "SO123.pdf",
    content_type: "application/pdf",
    sha256: await sha256HexOf(file),
    storage_bucket: "context-email-attachments",
    storage_path: "m1/SO123.pdf",
    status: "stored",
  });
  t.objects.set("context-email-attachments/m1/SO123.pdf", file);
  const r = await confirm(t.client);
  assertEquals(r.documents?.saved.map((s) => s.name), ["Stratco order confirmation.pdf"]);
  assertEquals(t.tables.dispatch_v2_order_documents.map((d) => d.source), ["supplier_reply"]);
});

Deno.test("confirmed photo-only order: a photo whose bytes changed, or that is gone, is not saved; the other one is", async () => {
  const t = await photoOrder([]);
  // Photo 1's file was swapped after upload; photo 2's row is gone.
  t.objects.set(`${PHOTO_BUCKET}/${JOB}/one.jpg`, jpeg("something else"));
  t.tables.dispatch_material_photos = t.tables.dispatch_material_photos.filter((p) =>
    p.id !== PHOTO_2
  );
  const r = await confirm(t.client);
  assertEquals(r.documents?.saved, []);
  assertEquals(r.documents?.skipped.map((s) => s.reason), ["hash_mismatch", "photo_not_found"]);
  // The claim was given back, so nothing is half saved.
  assertEquals(t.tables.dispatch_v2_order_documents, []);
  assertEquals(t.tables.job_documents, []);
});
