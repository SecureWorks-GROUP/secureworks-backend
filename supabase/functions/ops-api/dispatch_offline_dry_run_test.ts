// deno-lint-ignore-file no-import-prefix no-explicit-any
// One fencing job, fixture only, from accepted through a draft Dispatch
// purchase order, the order PDF, the supplier email preview, a sighted
// delivery and the install mark. The send transport is stubbed and never
// called. Nothing here opens a database connection or writes a live row.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchDelivery,
  dispatchDeliveryRailLine,
  dispatchDeliverySummary,
  dispatchSightedOrderIds,
  isDispatchDeliveryDate,
} from "./dispatch_deliveries.ts";
import { dispatchMaterialDisplayStatus } from "./dispatch_materials.ts";
import { renderDispatchOrderPdf } from "./dispatch_order_pdf.ts";
import {
  buildDispatchEmail,
  dispatchBytesToBase64,
  type DispatchMailTransport,
} from "./dispatch_order_send.ts";
import {
  dispatchAddressCheck,
  dispatchDeliverTo,
  dispatchDraftHash,
  dispatchOrderableLines,
  dispatchOrderBody,
  dispatchOrderChip,
  dispatchOrderLines,
  dispatchOrderSubject,
  dispatchPdfFileName,
  projectDispatchDraft,
  sha256Hex,
} from "./dispatch_orders.ts";
import {
  dispatchPlace,
  dispatchRowFields,
  dispatchTodo,
} from "./dispatch_stage.ts";

const TODAY = "2026-10-18";
const JOB_ID = "a1000000-0000-4000-8000-000000000010";
const SUPPLIER_ID = "b1000000-0000-4000-8000-000000000010";
const LINE_TO_ORDER = "c1000000-0000-4000-8000-000000000010";
const LINE_IN_STOCK = "c1000000-0000-4000-8000-000000000011";
const PO_ID = "e1000000-0000-4000-8000-000000000010";
const DRAFT_ID = "f1000000-0000-4000-8000-000000000010";
const PERSON = "d1000000-0000-4000-8000-000000000010";
const PO_NUMBER = "PO-1000001";
const ORDERED_AT = "2026-10-18T03:00:00.000Z";
const SUPPLIER_EMAIL = "orders@example.test";

