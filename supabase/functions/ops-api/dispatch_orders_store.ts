// deno-lint-ignore-file no-explicit-any
// Dispatch slice 5: the two reads and the nine writes behind a purchase order
// and its email. Contract: docs/dispatch-slice-5-contract.md. Rules:
// dispatch_orders.ts (lines, text, hash, address check, chip, threads),
// dispatch_order_pdf.ts (the PDF), dispatch_order_send.ts (the email).
//
// What this touches: purchase_orders (its Dispatch orders), job_material_lines
// (stamped and released only inside the two dispatch_commit_* functions),
// job_order_emails, po_communications, email_events and job_events, the
// private bucket dispatch-order-pdfs, and one outside call, Resend, only from
// a send or a reply. Never jobs, the Dispatch stage, suppliers, Xero,
// business_events, reporting-api, ghl-proxy or send-po-email.
//
// PostgREST returns errors, it does not throw: every read and write reads
// `error`. A failed read is never "nothing there".

import {
  OTHER_SUPPLIER_ORDER_SELECT,
  otherOpenSupplierOrders,
} from "./dispatch_other_supplier_orders.ts";
import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
  readDispatchJobCounts,
} from "./dispatch_materials_store.ts";
import {
  DISPATCH_MATERIAL_LINE_SELECT,
  isDispatchUuid,
  projectDispatchMaterialLine,
} from "./dispatch_materials.ts";
import {
  DISPATCH_FAMILY_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";
import {
  DISPATCH_DRAFT_BODY_MAX,
  DISPATCH_DRAFT_SUBJECT_MAX,
  DISPATCH_ORDER_LINES_MAX,
  DISPATCH_ORDER_PDF_BUCKET,
  DISPATCH_ORDER_PDF_LINK_SECONDS,
  DISPATCH_THREAD_ROWS_LOG_AT,
  dispatchAddressCheck,
  dispatchDeliverTo,
  dispatchGroupThreads,
  type DispatchLineStamp,
  dispatchOrderableLines,
  dispatchOrderBody,
  type DispatchOrderLine,
  dispatchOrderLines,
  dispatchOrderSubject,
  dispatchPdfFileName,
  dispatchSameLineSet,
  dispatchSupplierOrder,
  dispatchUpdateDraftPlan,
  isStaleSending,
  projectDispatchDraft,
  publicThread,
  sameInstant,
  sha256Hex,
} from "./dispatch_orders.ts";
import {
  type DispatchOrderPdf,
  type DispatchOrderPdfInput,
  dispatchOrderPdfPath,
  renderDispatchOrderPdf,
} from "./dispatch_order_pdf.ts";
import {
  buildDispatchEmail,
  DISPATCH_ORDERS_ADDRESS,
  dispatchBytesToBase64,
  dispatchDraftIdempotencyKey,
  type DispatchMailTransport,
  dispatchReplyIdempotencyKey,
  dispatchReplySubject,
  runDispatchSend,
} from "./dispatch_order_send.ts";
import { fetchAllRows } from "./makesafe_compact_reads.ts";

export type DispatchOrdersContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // screen: a signed-in staff session; terminal: the privileged ops key.
  via: "screen" | "terminal";
  transport: DispatchMailTransport;
  renderPdf?: (input: DispatchOrderPdfInput) => Promise<DispatchOrderPdf>;
  now?: () => string;
};

export const DISPATCH_ORDERS_READ_ACTIONS = [
  "dispatch_order_emails",
  "dispatch_order_pdf",
] as const;
export const DISPATCH_ORDERS_WRITE_ACTIONS = [
  "dispatch_order_create",
  "dispatch_order_update",
  "dispatch_order_cancel",
  "dispatch_order_draft_save",
  "dispatch_order_discard",
  "dispatch_order_release_unknown",
  "dispatch_order_send",
  "dispatch_order_reply",
  "dispatch_email_link_po",
] as const;
export const DISPATCH_ORDERS_ACTIONS = [
  ...DISPATCH_ORDERS_READ_ACTIONS,
  ...DISPATCH_ORDERS_WRITE_ACTIONS,
] as const;
// The two actions that send an email, and the only two that call Resend.
export const DISPATCH_ORDERS_SENDING_ACTIONS = [
  "dispatch_order_send",
  "dispatch_order_reply",
] as const;

// Verified against the live schema on 14 Oct 2026 (purchase_orders,
// po_communications, email_events, job_events, users); job_order_emails and the
// nine purchase_orders columns are this slice's migration.
const JOB_SELECT = "id, org_id, job_number, type, site_address, site_suburb, " +
  DISPATCH_FAMILY_PROJECTION.join(", ");
const ORDER_SELECT =
  "id, org_id, job_id, po_number, supplier_name, supplier_id, source, status, line_items, reference, xero_po_id, created_at, updated_at, pdf_path, pdf_sha256, pdf_version, last_sent_pdf_version, last_sent_at";
const DRAFT_SELECT =
  "id, org_id, job_id, purchase_order_id, supplier_id, kind, status, subject, body_text, body_generated_sha, pdf_version, pdf_path, pdf_sha256, line_count, order_lines, to_email_sent, attempt_to_email, attempt_in_reply_to, send_attempt, last_error, communication_id, resend_id, sent_at, sent_by_email, sent_via, created_at, updated_at";
const CONTACT_SELECT = "id, org_id, name, email";
export const DISPATCH_COMMUNICATION_SELECT =
  "id, po_id, job_id, direction, from_email, to_email, subject, body_text, body_html, attachments_json, sent_at, received_at, created_at, communication_type, message_id, thread_id, delivery_status";
const OPEN_DRAFT_STATUSES = ["draft", "sending", "send_unknown"];

// ── Errors ──────────────────────────────────────────────────────────────────

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchMaterialsError(status, code, message, extra);
}

function readFailed(label: string, error: any): never {
  console.error(`[dispatch_orders] ${label} failed:`, error);
  refuse(500, "orders_read_failed", `${label} failed`);
}

function writeFailed(label: string, error: any): never {
  console.error(`[dispatch_orders] ${label} failed:`, error);
  refuse(500, "orders_write_failed", `${label} failed`);
}

function badRequest(message: string): never {
  refuse(400, "invalid_request", message);
}

function nowIso(ctx: DispatchOrdersContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function nowMs(ctx: DispatchOrdersContext): number {
  return Date.parse(nowIso(ctx));
}

function requireUuid(value: unknown, name: string): string {
  if (!isDispatchUuid(value)) badRequest(`${name} must be a uuid`);
  return value as string;
}

function requireStamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))
  ) {
    badRequest(`${name} must be a timestamp`);
  }
  return value as string;
}

function lineStamps(value: unknown, name: string): DispatchLineStamp[] {
  if (!Array.isArray(value)) badRequest(`${name} must be a list`);
  if ((value as unknown[]).length > DISPATCH_ORDER_LINES_MAX) {
    badRequest(`${name} holds at most ${DISPATCH_ORDER_LINES_MAX} lines`);
  }
  return (value as any[]).map((item, index) => {
    if (!item || typeof item !== "object") {
      badRequest(`${name}[${index}] must be { id, updated_at }`);
    }
    return {
      id: requireUuid(item.id, `${name}[${index}].id`),
      updated_at: requireStamp(item.updated_at, `${name}[${index}].updated_at`),
    };
  });
}

// The two commit functions raise one of these words as a P0001 message.
const COMMIT_REFUSALS: Record<string, [number, string]> = {
  lines_changed: [409, "This changed somewhere else. Showing the latest."],
  order_open: [409, "This supplier already has an open order on this job"],
  order_changed: [409, "This order changed somewhere else"],
  draft_changed: [409, "This draft changed somewhere else"],
  draft_sending: [
    409,
    "This order's email is being sent or its send is not confirmed",
  ],
  no_lines_to_order: [409, "There is no To order line for this supplier"],
  order_sent: [
    409,
    "This order was sent. Tell the supplier by replying on its thread.",
  ],
};

