// deno-lint-ignore-file no-import-prefix no-explicit-any
// One fencing job, fixture only, from accepted through a draft Dispatch
// purchase order, the order PDF, the supplier email preview, then the real
// send, delivery and install writers. The transport is a stub that records
// the payload and answers 2xx. fetch is refused, so a path that posts to
// Resend fails this run. Nothing here opens a database connection or writes
// a live row.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  markDispatchDeliverySighted,
  setDispatchDeliveryConfirmed,
  setDispatchDeliveryExpected,
} from "./dispatch_deliveries_store.ts";
import { setDispatchInstallConfirmed } from "./dispatch_install_write.ts";
import { dispatchMaterialDisplayStatus } from "./dispatch_materials.ts";
import { makeDispatchMemory } from "./dispatch_memory_client.ts";
import { renderDispatchOrderPdf } from "./dispatch_order_pdf.ts";
import {
  buildDispatchEmail,
  dispatchBytesToBase64,
  dispatchDraftIdempotencyKey,
  type DispatchMailTransport,
} from "./dispatch_order_send.ts";
import { sendDispatchOrderDraft } from "./dispatch_orders_store.ts";
import {
  DISPATCH_ORDER_PDF_BUCKET,
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

function seen(value: object, key: string): unknown {
  return Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

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

Deno.test("offline dry run: accepted fence through the real send, a sighted delivery and the install mark", async () => {
  const fetchCalls: string[] = [];
  const transportCalls: unknown[] = [];
  const transport: DispatchMailTransport = (request) => {
    transportCalls.push(request);
    return Promise.resolve({ status: 200, body: { id: "re_dry_run_fixture" } });
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
    const orgId = "00000000-0000-4000-8000-000000000001";
    const pdfPath = `${JOB_ID}/${PO_NUMBER}.pdf`;
    const storedDraft = {
      ...draft,
      org_id: orgId,
      job_id: JOB_ID,
      pdf_version: 1,
      pdf_path: pdfPath,
      pdf_sha256: pdf.sha256,
      line_count: 1,
      order_lines: orderLines,
      to_email_sent: null,
      attempt_to_email: null,
      attempt_in_reply_to: null,
      send_attempt: null,
      last_error: null,
      communication_id: null,
      resend_id: null,
      sent_at: null,
      sent_by_email: null,
      sent_via: null,
      created_at: ORDERED_AT,
      updated_at: ORDERED_AT,
    };
    const memory = makeDispatchMemory({
      jobs: [{
        ...job,
        org_id: orgId,
        metadata: null,
        council_required: false,
      }],
      users: [{
        id: PERSON,
        org_id: orgId,
        name: "Office Person",
        email: "office@example.test",
      }],
      suppliers: [{
        id: SUPPLIER_ID,
        org_id: orgId,
        name: "Example Steel",
        email: SUPPLIER_EMAIL,
      }],
      purchase_orders: [{
        ...order,
        org_id: orgId,
        job_id: JOB_ID,
        line_items: [],
        reference: null,
        pdf_path: pdfPath,
        pdf_sha256: pdf.sha256,
        confirmed_delivery_date: null,
        confirmed_delivery_set_at: null,
        confirmed_delivery_set_by: null,
        confirmed_delivery_set_by_email: null,
        delivery_sighted_at: null,
        delivery_sighted_by: null,
        delivery_sighted_by_email: null,
      }],
      job_order_emails: [storedDraft],
      job_material_lines: [
        {
          id: LINE_TO_ORDER,
          org_id: orgId,
          job_id: JOB_ID,
          supplier_id: SUPPLIER_ID,
          status: "to_order",
          purchase_order_id: PO_ID,
        },
        {
          id: LINE_IN_STOCK,
          org_id: orgId,
          job_id: JOB_ID,
          supplier_id: SUPPLIER_ID,
          status: "in_stock",
          purchase_order_id: null,
        },
      ],
      po_communications: [],
      email_events: [],
      job_events: [],
      job_assignments: [],
      job_dispatch_state: [],
    });
    memory.putFile(DISPATCH_ORDER_PDF_BUCKET, pdfPath, pdf.bytes);
    const expectedHash = (await projectDispatchDraft({
      draft: storedDraft,
      order,
      supplier: { name: "Example Steel", email: SUPPLIER_EMAIL },
      nowMs,
      currentGeneratedSha: null,
    })).draft_hash;

    const sent = await sendDispatchOrderDraft(memory, {
      draft_id: DRAFT_ID,
      expected_draft_hash: expectedHash,
    }, {
      orgId,
      actor: {
        userId: PERSON,
        email: "office@example.test",
        orgId,
      },
      via: "screen",
      transport,
      now: () => "2026-10-18T06:00:00.000Z",
    });
    assertEquals(sent.success, true);
    assertEquals(sent.filed, true);
    assertEquals(sent.resend_id, "re_dry_run_fixture");
    assertEquals(sent.draft, {
      id: DRAFT_ID,
      status: "sent",
      to_email_sent: SUPPLIER_EMAIL,
      sent_at: "2026-10-18T06:00:00.000Z",
      sent_by_email: "office@example.test",
    });
    assertEquals(sent.order.status, "sent");
    assertEquals(transportCalls.length, 1);
    const carried = transportCalls[0] as {
      payload: { to: string[]; subject: string; attachments?: Array<{ filename: string; content: string }> };
      idempotencyKey: string;
    };
    assertEquals(carried.payload.to, [SUPPLIER_EMAIL]);
    assertEquals(carried.payload.subject, email.subject);
    assertEquals(carried.payload.attachments?.[0].filename, `${PO_NUMBER}.pdf`);
    assert((carried.payload.attachments?.[0].content.length ?? 0) > 0);
    assertEquals(
      carried.idempotencyKey,
      dispatchDraftIdempotencyKey(DRAFT_ID, 1),
    );
    assertEquals(memory.rows("job_order_emails")[0].status, "sent");
    assertEquals(memory.rows("purchase_orders")[0].status, "sent");
    assertEquals(
      memory.rows("job_events").map((row) => row.event_type),
      ["po_email_sent"],
    );
    assertEquals(memory.rows("po_communications").length, 1);
    assertEquals(memory.rows("email_events").length, 1);

    const deliveries = {
      orgId,
      actor: {
        userId: PERSON,
        email: "office@example.test",
        orgId,
      },
      via: "screen" as const,
      now: () => "2026-10-18T07:00:00.000Z",
    };
    const sentStamp = seen(sent.order, "updated_at");
    if (typeof sentStamp !== "string" || !sentStamp) {
      throw new Error("sent order published no updated_at");
    }
    const expected = await setDispatchDeliveryExpected(memory, {
      purchase_order_id: PO_ID,
      expected_updated_at: sentStamp,
      delivery_date: "2026-10-22",
    }, deliveries);
    assertEquals(expected.success, true);
    assertEquals(seen(expected, "unchanged"), undefined);
    assertEquals(expected.order.delivery.expected, "2026-10-22");
    assertEquals(expected.order.delivery.step, 1);
    assertEquals(expected.order.delivery.confirmed.state, "waiting");
    assertEquals(expected.deliveries, {
      counted: 1,
      sighted: 0,
      all_sighted: false,
    });
    assertEquals(expected.counts, { total: 2, ready: 1 });

    const confirmed = await setDispatchDeliveryConfirmed(memory, {
      purchase_order_id: PO_ID,
      expected_updated_at: expected.order.updated_at,
      confirmed_delivery_date: "2026-10-23",
      via: "deliveries",
    }, deliveries);
    assertEquals(confirmed.order.delivery.confirmed, {
      state: "date",
      date: "2026-10-23",
      set_by: "Office Person",
      set_at: "2026-10-18T07:00:00.000Z",
      by_hand: true,
    });
    assertEquals(confirmed.order.delivery.step, 2);
    assertEquals(
      memory.rows("purchase_orders")[0].confirmed_delivery_set_by,
      PERSON,
    );

    const sighted = await markDispatchDeliverySighted(memory, {
      purchase_order_id: PO_ID,
      expected_updated_at: confirmed.order.updated_at,
      sighted: true,
    }, deliveries);
    assertEquals(sighted.order.delivery.sighted, {
      at: "2026-10-18T07:00:00.000Z",
      by: "Office Person",
    });
    assertEquals(sighted.order.delivery.step, 3);
    assertEquals(sighted.deliveries, {
      counted: 1,
      sighted: 1,
      all_sighted: true,
    });
    assertEquals(sighted.counts, { total: 2, ready: 2 });
    assertEquals(memory.rows("purchase_orders")[0].status, "sent");
    assertEquals(
      memory.rows("job_events").map((row) => row.event_type),
      [
        "po_email_sent",
        "po_delivery_expected_set",
        "po_delivery_confirmed_set",
        "po_delivery_sighted",
      ],
    );

    const bookingDay = "2026-10-20";
    memory.rows("jobs")[0].status = "scheduled";
    memory.rows("job_assignments").push({
      id: "a2000000-0000-4000-8000-000000000010",
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
    });
    const beforeMark = dispatchRowFields(
      memory.rows("jobs")[0],
      null,
      { bookings: memory.rows("job_assignments"), today: TODAY },
    );
    assertEquals(beforeMark.dispatch_stage, "trade_scheduled");
    assertEquals(beforeMark.dispatch_todo, true);
    assertEquals(beforeMark.dispatch_install_open, "not_confirmed");

    const marked = await setDispatchInstallConfirmed(memory, {
      job_id: JOB_ID,
      confirmed: true,
      expected_install_day: bookingDay,
      expected_confirmed_at: null,
    }, {
      mode: "jwt",
      userId: PERSON,
      email: "office@example.test",
    }, orgId, TODAY);
    assertEquals(marked.success, true);
    assertEquals(marked.audit_logged, true);
    assertEquals(marked.dispatch_install?.confirmed?.for_day, bookingDay);
    assertEquals(marked.dispatch_install?.confirmed?.by, "Office Person");
    assertEquals(marked.dispatch_install?.confirmed_current, true);
    assertEquals(marked.dispatch_todo, false);
    assertEquals(marked.dispatch_install_open, null);
    const state = memory.rows("job_dispatch_state")[0];
    assertEquals(state.install_confirmed_by, PERSON);
    assertEquals(state.install_confirmed_for_day, bookingDay);
    assertEquals(state.stage ?? null, null);
    assertEquals(
      marked.dispatch_install?.confirmed?.at,
      state.install_confirmed_at,
    );
    assertEquals(memory.rows("jobs")[0].status, "scheduled");
    assertEquals(
      memory.rows("job_assignments")[0].confirmation_status,
      "confirmed",
    );
    assertEquals(
      memory.rows("job_events").at(-1)?.event_type,
      "dispatch_install_confirmed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(fetchCalls, []);
  assertEquals(transportCalls.length, 1);
});