async function pdfText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const start = match.index + match[0].length;
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
    for (const drawn of text.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)) {
      out.push(drawn[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join("\n");
}

Deno.test("offline dry run: accepted fence through a sighted order and the install mark, and the stubbed transport is never asked to send", async () => {
  const fetchCalls: string[] = [];
  const transportCalls: unknown[] = [];
  const transport: DispatchMailTransport = (request) => {
    transportCalls.push(request);
    return Promise.resolve({ status: 200, body: { id: "not-sent" } });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.reject(new Error("offline dry run refused a network call"));
  }) as typeof fetch;

  try {
    const job = {
      id: JOB_ID,
      type: "fencing",
      status: "accepted",
      job_number: "SWF-900001",
      site_address: "1 Example St",
      site_suburb: "Exampleton",
    };
    const accepted = dispatchPlace(job, null);
    assertEquals(accepted, {
      stage: "accepted",
      index: 1,
      source: "job_status",
      from: "accepted",
    });
    assertEquals(dispatchTodo(job, accepted), { todo: true, out: null });

    const lines = [
      {
        id: LINE_TO_ORDER,
        job_id: JOB_ID,
        supplier_id: SUPPLIER_ID,
        status: "to_order",
        description: "Colorbond sheet 2.1 m",
        quantity: 18,
        unit: "sheets",
        position: 1,
        purchase_order_id: null,
      },
      {
        id: LINE_IN_STOCK,
        job_id: JOB_ID,
        supplier_id: SUPPLIER_ID,
        status: "in_stock",
        description: "Post mix",
        quantity: 4,
        unit: "bags",
        position: 2,
        purchase_order_id: null,
      },
    ];
    const orderable = dispatchOrderableLines(lines, SUPPLIER_ID);
    assertEquals(orderable.map((line) => line.id), [LINE_TO_ORDER]);
    const orderLines = dispatchOrderLines(orderable);
    assertEquals(orderLines, [{
      line_id: LINE_TO_ORDER,
      description: "Colorbond sheet 2.1 m",
      quantity: 18,
      unit: "sheets",
    }]);

    const deliverTo = dispatchDeliverTo(job.site_address, job.site_suburb);
    const site = "1 Example St, Exampleton";
    assertEquals(deliverTo, site);
    const order = {
      id: PO_ID,
      po_number: PO_NUMBER,
      supplier_id: SUPPLIER_ID,
      supplier_name: "Example Steel",
      source: "dispatch",
      status: "draft",
      po_type: null,
      created_at: ORDERED_AT,
      updated_at: ORDERED_AT,
      xero_po_id: null,
      pdf_version: 1,
      last_sent_at: null,
      delivery_date: null as string | null,
      confirmed_delivery_date: null as string | null,
      confirmed_delivery_set_at: null as string | null,
      confirmed_delivery_set_by: null as string | null,
      confirmed_delivery_set_by_email: null as string | null,
      delivery_sighted_at: null as string | null,
      delivery_sighted_by: null as string | null,
      delivery_sighted_by_email: null as string | null,
    };
    const stamped = lines.map((line) =>
      line.id === LINE_TO_ORDER ? { ...line, purchase_order_id: PO_ID } : line
    );
    assertEquals(dispatchOrderableLines(stamped, SUPPLIER_ID), []);
    assertEquals(dispatchMaterialDisplayStatus(stamped[0]), "on_po");
    assertEquals(dispatchMaterialDisplayStatus(stamped[1]), "in_stock");

    const nowMs = Date.parse(ORDERED_AT);
    const chip = dispatchOrderChip({
      order,
      openDraft: { status: "draft", updated_at: ORDERED_AT },
      newestMessage: null,
      nowMs,
    });
    assertEquals(chip.state, "draft_ready");

    const pdf = await renderDispatchOrderPdf({
      poNumber: PO_NUMBER,
      version: 1,
      orderedAt: ORDERED_AT,
      jobNumber: job.job_number,
      supplierName: "Example Steel",
      deliverTo,
      lines: orderLines,
    });
    assertEquals(pdf.lineCount, 1);
    assertEquals(pdf.pageCount, 1);
    assertEquals(pdf.bytes[0], 0x25);
    assert(
      new TextDecoder().decode(pdf.bytes.slice(0, 5)).startsWith("%PDF"),
    );
    const drawn = await pdfText(pdf.bytes);
    for (
      const expected of [
        "PURCHASE ORDER",
        PO_NUMBER,
        "18/10/2026",
        job.job_number,
        "Example Steel",
        site,
        "Colorbond sheet 2.1 m",
        "18",
        "sheets",
      ]
    ) {
      assert(drawn.includes(expected), expected);
    }

    const subject = dispatchOrderSubject("order", PO_NUMBER, job.job_number);
    const body = dispatchOrderBody({
      kind: "order",
      poNumber: PO_NUMBER,
      jobNumber: job.job_number,
      suburb: job.site_suburb,
      lines: orderLines,
    });
    assert(body.includes(PO_NUMBER));
    assert(body.includes("18 sheets Colorbond sheet 2.1 m"));
    const address = dispatchAddressCheck(SUPPLIER_EMAIL);
    assertEquals(address, { state: "ok", email: SUPPLIER_EMAIL });
    const bodySha = await sha256Hex(body);
    const draft = {
      id: DRAFT_ID,
      purchase_order_id: PO_ID,
      supplier_id: SUPPLIER_ID,
      kind: "order",
      status: "draft",
      subject,
      body_text: body,
      body_generated_sha: bodySha,
    };
    const preview = await projectDispatchDraft({
      draft,
      order,
      supplier: { name: "Example Steel", email: SUPPLIER_EMAIL },
      nowMs,
      currentGeneratedSha: bodySha,
    });
    assertEquals(preview.status, "draft");
    assertEquals(preview.to, { email: SUPPLIER_EMAIL, state: "ok" });
    assertEquals(preview.subject, subject);
    assertEquals(preview.body_text, body);
    assertEquals(preview.body_edited, false);
    const email = buildDispatchEmail({
      to: preview.to.email as string,
      subject: preview.subject,
      bodyText: preview.body_text,
      poNumber: PO_NUMBER,
      jobNumber: job.job_number,
      pdf: {
        fileName: dispatchPdfFileName(PO_NUMBER),
        base64: dispatchBytesToBase64(pdf.bytes),
      },
    });
    assertEquals(email.to, [SUPPLIER_EMAIL]);
    assertEquals(email.subject, `Purchase order ${PO_NUMBER} for SWF-900001`);
    const attachment = email.attachments?.[0];
    assert(attachment);
    assertEquals(attachment.filename, `${PO_NUMBER}.pdf`);
    assert(attachment.content.length > 0);
    assertEquals(
      await dispatchDraftHash({
        draft_id: DRAFT_ID,
        purchase_order_id: PO_ID,
        to_email: SUPPLIER_EMAIL,
        subject,
        body_text: body,
        pdf_sha256: pdf.sha256,
      }),
      await dispatchDraftHash({
        draft_id: DRAFT_ID,
        purchase_order_id: PO_ID,
        to_email: SUPPLIER_EMAIL,
        subject,
        body_text: body,
        pdf_sha256: pdf.sha256,
      }),
    );
    // The preview is the payload. The send is a separate call, and this run
    // does not make it.
    void transport;
    assertEquals(transportCalls.length, 0);

    assert(isDispatchDeliveryDate("2026-10-22"));
    order.delivery_date = "2026-10-22";
    let delivery = dispatchDelivery(order);
    assertEquals(delivery.expected, "2026-10-22");
    assertEquals(delivery.expected_editable, true);
    assertEquals(delivery.confirmed.state, "waiting");
    assertEquals(delivery.step, 1);

    const names = new Map([[PERSON, "Office Person"]]);
    order.confirmed_delivery_date = "2026-10-23";
    order.confirmed_delivery_set_at = "2026-10-18T04:00:00.000Z";
    order.confirmed_delivery_set_by = PERSON;
    order.confirmed_delivery_set_by_email = "office@example.test";
    delivery = dispatchDelivery(order, names);
    assertEquals(delivery.confirmed.state, "date");
    assertEquals(delivery.confirmed.date, "2026-10-23");
    assertEquals(delivery.confirmed.by_hand, true);
    assertEquals(delivery.confirmed.set_by, "Office Person");
    assertEquals(delivery.step, 2);

    order.delivery_sighted_at = "2026-10-23T02:00:00.000Z";
    order.delivery_sighted_by = PERSON;
    order.delivery_sighted_by_email = "office@example.test";
    delivery = dispatchDelivery(order, names);
    assertEquals(delivery.sighted, {
      at: "2026-10-23T02:00:00.000Z",
      by: "Office Person",
    });
    assertEquals(delivery.step, 3);
    const sighted = dispatchSightedOrderIds([order]);
    assertEquals(
      dispatchMaterialDisplayStatus(stamped[0], sighted),
      "delivered",
    );
    const summary = dispatchDeliverySummary([order]);
    assertEquals(summary, { counted: 1, sighted: 1, all_sighted: true });
    assertEquals(
      dispatchDeliveryRailLine(
        summary.counted,
        summary.sighted,
        accepted.index,
      ),
      "Every order on this job is sighted on site. Press Materials on site to move the job.",
    );

    const bookingDay = "2026-10-20";
    const scheduled = { ...job, status: "scheduled" };
    const booking = {
      id: "asg-1",
      job_id: JOB_ID,
      user_id: PERSON,
      scheduled_date: bookingDay,
      scheduled_end: null,
      assignment_type: "install",
      status: null,
      is_ghost: false,
      role: "lead_installer",
      is_lead: true,
      confirmation_status: "confirmed",
      person: { name: "Office Person" },
    };
    const beforeMark = dispatchRowFields(scheduled, null, {
      bookings: [booking],
      today: TODAY,
    });
    assertEquals(beforeMark.dispatch_stage, "trade_scheduled");
    assertEquals(beforeMark.dispatch_stage_index, 6);
    assertEquals(beforeMark.dispatch_install?.calendar_confirmed, true);
    assertEquals(beforeMark.dispatch_install?.confirmed, null);
    assertEquals(beforeMark.dispatch_todo, true);
    assertEquals(beforeMark.dispatch_install_open, "not_confirmed");

    const marked = dispatchRowFields(scheduled, {
      install_confirmed_at: "2026-10-18T05:00:00.000Z",
      install_confirmed_by: PERSON,
      install_confirmed_by_email: "office@example.test",
      install_confirmed_for_day: bookingDay,
      install_confirmer: { name: "Office Person" },
    }, { bookings: [booking], today: TODAY });
    assertEquals(marked.dispatch_install?.confirmed, {
      at: "2026-10-18T05:00:00.000Z",
      by: "Office Person",
      for_day: bookingDay,
    });
    assertEquals(marked.dispatch_install?.confirmed_current, true);
    assertEquals(marked.dispatch_todo, false);
    assertEquals(marked.dispatch_install_open, null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(fetchCalls, []);
  assertEquals(transportCalls.length, 0);
});