function commitRefusal(error: any): [string, number, string] | null {
  const message = String(error?.message ?? "").trim();
  if (COMMIT_REFUSALS[message]) return [message, ...COMMIT_REFUSALS[message]];
  // The open-order partial unique index, if two creates race past the check.
  if (String(error?.code) === "23505") {
    return ["order_open", ...COMMIT_REFUSALS.order_open];
  }
  return null;
}

// Every line projection here goes through one helper, so a line never maps
// with Array.map's index as a second argument.
function projectLine(row: any) {
  return projectDispatchMaterialLine(row);
}

// ── Loads ───────────────────────────────────────────────────────────────────

type DispatchOrderJob = {
  id: string;
  org_id: string;
  job_number: string | null;
  work_type: string;
  site_address: string | null;
  site_suburb: string | null;
};

async function loadJob(
  client: any,
  jobIdInput: unknown,
  ctx: DispatchOrdersContext,
): Promise<DispatchOrderJob> {
  const jobId = typeof jobIdInput === "string" ? jobIdInput.trim() : "";
  if (!jobId) badRequest("job_id required");
  if (!isDispatchUuid(jobId)) badRequest("job_id must be a uuid");
  const { data: job, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (
    !job || String(job.org_id || "") !== ctx.orgId ||
    (ctx.actor.orgId && String(job.org_id || "") !== ctx.actor.orgId)
  ) {
    refuse(404, "job_not_found", "Job not found");
  }
  const workType = dispatchWorkType(job);
  if (workType === "makesafe") {
    refuse(
      409,
      "not_dispatch_work",
      "Purchase orders are not made from Dispatch on a make-safe job",
    );
  }
  return {
    id: job.id,
    org_id: job.org_id,
    job_number: job.job_number ?? null,
    work_type: workType,
    site_address: job.site_address ?? null,
    site_suburb: job.site_suburb ?? null,
  };
}

async function readJobOrders(
  client: any,
  jobId: string,
  ctx: DispatchOrdersContext,
) {
  // purchase_orders.status is NOT NULL live, so neq drops no row it should keep.
  const { data, error } = await client.from("purchase_orders")
    .select(ORDER_SELECT)
    .eq("job_id", jobId)
    .eq("org_id", ctx.orgId)
    .neq("status", "deleted")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { data: (data || []) as any[], error };
}

// Every order on the job, filtered to non-Dispatch in code:
// `.neq("source", "dispatch")` would drop the source-null office orders.
async function readOtherSupplierOrders(
  client: any,
  jobId: string,
  ctx: DispatchOrdersContext,
) {
  const { data, error } = await client.from("purchase_orders")
    .select(OTHER_SUPPLIER_ORDER_SELECT)
    .eq("job_id", jobId)
    .eq("org_id", ctx.orgId)
    .neq("status", "deleted")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return { data: (data || []) as any[], error };
}

async function readOrder(
  client: any,
  orderId: string,
  ctx: DispatchOrdersContext,
) {
  const { data, error } = await client.from("purchase_orders")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("order read", error);
  if (!data || data.status === "deleted") {
    refuse(404, "order_not_found", "Order not found");
  }
  return data;
}

async function readContact(
  client: any,
  supplierId: string,
  ctx: DispatchOrdersContext,
) {
  const { data, error } = await client.from("suppliers")
    .select(CONTACT_SELECT)
    .eq("id", supplierId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("supplier contact read", error);
  return data || null;
}

async function readContacts(
  client: any,
  ids: string[],
  ctx: DispatchOrdersContext,
) {
  const byId = new Map<string, any>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return byId;
  const { data, error } = await client.from("suppliers")
    .select(CONTACT_SELECT)
    .in("id", unique)
    .eq("org_id", ctx.orgId);
  if (error) readFailed("supplier contacts read", error);
  for (const row of data || []) byId.set(String(row.id), row);
  return byId;
}

async function readSupplierLines(
  client: any,
  jobId: string,
  supplierId: string,
) {
  try {
    return await fetchAllRows<any>(
      () =>
        client.from("job_material_lines")
          .select(DISPATCH_MATERIAL_LINE_SELECT)
          .eq("job_id", jobId)
          .eq("supplier_id", supplierId),
      "dispatch_orders.lines",
      "id",
    );
  } catch (error) {
    readFailed("lines read", error);
  }
}

async function readOpenDraft(client: any, orderId: string) {
  const { data, error } = await client.from("job_order_emails")
    .select(DRAFT_SELECT)
    .eq("purchase_order_id", orderId)
    .in("status", OPEN_DRAFT_STATUSES);
  if (error) readFailed("draft read", error);
  return (data || [])[0] || null;
}

async function readDraft(
  client: any,
  draftId: string,
  ctx: DispatchOrdersContext,
) {
  const { data, error } = await client.from("job_order_emails")
    .select(DRAFT_SELECT)
    .eq("id", draftId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("draft read", error);
  if (!data) refuse(404, "draft_not_found", "Draft not found");
  return data;
}

// The order lines of the newest email sent for each order, so an update email
// can say what was added and taken off since.
async function readLastSentLines(client: any, orderIds: string[]) {
  const byOrder = new Map<string, DispatchOrderLine[]>();
  const unique = [...new Set(orderIds.filter(Boolean))];
  if (unique.length === 0) return byOrder;
  const { data, error } = await client.from("job_order_emails")
    .select("purchase_order_id, order_lines, sent_at")
    .in("purchase_order_id", unique)
    .eq("status", "sent")
    .order("sent_at", { ascending: false });
  if (error) readFailed("sent drafts read", error);
  for (const row of data || []) {
    const key = String(row.purchase_order_id);
    if (!byOrder.has(key)) {
      byOrder.set(key, Array.isArray(row.order_lines) ? row.order_lines : []);
    }
  }
  return byOrder;
}

// Slice 6: the shared count read, which also counts lines on a sighted order.
function readJobCounts(client: any, jobId: string) {
  return readDispatchJobCounts(client, jobId, "dispatch_orders");
}

// The job's purchase order and client email rows: by job, and every row on
// one of the job's orders. Council rows are left out. Never capped.
async function readJobCommunications(
  client: any,
  jobId: string,
  orderIds: string[],
) {
  try {
    const [byJob, byOrder] = await Promise.all([
      fetchAllRows<any>(
        () =>
          client.from("po_communications")
            .select(DISPATCH_COMMUNICATION_SELECT)
            .eq("job_id", jobId)
            .in("communication_type", ["purchase_order", "client"]),
        "dispatch_orders.communications_by_job",
        "id",
      ),
      orderIds.length > 0
        ? fetchAllRows<any>(
          () =>
            client.from("po_communications")
              .select(DISPATCH_COMMUNICATION_SELECT)
              .in("po_id", orderIds)
              .eq("communication_type", "purchase_order"),
          "dispatch_orders.communications_by_order",
          "id",
        )
        : Promise.resolve([]),
    ]);
    const byId = new Map<string, any>();
    for (const row of [...byJob, ...byOrder]) byId.set(String(row.id), row);
    const rows = [...byId.values()];
    if (rows.length > DISPATCH_THREAD_ROWS_LOG_AT) {
      console.log(
        `[dispatch_orders] job ${jobId} has ${rows.length} email rows; answering all`,
      );
    }
    return { rows, error: null };
  } catch (error) {
    console.error("[dispatch_orders] communications read failed:", error);
    return { rows: [] as any[], error };
  }
}

function orderLookup(orders: any[]) {
  return new Map(orders.map((o) => [String(o.id), {
    po_number: o.po_number ?? null,
    supplier_name: o.supplier_name ?? null,
  }]));
}

// The person a send is attributed to. A signed-in session names itself; the
// ops key must name a user by operator_email (desk rule: the person who gave
// the explicit yes).
async function resolveSender(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
): Promise<{ userId: string | null; email: string }> {
  if (ctx.via === "screen") {
    if (!ctx.actor.userId || !ctx.actor.email) {
      refuse(400, "operator_required", "A named person is required to send");
    }
    return { userId: ctx.actor.userId, email: ctx.actor.email };
  }
  const raw = typeof body?.operator_email === "string"
    ? body.operator_email.trim()
    : "";
  if (!raw) {
    refuse(
      400,
      "operator_required",
      "operator_email naming a person is required to send",
    );
  }
  const { data, error } = await client.from("users")
    .select("id, email, org_id")
    .eq("org_id", ctx.orgId)
    .in("email", [...new Set([raw, raw.toLowerCase()])]);
  if (error) readFailed("operator read", error);
  const match = (data || []).find((u: any) =>
    String(u.email || "").toLowerCase() === raw.toLowerCase()
  );
  if (!match) {
    refuse(
      400,
      "operator_required",
      "operator_email does not name a person in users",
    );
  }
  // The key is not that person: sent_by stays null and the email names them.
  return { userId: null, email: String(match.email) };
}

// ── Projections ─────────────────────────────────────────────────────────────

function projectOrder(
  order: any,
  openDrafts: any[],
  messages: any[],
  ctx: DispatchOrdersContext,
) {
  return dispatchSupplierOrder({
    orders: [{ ...order, status: order.status }],
    supplierId: String(order.supplier_id ?? ""),
    openDrafts,
    messages,
    nowMs: nowMs(ctx),
  }) ?? {
    id: order.id,
    po_number: order.po_number ?? null,
    status: order.status ?? null,
    chip: null,
    in_xero: !!order.xero_po_id,
    pdf_version: order.pdf_version ?? null,
    last_sent_pdf_version: order.last_sent_pdf_version ?? null,
    last_sent_at: order.last_sent_at ?? null,
  };
}

async function generatedShaFor(
  draft: any,
  order: any,
  job: DispatchOrderJob,
  lastSent: DispatchOrderLine[] | null,
): Promise<string> {
  return await sha256Hex(dispatchOrderBody({
    kind: draft.kind === "update" ? "update" : "order",
    poNumber: order.po_number,
    jobNumber: job.job_number,
    suburb: job.site_suburb,
    lines: Array.isArray(draft.order_lines) ? draft.order_lines : [],
    previousLines: lastSent,
  }));
}

async function draftAnswer(
  client: any,
  draft: any,
  order: any,
  job: DispatchOrderJob,
  ctx: DispatchOrdersContext,
) {
  const contact = await readContact(client, String(draft.supplier_id), ctx);
  const lastSent = (await readLastSentLines(client, [String(order.id)])).get(
    String(order.id),
  ) ?? null;
  return await projectDispatchDraft({
    draft,
    order,
    supplier: contact,
    nowMs: nowMs(ctx),
    currentGeneratedSha: await generatedShaFor(draft, order, job, lastSent),
  });
}

// ── The two reads ───────────────────────────────────────────────────────────

export async function readDispatchOrderEmails(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(
    client,
    params.get("job_id") ?? params.get("jobId"),
    ctx,
  );
  const ordersRes = await readJobOrders(client, job.id, ctx);
  if (ordersRes.error) readFailed("orders read", ordersRes.error);
  const orders = ordersRes.data;
  const ordersById = new Map(orders.map((o) => [String(o.id), o]));

  const [draftsRes, comms] = await Promise.all([
    client.from("job_order_emails")
      .select(DRAFT_SELECT)
      .eq("job_id", job.id)
      .eq("org_id", ctx.orgId)
      .in("status", OPEN_DRAFT_STATUSES)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
    readJobCommunications(client, job.id, orders.map((o) => String(o.id))),
  ]);
  // A failed drafts read is a failed read: never "no drafts".
  if (draftsRes.error) readFailed("drafts read", draftsRes.error);
  const draftRows: any[] = draftsRes.data || [];
  const contacts = await readContacts(
    client,
    draftRows.map((d) => String(d.supplier_id)),
    ctx,
  );
  const lastSent = await readLastSentLines(
    client,
    draftRows.filter((d) => d.kind === "update").map((d) =>
      String(d.purchase_order_id)
    ),
  );
  const drafts = [];
  for (const draft of draftRows) {
    const order = ordersById.get(String(draft.purchase_order_id)) || {};
    drafts.push(
      await projectDispatchDraft({
        draft,
        order,
        supplier: contacts.get(String(draft.supplier_id)) || null,
        nowMs: nowMs(ctx),
        currentGeneratedSha: order.po_number
          ? await generatedShaFor(
            draft,
            order,
            job,
            lastSent.get(String(draft.purchase_order_id)) ?? null,
          )
          : null,
      }),
    );
  }

  const answer: Record<string, unknown> = {
    job_id: job.id,
    job_number: job.job_number,
    drafts,
    orders_for_link: orders
      .filter((o) => o.status !== "cancelled")
      .map((o) => ({
        id: o.id,
        po_number: o.po_number ?? null,
        supplier_name: o.supplier_name ?? null,
      })),
  };
  // The job's open orders made outside Dispatch (the office "Create PO"
  // press, the quote builder, Xero), shown before a send so the same
  // materials are not ordered twice. Advisory only: it never blocks a send,
  // carries no price, and a failed read says so rather than "none".
  const others = await readOtherSupplierOrders(client, job.id, ctx);
  if (others.error) {
    answer.other_open_orders_status = "failed";
  } else {
    const found = otherOpenSupplierOrders(others.data);
    answer.other_open_orders = found.orders;
    answer.other_open_orders_note = found.note;
    answer.other_open_orders_status = "ok";
  }
  // Only the threads failed: the drafts still show.
  if (comms.error) {
    answer.threads_status = "failed";
  } else {
    answer.threads = dispatchGroupThreads(comms.rows, {
      orders: orderLookup(orders),
    }).map(publicThread);
    answer.threads_status = "ok";
  }
  return answer;
}

// An older version's file: the path a draft of that version recorded (a
// version written beside a clash carries a suffix), else the plain path.
async function olderPdfPath(
  client: any,
  order: any,
  jobId: string,
  version: number,
) {
  const { data, error } = await client.from("job_order_emails")
    .select("pdf_path, pdf_version")
    .eq("purchase_order_id", order.id)
    .eq("pdf_version", version)
    .limit(1);
  if (error) readFailed("pdf version read", error);
  return (data || [])[0]?.pdf_path ||
    dispatchOrderPdfPath(jobId, order.po_number, version);
}

export async function readDispatchOrderPdf(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchOrdersContext,
) {
  const orderId = requireUuid(
    params.get("purchase_order_id"),
    "purchase_order_id",
  );
  const versionRaw = params.get("version");
  let version: number | null = null;
  if (versionRaw !== null && versionRaw !== "") {
    version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) {
      badRequest("version must be a whole number 1 or more");
    }
  }
  const order = await readOrder(client, orderId, ctx);
  if (!order.job_id) refuse(404, "order_not_found", "Order not found");
  const job = await loadJob(client, order.job_id, ctx);
  const newest = Number(order.pdf_version ?? 0);
  if (!order.pdf_path || newest < 1) {
    refuse(404, "pdf_not_found", "This order has no PDF on file");
  }
  const wanted = version ?? newest;
  if (wanted > newest) {
    refuse(404, "pdf_not_found", "That PDF version does not exist");
  }
  const path = wanted === newest
    ? order.pdf_path
    : await olderPdfPath(client, order, job.id, wanted);
  const { data, error } = await client.storage.from(DISPATCH_ORDER_PDF_BUCKET)
    .createSignedUrl(path, DISPATCH_ORDER_PDF_LINK_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("[dispatch_orders] pdf link failed:", error);
    refuse(404, "pdf_not_found", "That PDF could not be found");
  }
  return {
    url: data.signedUrl,
    file_name: dispatchPdfFileName(order.po_number),
    version: wanted,
    expires_in: DISPATCH_ORDER_PDF_LINK_SECONDS,
  };
}

// ── PDF upload ──────────────────────────────────────────────────────────────

function storageExists(error: any): boolean {
  const text = `${error?.statusCode ?? ""} ${error?.status ?? ""} ${
    error?.message ?? ""
  } ${error?.error ?? ""}`;
  return /409|already exists|Duplicate/i.test(text);
}

async function uploadPdf(client: any, path: string, bytes: Uint8Array) {
  return await client.storage.from(DISPATCH_ORDER_PDF_BUCKET).upload(
    path,
    bytes,
    {
      contentType: "application/pdf",
      upsert: false,
    },
  );
}

async function removePdf(client: any, path: string) {
  try {
    const { error } = await client.storage.from(DISPATCH_ORDER_PDF_BUCKET)
      .remove([path]);
    if (error) console.error("[dispatch_orders] pdf cleanup failed:", error);
  } catch (error) {
    console.error("[dispatch_orders] pdf cleanup failed:", error);
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createDispatchOrder(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(client, body?.job_id ?? body?.jobId, ctx);
  const supplierId = requireUuid(body?.supplier_id, "supplier_id");
  const stamps = lineStamps(body?.lines, "lines");

  const contact = await readContact(client, supplierId, ctx);
  if (!contact) refuse(404, "supplier_not_found", "Supplier contact not found");
  const { data: chosen, error: chosenError } = await client.from(
    "job_material_suppliers",
  )
    .select("supplier_id")
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (chosenError) readFailed("chosen supplier read", chosenError);
  if (!chosen) {
    refuse(
      409,
      "supplier_not_on_job",
      "That supplier is not chosen for this job",
    );
  }

  const ordersRes = await readJobOrders(client, job.id, ctx);
  if (ordersRes.error) readFailed("orders read", ordersRes.error);
  const open = ordersRes.data.find((o) =>
    o.source === "dispatch" && String(o.supplier_id) === supplierId &&
    o.status !== "cancelled" && !o.xero_po_id
  );
  if (open) {
    refuse(
      409,
      "order_open",
      "This supplier already has an open order on this job",
      {
        order: { id: open.id, po_number: open.po_number },
      },
    );
  }

  const stored = await readSupplierLines(client, job.id, supplierId);
  const orderable = dispatchOrderableLines(stored, supplierId);
  if (orderable.length === 0) {
    refuse(
      409,
      "no_lines_to_order",
      "There is no To order line for this supplier",
    );
  }
  if (!dispatchSameLineSet(stamps, orderable)) {
    refuse(
      409,
      "lines_changed",
      "This changed somewhere else. Showing the latest.",
      {
        lines: orderable.map(projectLine),
      },
    );
  }

  const { data: poNumber, error: numberError } = await client.rpc(
    "dispatch_next_po_number",
  );
  if (numberError || typeof poNumber !== "string" || !poNumber) {
    writeFailed("order number", numberError);
  }

  const lines = dispatchOrderLines(orderable);
  const now = nowIso(ctx);
  const pdf = await (ctx.renderPdf ?? renderDispatchOrderPdf)({
    poNumber,
    version: 1,
    orderedAt: now,
    jobNumber: job.job_number,
    supplierName: contact.name,
    deliverTo: dispatchDeliverTo(job.site_address, job.site_suburb),
    lines,
  });
  if (pdf.lineCount !== lines.length) {
    writeFailed("pdf line count", { pdf: pdf.lineCount, lines: lines.length });
  }
  const path = dispatchOrderPdfPath(job.id, poNumber, 1);
  const { error: uploadError } = await uploadPdf(client, path, pdf.bytes);
  if (uploadError) writeFailed("pdf upload", uploadError);

  const subject = dispatchOrderSubject("order", poNumber, job.job_number);
  const bodyText = dispatchOrderBody({
    kind: "order",
    poNumber,
    jobNumber: job.job_number,
    suburb: job.site_suburb,
    lines,
  });
  const { data: committed, error: commitError } = await client.rpc(
    "dispatch_commit_order",
    {
      p: {
        job_id: job.id,
        org_id: job.org_id,
        supplier_id: supplierId,
        supplier_name: contact.name,
        po_number: poNumber,
        reference: job.job_number,
        line_items: lines,
        lines: stamps,
        pdf: { path, sha256: pdf.sha256, version: 1 },
        actor: { user_id: ctx.actor.userId, email: ctx.actor.email },
        draft: {
          subject,
          body_text: bodyText,
          body_generated_sha: await sha256Hex(bodyText),
        },
      },
    },
  );
  if (commitError) {
    await removePdf(client, path);
    const known = commitRefusal(commitError);
    if (known) {
      const latest = await readSupplierLines(client, job.id, supplierId);
      refuse(known[1], known[0], known[2], { lines: latest.map(projectLine) });
    }
    writeFailed("order commit", commitError);
  }
  const order = committed?.order;
  const draft = committed?.draft;
  const latestLines = await readSupplierLines(client, job.id, supplierId);
  return {
    success: true,
    order: projectOrder(order, [draft], [], ctx),
    draft: await draftAnswer(client, draft, order, job, ctx),
    lines: latestLines.map(projectLine),
    counts: await readJobCounts(client, job.id),
  };
}

// ── Update ──────────────────────────────────────────────────────────────────

function checkOrderOnJob(order: any, job: DispatchOrderJob) {
  if (String(order.job_id) !== job.id) {
    refuse(404, "order_not_found", "Order not found on this job");
  }
  if (order.source !== "dispatch") {
    refuse(409, "not_dispatch_order", "This order was not made in Dispatch");
  }
}

function orderChanged(order: any): never {
  refuse(409, "order_changed", "This order changed somewhere else", {
    order: {
      id: order.id,
      po_number: order.po_number,
      updated_at: order.updated_at,
    },
  });
}

export async function updateDispatchOrder(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(client, body?.job_id ?? body?.jobId, ctx);
  const orderId = requireUuid(body?.purchase_order_id, "purchase_order_id");
  const expected = requireStamp(
    body?.expected_order_updated_at,
    "expected_order_updated_at",
  );
  const stamps = lineStamps(body?.lines ?? [], "lines");
  const removeRaw = body?.remove_line_ids ?? [];
  if (!Array.isArray(removeRaw)) badRequest("remove_line_ids must be a list");
  const removeIds = [
    ...new Set(
      (removeRaw as unknown[]).map((id, i) =>
        requireUuid(id, `remove_line_ids[${i}]`)
      ),
    ),
  ];

  const order = await readOrder(client, orderId, ctx);
  checkOrderOnJob(order, job);
  if (order.status === "cancelled") {
    refuse(409, "order_cancelled", "This order is cancelled");
  }
  if (order.xero_po_id) {
    refuse(
      409,
      "order_in_xero",
      "This order is in Xero; Xero holds its own copy, so it is not changed here",
    );
  }
  if (!sameInstant(expected, order.updated_at)) orderChanged(order);

  const openDraft = await readOpenDraft(client, order.id);
  if (openDraft && openDraft.status !== "draft") {
    refuse(
      409,
      "draft_sending",
      "This order's email is being sent or its send is not confirmed",
    );
  }

  const supplierId = String(order.supplier_id);
  const stored = await readSupplierLines(client, job.id, supplierId);
  const onOrder = stored.filter((l) =>
    String(l.purchase_order_id) === order.id
  );
  const orderable = dispatchOrderableLines(stored, supplierId);
  const latestLines = () => ({ lines: stored.map(projectLine) });
  const onOrderIds = new Set(onOrder.map((l) => String(l.id)));
  if (removeIds.some((id) => !onOrderIds.has(id))) {
    refuse(
      409,
      "lines_changed",
      "This changed somewhere else. Showing the latest.",
      latestLines(),
    );
  }
  if (!dispatchSameLineSet(stamps, orderable)) {
    refuse(
      409,
      "lines_changed",
      "This changed somewhere else. Showing the latest.",
      latestLines(),
    );
  }
  const removeSet = new Set(removeIds);
  const keep = onOrder.filter((l) => !removeSet.has(String(l.id)));
  const remove = onOrder.filter((l) => removeSet.has(String(l.id)));
  const add = orderable;
  if (add.length === 0 && remove.length === 0) {
    return {
      success: true,
      unchanged: true,
      order: projectOrder(order, openDraft ? [openDraft] : [], [], ctx),
      lines: stored.map(projectLine),
      counts: await readJobCounts(client, job.id),
    };
  }
  if (keep.length + add.length === 0) {
    refuse(
      409,
      "order_would_be_empty",
      "Every line would come off. Cancel the order instead, if it was never sent.",
    );
  }

  const lines = dispatchOrderLines([...keep, ...add]);
  const version = Number(order.pdf_version ?? 0) + 1;
  const contact = await readContact(client, supplierId, ctx);
  const pdf = await (ctx.renderPdf ?? renderDispatchOrderPdf)({
    poNumber: order.po_number,
    version,
    orderedAt: order.created_at,
    jobNumber: job.job_number,
    supplierName: contact?.name || order.supplier_name,
    deliverTo: dispatchDeliverTo(job.site_address, job.site_suburb),
    lines,
  });
  let path = dispatchOrderPdfPath(job.id, order.po_number, version);
  let upload = await uploadPdf(client, path, pdf.bytes);
  // That version's file is already there: another update is in flight, or one
  // whose commit failed left it. Never touch it (it may be about to become the
  // order's); write ours beside it. The commit decides which one the order
  // names, and the loser's file is removed below.
  if (upload.error && storageExists(upload.error)) {
    path = dispatchOrderPdfPath(
      job.id,
      order.po_number,
      version,
      crypto.randomUUID().slice(0, 8),
    );
    upload = await uploadPdf(client, path, pdf.bytes);
  }
  if (upload.error) writeFailed("pdf upload", upload.error);

  const lastSent =
    (await readLastSentLines(client, [order.id])).get(order.id) ?? null;
  const plan = await dispatchUpdateDraftPlan({
    openDraft,
    order,
    jobNumber: job.job_number,
    suburb: job.site_suburb,
    lines,
    lastSentLines: lastSent,
  });
  const stamp = (rows: any[]) =>
    rows.map((l) => ({ id: l.id, updated_at: l.updated_at }));
  const { data: committed, error: commitError } = await client.rpc(
    "dispatch_commit_order_update",
    {
      p: {
        mode: "update",
        order_id: order.id,
        job_id: job.id,
        expected_order_updated_at: order.updated_at,
        line_items: lines,
        pdf: { path, sha256: pdf.sha256, version },
        keep: stamp(keep),
        add: stamp(add),
        remove: stamp(remove),
        actor: { user_id: ctx.actor.userId, email: ctx.actor.email },
        ...(plan.kind === "refresh"
          ? {
            draft_update: {
              id: plan.draft_id,
              expected_updated_at: plan.expected_updated_at,
              fields: plan.fields,
            },
          }
          : { draft_insert: plan.fields }),
      },
    },
  );
  if (commitError) {
    await removePdf(client, path);
    const known = commitRefusal(commitError);
    if (known) {
      const latest = await readSupplierLines(client, job.id, supplierId);
      refuse(known[1], known[0], known[2], { lines: latest.map(projectLine) });
    }
    writeFailed("order update commit", commitError);
  }
  const newOrder = committed?.order;
  const draft = committed?.draft;
  const latest = await readSupplierLines(client, job.id, supplierId);
  return {
    success: true,
    order: projectOrder(newOrder, [draft], [], ctx),
    draft: await draftAnswer(client, draft, newOrder, job, ctx),
    body_kept: plan.kind === "refresh" ? plan.body_kept : false,
    lines: latest.map(projectLine),
    counts: await readJobCounts(client, job.id),
  };
}

// ── Cancel ──────────────────────────────────────────────────────────────────

export async function cancelDispatchOrder(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(client, body?.job_id ?? body?.jobId, ctx);
  const orderId = requireUuid(body?.purchase_order_id, "purchase_order_id");
  const expected = requireStamp(
    body?.expected_order_updated_at,
    "expected_order_updated_at",
  );
  const order = await readOrder(client, orderId, ctx);
  checkOrderOnJob(order, job);
  if (order.status === "cancelled") {
    refuse(409, "order_cancelled", "This order is already cancelled");
  }
  if (order.last_sent_at) {
    refuse(
      409,
      "order_sent",
      "This order was sent. Tell the supplier by replying on its thread.",
    );
  }
  if (order.xero_po_id) {
    refuse(
      409,
      "order_in_xero",
      "This order is in Xero and is not cancelled here",
    );
  }
  if (!sameInstant(expected, order.updated_at)) orderChanged(order);

  const { data: committed, error } = await client.rpc(
    "dispatch_commit_order_update",
    {
      p: {
        mode: "cancel",
        order_id: order.id,
        job_id: job.id,
        expected_order_updated_at: order.updated_at,
        actor: { user_id: ctx.actor.userId, email: ctx.actor.email },
      },
    },
  );
  if (error) {
    const known = commitRefusal(error);
    if (known) refuse(known[1], known[0], known[2]);
    writeFailed("order cancel", error);
  }
  const latest = await readSupplierLines(
    client,
    job.id,
    String(order.supplier_id),
  );
  return {
    success: true,
    order: {
      id: order.id,
      po_number: order.po_number,
      status: committed?.order?.status ?? "cancelled",
    },
    lines: latest.map(projectLine),
    counts: await readJobCounts(client, job.id),
  };
}

// ── Draft save and discard ──────────────────────────────────────────────────

async function draftWithJob(
  client: any,
  draftId: unknown,
  ctx: DispatchOrdersContext,
) {
  const id = requireUuid(draftId, "draft_id");
  const draft = await readDraft(client, id, ctx);
  const job = await loadJob(client, draft.job_id, ctx);
  const order = await readOrder(client, String(draft.purchase_order_id), ctx);
  return { draft, job, order };
}

function draftChanged(projected: any): never {
  refuse(409, "draft_changed", "This draft changed. Showing the latest.", {
    draft: projected,
  });
}

export async function saveDispatchOrderDraft(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const expected = requireStamp(
    body?.expected_updated_at,
    "expected_updated_at",
  );
  const hasSubject = body &&
    Object.prototype.hasOwnProperty.call(body, "subject");
  const hasBody = body &&
    Object.prototype.hasOwnProperty.call(body, "body_text");
  if (!hasSubject && !hasBody) badRequest("send subject, body_text or both");
  const patch: Record<string, unknown> = {};
  if (hasSubject) {
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    if (subject.length < 1 || subject.length > DISPATCH_DRAFT_SUBJECT_MAX) {
      badRequest(
        `subject must be 1 to ${DISPATCH_DRAFT_SUBJECT_MAX} characters`,
      );
    }
    patch.subject = subject;
  }
  if (hasBody) {
    const text = typeof body.body_text === "string" ? body.body_text : "";
    if (!text.trim() || text.length > DISPATCH_DRAFT_BODY_MAX) {
      badRequest(
        `body_text must be 1 to ${DISPATCH_DRAFT_BODY_MAX} characters`,
      );
    }
    patch.body_text = text;
  }
  const { draft, job, order } = await draftWithJob(client, body?.draft_id, ctx);
  if (draft.status !== "draft") {
    refuse(409, "draft_not_editable", "This draft can no longer be changed");
  }
  if (!sameInstant(expected, draft.updated_at)) {
    draftChanged(await draftAnswer(client, draft, order, job, ctx));
  }
  patch.updated_at = nowIso(ctx);
  const { data, error } = await client.from("job_order_emails")
    .update(patch)
    .eq("id", draft.id)
    .eq("status", "draft")
    .eq("updated_at", draft.updated_at)
    .select(DRAFT_SELECT);
  if (error) writeFailed("draft save", error);
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved) {
    const latest = await readDraft(client, draft.id, ctx);
    if (latest.status !== "draft") {
      refuse(409, "draft_not_editable", "This draft can no longer be changed");
    }
    draftChanged(await draftAnswer(client, latest, order, job, ctx));
  }
  return {
    success: true,
    draft: await draftAnswer(client, saved, order, job, ctx),
  };
}

export async function discardDispatchOrderDraft(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const expected = requireStamp(
    body?.expected_updated_at,
    "expected_updated_at",
  );
  const { draft, job, order } = await draftWithJob(client, body?.draft_id, ctx);
  if (draft.status !== "draft") {
    refuse(409, "draft_not_editable", "This draft can no longer be discarded");
  }
  if (!sameInstant(expected, draft.updated_at)) {
    draftChanged(await draftAnswer(client, draft, order, job, ctx));
  }
  const now = nowIso(ctx);
  const { data, error } = await client.from("job_order_emails")
    .update({
      status: "discarded",
      discarded_at: now,
      discarded_by_email: ctx.actor.email,
      updated_at: now,
    })
    .eq("id", draft.id)
    .eq("status", "draft")
    .eq("updated_at", draft.updated_at)
    .select("id, status");
  if (error) writeFailed("draft discard", error);
  if (!Array.isArray(data) || data.length === 0) {
    const latest = await readDraft(client, draft.id, ctx);
    if (latest.status !== "draft") {
      refuse(
        409,
        "draft_not_editable",
        "This draft can no longer be discarded",
      );
    }
    draftChanged(await draftAnswer(client, latest, order, job, ctx));
  }
  // The order and its lines are not touched.
  return {
    success: true,
    draft: { id: draft.id, status: "discarded" },
    order: projectOrder(order, [], [], ctx),
  };
}

export async function releaseUnknownDispatchSend(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const expected = requireStamp(
    body?.expected_updated_at,
    "expected_updated_at",
  );
  const { draft, job, order } = await draftWithJob(client, body?.draft_id, ctx);
  if (draft.status !== "send_unknown" && !isStaleSending(draft, nowMs(ctx))) {
    refuse(
      409,
      "draft_not_unknown",
      "Only a send that was not confirmed can be released",
    );
  }
  if (!sameInstant(expected, draft.updated_at)) {
    draftChanged(await draftAnswer(client, draft, order, job, ctx));
  }
  const person = await resolveSender(client, body, ctx);
  // The release and its job_events row are one transaction: a failed audit
  // write leaves the draft locked as it was, so the person's retry still works.
  const { data, error } = await client.rpc("dispatch_release_unknown_send", {
    p: {
      draft_id: draft.id,
      job_id: job.id,
      prior_status: draft.status,
      prior_updated_at: draft.updated_at,
      actor: { user_id: person.userId, email: person.email },
      via: ctx.via,
    },
  });
  if (error) {
    const word = String(error?.message ?? "").trim();
    if (word === "draft_changed" || word === "draft_not_unknown") {
      draftChanged(
        await draftAnswer(
          client,
          await readDraft(client, draft.id, ctx),
          order,
          job,
          ctx,
        ),
      );
    }
    writeFailed("draft release", error);
  }
  const released = data?.draft;
  if (!released) writeFailed("draft release", { message: "no draft returned" });
  return {
    success: true,
    draft: await draftAnswer(client, released, order, job, ctx),
  };
}

// ── Send ────────────────────────────────────────────────────────────────────

async function downloadPdf(
  client: any,
  path: string,
): Promise<Uint8Array | null> {
  try {
    const { data, error } = await client.storage.from(DISPATCH_ORDER_PDF_BUCKET)
      .download(path);
    if (error || !data) {
      console.error("[dispatch_orders] pdf download failed:", error);
      return null;
    }
    return new Uint8Array(await data.arrayBuffer());
  } catch (error) {
    console.error("[dispatch_orders] pdf download failed:", error);
    return null;
  }
}

function logWrite(label: string, error: any): boolean {
  if (error) {
    console.error(
      `[dispatch_orders] after a send that went, ${label} failed:`,
      error,
    );
    return false;
  }
  return true;
}

// Writes after a 2xx. The email went: each write reads its error, logs it and
// carries on; the answer says filed:false when any failed.
async function fileSentEmail(client: any, input: {
  job: DispatchOrderJob;
  poId: string | null;
  poNumber: string | null;
  supplierId: string | null;
  draftId: string | null;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: any[];
  resendId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  sentAt: string;
  sender: { userId: string | null; email: string };
  via: "screen" | "terminal";
  extraMeta?: Record<string, unknown>;
}) {
  let filed = true;
  const { data: comm, error: commError } = await client.from(
    "po_communications",
  )
    .insert({
      po_id: input.poId,
      job_id: input.job.id,
      communication_type: "purchase_order",
      direction: "outbound",
      from_email: DISPATCH_ORDERS_ADDRESS,
      to_email: input.to,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml,
      attachments_json: input.attachments,
      sent_at: input.sentAt,
      message_id: input.resendId,
      in_reply_to: input.inReplyTo,
      thread_id: input.threadId || input.resendId,
      delivery_status: "sent",
      created_by: input.sender.userId,
    })
    .select("id")
    .single();
  filed = logWrite("po_communications insert", commError) && filed;
  const communicationId = comm?.id ?? null;

  const { data: emailEvent, error: eventError } = await client.from(
    "email_events",
  )
    .insert({
      email_type: "po",
      entity_type: "purchase_order",
      entity_id: input.poId,
      job_id: input.job.id,
      recipient: input.to,
      sender: DISPATCH_ORDERS_ADDRESS,
      subject: input.subject,
      resend_message_id: input.resendId,
      status: "sent",
      sent_at: input.sentAt,
      comms_channel: "email",
      metadata: {
        po_number: input.poNumber,
        supplier_id: input.supplierId,
        draft_id: input.draftId,
        communication_id: communicationId,
        source: "dispatch",
        via: input.via,
        sent_by_email: input.sender.email,
        ...(input.extraMeta || {}),
      },
    })
    .select("id")
    .single();
  filed = logWrite("email_events insert", eventError) && filed;

  const { error: jobEventError } = await client.from("job_events").insert({
    job_id: input.job.id,
    user_id: input.sender.userId,
    event_type: "po_email_sent",
    detail_json: {
      po_id: input.poId,
      po_number: input.poNumber,
      to_email: input.to,
      subject: input.subject,
      communication_id: communicationId,
      email_event_id: emailEvent?.id ?? null,
      resend_id: input.resendId,
      dry_run: false,
      draft_id: input.draftId,
      operator_email: input.sender.email,
      via: input.via,
      source: "dispatch",
    },
  });
  filed = logWrite("job_events insert", jobEventError) && filed;
  return { filed, communicationId };
}

// The order's thread: the thread_id its messages already carry, and the
// Message-ID of a supplier's reply on it, if one is on record.
async function readOrderThread(client: any, orderId: string) {
  const { data, error } = await client.from("po_communications")
    .select(
      "id, direction, message_id, thread_id, sent_at, received_at, created_at",
    )
    .eq("po_id", orderId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[dispatch_orders] order thread read failed:", error);
    return { threadId: null, inReplyTo: null };
  }
  const rows: any[] = data || [];
  const threadId = rows.find((r) => r.thread_id)?.thread_id ?? null;
  const inbound = rows.filter((r) => r.direction === "inbound" && r.message_id);
  return {
    threadId,
    inReplyTo: inbound.length > 0
      ? inbound[inbound.length - 1].message_id
      : null,
  };
}

export async function sendDispatchOrderDraft(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const expectedHash = typeof body?.expected_draft_hash === "string"
    ? body.expected_draft_hash
    : "";
  if (!expectedHash) badRequest("expected_draft_hash required");
  const { draft, job, order } = await draftWithJob(client, body?.draft_id, ctx);

  // A draft, or a send whose result is unknown (a person's retry, with the
  // same idempotency key), or a claim left with no answer.
  const retryable = draft.status === "send_unknown" ||
    isStaleSending(draft, nowMs(ctx));
  if (draft.status !== "draft" && !retryable) {
    refuse(409, "draft_not_sendable", "This draft is not waiting to be sent");
  }
  const contact = await readContact(client, String(draft.supplier_id), ctx);
  const projected = await projectDispatchDraft({
    draft,
    order,
    supplier: contact,
    nowMs: nowMs(ctx),
    currentGeneratedSha: null,
  });
  if (projected.draft_hash !== expectedHash) {
    draftChanged(await draftAnswer(client, draft, order, job, ctx));
  }
  if (projected.to.state !== "ok") {
    refuse(
      409,
      `supplier_email_${projected.to.state}`,
      "There is no usable email on file for this supplier",
      {
        to: projected.to,
      },
    );
  }
  if (order.status === "cancelled") {
    refuse(409, "order_cancelled", "This order is cancelled");
  }
  const sender = await resolveSender(client, body, ctx);
  const to = projected.to.email as string;

  // What this attempt carries. A first attempt fixes its address and threading
  // header on the claim; a retry after an unknown result reuses exactly those,
  // so the same idempotency key always goes with the same request (a reply
  // that landed in between, or a contact changed, cannot alter it).
  const thread = await readOrderThread(client, order.id);
  const firstAttempt = draft.status === "draft";
  const attemptInReplyTo = firstAttempt
    ? (draft.kind === "update" ? thread.inReplyTo : null)
    : (draft.attempt_in_reply_to ?? null);
  const attempt = Number(draft.send_attempt) || 1;

  // The claim: only one press, tab or terminal gets past this line.
  const claimedAt = nowIso(ctx);
  const { data: claimed, error: claimError } = await client.from(
    "job_order_emails",
  )
    .update({
      status: "sending",
      updated_at: claimedAt,
      last_error: null,
      ...(firstAttempt
        ? { attempt_to_email: to, attempt_in_reply_to: attemptInReplyTo }
        : {}),
    })
    .eq("id", draft.id)
    .eq("status", draft.status)
    .eq("updated_at", draft.updated_at)
    .select("id");
  if (claimError) writeFailed("draft claim", claimError);
  if (!Array.isArray(claimed) || claimed.length === 0) {
    refuse(409, "draft_not_sendable", "This draft is already being sent");
  }
  const priorStatus = draft.status === "draft" ? "draft" : "send_unknown";
  // Back to `draft` means this attempt is over and nothing went: its fixed
  // address and header are cleared, and after a refusal (`nextAttempt`) the
  // next press gets a new key.
  const release = async (
    status: string,
    lastError: string,
    nextAttempt = false,
  ) => {
    const { error } = await client.from("job_order_emails")
      .update({
        status,
        last_error: lastError.slice(0, 1000),
        updated_at: nowIso(ctx),
        ...(status === "draft"
          ? {
            attempt_to_email: null,
            attempt_in_reply_to: null,
            ...(nextAttempt ? { send_attempt: attempt + 1 } : {}),
          }
          : {}),
      })
      .eq("id", draft.id)
      .eq("status", "sending");
    if (error) console.error("[dispatch_orders] draft release failed:", error);
  };

  const { data: current, error: orderReadError } = await client.from(
    "purchase_orders",
  )
    .select("id, status")
    .eq("id", order.id)
    .maybeSingle();
  if (orderReadError) {
    await release(priorStatus, "The order could not be read before sending");
    readFailed("order read", orderReadError);
  }
  if (
    !current || current.status === "cancelled" || current.status === "deleted"
  ) {
    await release(priorStatus, "The order was cancelled before sending");
    refuse(
      409,
      "order_cancelled",
      "This order is cancelled. Nothing was sent.",
    );
  }

  const bytes = await downloadPdf(client, draft.pdf_path);
  if (!bytes || await sha256Hex(bytes) !== draft.pdf_sha256) {
    await release(
      priorStatus,
      "The PDF on file is not the one this draft was made with",
    );
    refuse(
      409,
      "pdf_changed",
      "The PDF on file is not the one this draft was made with. Nothing was sent.",
    );
  }

  const fileName = dispatchPdfFileName(order.po_number);
  const payload = buildDispatchEmail({
    to,
    subject: draft.subject,
    bodyText: draft.body_text,
    poNumber: order.po_number,
    jobNumber: job.job_number,
    pdf: { fileName, base64: dispatchBytesToBase64(bytes) },
    inReplyTo: attemptInReplyTo,
  });
  const outcome = await runDispatchSend(ctx.transport, {
    payload,
    idempotencyKey: dispatchDraftIdempotencyKey(draft.id, attempt),
  });

  if (outcome.kind === "refused" && firstAttempt) {
    await release("draft", outcome.reason, true);
    refuse(502, "send_refused", `Not sent: ${outcome.reason}`, {
      reason: outcome.reason,
    });
  }
  if (outcome.kind !== "sent") {
    await release("send_unknown", outcome.reason);
    refuse(
      502,
      "send_unknown",
      "We could not tell whether this email went. Check the thread before trying again.",
      {
        reason: outcome.reason,
      },
    );
  }

  const sentAt = nowIso(ctx);
  const filedResult = await fileSentEmail(client, {
    job,
    poId: order.id,
    poNumber: order.po_number,
    supplierId: String(draft.supplier_id),
    draftId: draft.id,
    to,
    subject: draft.subject,
    bodyText: draft.body_text,
    bodyHtml: payload.html,
    attachments: [{
      file_name: fileName,
      storage_bucket: DISPATCH_ORDER_PDF_BUCKET,
      storage_path: draft.pdf_path,
      sha256: draft.pdf_sha256,
      content_type: "application/pdf",
    }],
    resendId: outcome.id,
    threadId: thread.threadId,
    inReplyTo: payload.headers?.["In-Reply-To"] ?? null,
    sentAt,
    sender,
    via: ctx.via,
  });
  let filed = filedResult.filed;

  const { error: draftError } = await client.from("job_order_emails")
    .update({
      status: "sent",
      to_email_sent: to,
      communication_id: filedResult.communicationId,
      resend_id: outcome.id,
      sent_at: sentAt,
      sent_by: sender.userId,
      sent_by_email: sender.email,
      sent_via: ctx.via,
      last_error: null,
      updated_at: sentAt,
    })
    .eq("id", draft.id);
  filed = logWrite("draft update to sent", draftError) && filed;

  const orderPatch: Record<string, unknown> = {
    last_sent_pdf_version: draft.pdf_version,
    last_sent_at: sentAt,
  };
  if (order.status === "draft") orderPatch.status = "sent";
  const { data: orderRows, error: orderError } = await client.from(
    "purchase_orders",
  )
    .update(orderPatch)
    .eq("id", order.id)
    .select(ORDER_SELECT);
  filed = logWrite("order update", orderError) && filed;
  const newOrder = (Array.isArray(orderRows) ? orderRows[0] : orderRows) ||
    { ...order, ...orderPatch };

  return {
    success: true,
    filed,
    resend_id: outcome.id,
    communication_id: filedResult.communicationId,
    draft: {
      id: draft.id,
      status: "sent",
      to_email_sent: to,
      sent_at: sentAt,
      sent_by_email: sender.email,
    },
    order: projectOrder(newOrder, [], [{
      po_id: order.id,
      direction: "outbound",
      sent_at: sentAt,
      id: filedResult.communicationId,
    }], ctx),
  };
}

// ── Reply ───────────────────────────────────────────────────────────────────

async function loadJobThreads(
  client: any,
  job: DispatchOrderJob,
  ctx: DispatchOrdersContext,
) {
  const ordersRes = await readJobOrders(client, job.id, ctx);
  if (ordersRes.error) readFailed("orders read", ordersRes.error);
  const comms = await readJobCommunications(
    client,
    job.id,
    ordersRes.data.map((o) => String(o.id)),
  );
  if (comms.error) readFailed("email threads read", comms.error);
  return {
    orders: ordersRes.data,
    threads: dispatchGroupThreads(comms.rows, {
      orders: orderLookup(ordersRes.data),
    }),
  };
}

function findThread(threads: any[], key: unknown) {
  if (typeof key !== "string" || !key) badRequest("thread_key required");
  const thread = threads.find((t) => t.key === key);
  if (!thread) {
    refuse(404, "thread_not_found", "That email thread is not on this job");
  }
  return thread;
}

export async function replyDispatchThread(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(client, body?.job_id ?? body?.jobId, ctx);
  const replyToId = requireUuid(
    body?.reply_to_message_id,
    "reply_to_message_id",
  );
  const text = typeof body?.body_text === "string" ? body.body_text : "";
  if (!text.trim() || text.length > DISPATCH_DRAFT_BODY_MAX) {
    badRequest(`body_text must be 1 to ${DISPATCH_DRAFT_BODY_MAX} characters`);
  }
  const sender = await resolveSender(client, body, ctx);
  const { threads } = await loadJobThreads(client, job, ctx);
  const thread = findThread(threads, body?.thread_key);
  if (thread.tag !== "supplier") {
    refuse(
      409,
      "thread_not_supplier",
      "Only a supplier thread can be replied to here",
    );
  }
  const rows: any[] = thread._rows;
  const newest = rows[rows.length - 1];
  if (String(newest.id) !== replyToId) {
    refuse(
      409,
      "thread_changed",
      "A newer message is on this thread. Showing the latest.",
      {
        thread: publicThread(thread),
      },
    );
  }
  const inbound = rows.filter((r) => r.direction === "inbound");
  const newestInbound = inbound[inbound.length - 1];
  const address = dispatchAddressCheck(newestInbound?.from_email);
  if (!newestInbound || address.state !== "ok") {
    refuse(
      409,
      `supplier_email_${newestInbound ? address.state : "missing"}`,
      "There is no supplier address on this thread to reply to",
    );
  }
  const to = address.email as string;
  const bodySha = await sha256Hex(text);
  const idempotencyKey = dispatchReplyIdempotencyKey(replyToId, bodySha);

  // The same reply already went and was filed (a second press).
  const { data: already, error: alreadyError } = await client.from(
    "email_events",
  )
    .select("id")
    .eq("metadata->>idempotency_key", idempotencyKey)
    .limit(1);
  if (alreadyError) readFailed("reply check", alreadyError);
  if (Array.isArray(already) && already.length > 0) {
    return { success: true, unchanged: true, thread: publicThread(thread) };
  }

  const subject = dispatchReplySubject(thread.subject);
  const payload = buildDispatchEmail({
    to,
    subject,
    bodyText: text,
    poNumber: thread.po_number,
    jobNumber: job.job_number,
    pdf: null,
    inReplyTo: newest.message_id ?? null,
  });
  const outcome = await runDispatchSend(ctx.transport, {
    payload,
    idempotencyKey,
  });
  if (outcome.kind === "refused") {
    refuse(502, "send_refused", `Not sent: ${outcome.reason}`, {
      reason: outcome.reason,
    });
  }
  if (outcome.kind === "unknown") {
    refuse(
      502,
      "send_unknown",
      "We could not tell whether this reply went. Check the thread before trying again.",
      {
        reason: outcome.reason,
      },
    );
  }
  const sentAt = nowIso(ctx);
  const filedResult = await fileSentEmail(client, {
    job,
    poId: thread.po_id,
    poNumber: thread.po_number,
    supplierId: null,
    draftId: null,
    to,
    subject,
    bodyText: text,
    bodyHtml: payload.html,
    attachments: [],
    resendId: outcome.id,
    threadId: rows.find((r) => r.thread_id)?.thread_id ?? null,
    inReplyTo: payload.headers?.["In-Reply-To"] ?? null,
    sentAt,
    sender,
    via: ctx.via,
    extraMeta: {
      idempotency_key: idempotencyKey,
      thread_key: thread.key,
      reply_to_message_id: replyToId,
    },
  });
  return {
    success: true,
    filed: filedResult.filed,
    resend_id: outcome.id,
    communication_id: filedResult.communicationId,
  };
}

// ── Link to PO ──────────────────────────────────────────────────────────────

export async function linkDispatchThreadToOrder(
  client: any,
  body: any,
  ctx: DispatchOrdersContext,
) {
  const job = await loadJob(client, body?.job_id ?? body?.jobId, ctx);
  const orderId = requireUuid(body?.purchase_order_id, "purchase_order_id");
  const { orders, threads } = await loadJobThreads(client, job, ctx);
  const thread = findThread(threads, body?.thread_key);
  if (thread.tag !== "supplier") {
    refuse(
      409,
      "thread_not_supplier",
      "Only a supplier thread can be linked to an order",
    );
  }
  const rows: any[] = thread._rows;
  if (rows.some((r) => r.po_id)) {
    refuse(409, "thread_has_order", "This thread is already on an order");
  }
  const order = orders.find((o) =>
    String(o.id) === orderId && o.status !== "cancelled"
  );
  if (!order) refuse(409, "order_not_on_job", "That order is not on this job");
  const ids = rows.filter((r) => String(r.job_id) === job.id).map((r) =>
    String(r.id)
  );
  if (ids.length === 0) {
    refuse(409, "thread_has_order", "This thread has no message to link");
  }
  const { error } = await client.from("po_communications")
    .update({ po_id: order.id })
    .in("id", ids)
    .eq("job_id", job.id)
    .eq("communication_type", "purchase_order")
    .is("po_id", null);
  if (error) writeFailed("thread link", error);
  const after = await loadJobThreads(client, job, ctx);
  const linked = after.threads.find((t) =>
    t._rows.some((r: any) => ids.includes(String(r.id)))
  );
  return { success: true, thread: linked ? publicThread(linked) : null };
}

// ── One entry for the action switch ─────────────────────────────────────────

export async function runDispatchOrdersAction(
  client: any,
  action: string,
  params: { get(name: string): string | null },
  body: any,
  ctx: DispatchOrdersContext,
) {
  switch (action) {
    case "dispatch_order_emails":
      return await readDispatchOrderEmails(client, params, ctx);
    case "dispatch_order_pdf":
      return await readDispatchOrderPdf(client, params, ctx);
    case "dispatch_order_create":
      return await createDispatchOrder(client, body, ctx);
    case "dispatch_order_update":
      return await updateDispatchOrder(client, body, ctx);
    case "dispatch_order_cancel":
      return await cancelDispatchOrder(client, body, ctx);
    case "dispatch_order_draft_save":
      return await saveDispatchOrderDraft(client, body, ctx);
    case "dispatch_order_discard":
      return await discardDispatchOrderDraft(client, body, ctx);
    case "dispatch_order_release_unknown":
      return await releaseUnknownDispatchSend(client, body, ctx);
    case "dispatch_order_send":
      return await sendDispatchOrderDraft(client, body, ctx);
    case "dispatch_order_reply":
      return await replyDispatchThread(client, body, ctx);
    case "dispatch_email_link_po":
      return await linkDispatchThreadToOrder(client, body, ctx);
    default:
      refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
}
