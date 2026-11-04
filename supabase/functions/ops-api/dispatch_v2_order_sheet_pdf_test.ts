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
import { sha256HexOf } from "./dispatch_v2_order_documents.ts";

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
