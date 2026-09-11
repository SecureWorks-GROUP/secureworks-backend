// Books doors for Xero supplier bills (ACCPAY) and supplier credit notes.
//
// These never approve, void, or pay. Drafts stay DRAFT. There is no email/SMS
// chase and no ungated money movement. The live Israel draft
// 4fb56498-14a9-4204-989a-38a92b0d8ba5 is not rewritten by the trade generator;
// Books can only change a DRAFT it is explicitly asked to update.

import {
  attachPdfBase64ToXeroInvoice,
  hasXeroPdfBase64Payload,
  XeroPdfAttachError,
} from "./xero_attachment.ts";
import { xeroInvoiceRefOrNumberWhere } from "./xero_where_clause.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const ACCPAY_ACCOUNT_DEFAULT = "306";

export class SupplierBillError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "SUPPLIER_BILL_INVALID") {
    super(message);
    this.name = "SupplierBillError";
    this.status = status;
    this.code = code;
  }
}

export type AccpayStatusFilter = "DRAFT" | "AUTHORISED" | "PAID" | "SUBMITTED";

export type XeroGetFn = (
  path: string,
  accessToken: string,
  tenantId: string,
  params?: Record<string, string>,
) => Promise<any>;

export type XeroPostFn = (
  path: string,
  accessToken: string,
  tenantId: string,
  body: any,
  method?: string,
  idempotencyKey?: string,
) => Promise<any>;

export type GetTokenFn = (client: any) => Promise<{
  accessToken: string;
  tenantId: string;
}>;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXeroLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function mapSupplierBillStatusFilter(
  raw: unknown,
): AccpayStatusFilter | null {
  const text = String(raw || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!text) return null;
  if (text === "draft") return "DRAFT";
  if (
    text === "awaiting payment" || text === "authorised" || text === "authorized"
  ) {
    return "AUTHORISED";
  }
  if (text === "submitted") return "SUBMITTED";
  if (text === "paid") return "PAID";
  throw new SupplierBillError(
    "status must be draft, awaiting payment, submitted, or paid",
    400,
    "STATUS_INVALID",
  );
}

function requireDraftStatus(status: unknown, label: string): void {
  if (String(status || "DRAFT").toUpperCase() !== "DRAFT") {
    throw new SupplierBillError(
      `${label} must stay DRAFT — this door cannot approve, void, or pay`,
      409,
      "MUST_STAY_DRAFT",
    );
  }
}

function presentBill(inv: any) {
  const contact = inv?.Contact || {};
  return {
    xero_invoice_id: inv?.InvoiceID || null,
    invoice_number: inv?.InvoiceNumber || null,
    invoice_type: inv?.Type || null,
    status: inv?.Status || null,
    contact_name: contact.Name || null,
    xero_contact_id: contact.ContactID || null,
    reference: inv?.Reference || null,
    date: inv?.DateString || inv?.Date || null,
    due_date: inv?.DueDateString || inv?.DueDate || null,
    sub_total: inv?.SubTotal ?? null,
    total_tax: inv?.TotalTax ?? null,
    total: inv?.Total ?? null,
    amount_due: inv?.AmountDue ?? null,
    amount_paid: inv?.AmountPaid ?? null,
    has_attachments: inv?.HasAttachments === true,
    line_amount_types: inv?.LineAmountTypes || null,
    line_items: (inv?.LineItems || []).map((line: any) => ({
      description: line.Description || "",
      quantity: line.Quantity ?? 1,
      unit_amount: line.UnitAmount ?? 0,
      line_amount: line.LineAmount ?? null,
      account_code: line.AccountCode || null,
      tax_type: line.TaxType || null,
      tracking: line.Tracking || [],
    })),
  };
}

function presentCreditNote(note: any) {
  const contact = note?.Contact || {};
  return {
    xero_credit_note_id: note?.CreditNoteID || null,
    credit_note_number: note?.CreditNoteNumber || null,
    credit_note_type: note?.Type || null,
    status: note?.Status || null,
    contact_name: contact.Name || null,
    xero_contact_id: contact.ContactID || null,
    reference: note?.Reference || null,
    date: note?.DateString || note?.Date || null,
    sub_total: note?.SubTotal ?? null,
    total_tax: note?.TotalTax ?? null,
    total: note?.Total ?? null,
    remaining_credit: note?.RemainingCredit ?? null,
    line_items: (note?.LineItems || []).map((line: any) => ({
      description: line.Description || "",
      quantity: line.Quantity ?? 1,
      unit_amount: line.UnitAmount ?? 0,
      account_code: line.AccountCode || null,
      tax_type: line.TaxType || null,
      tracking: line.Tracking || [],
    })),
  };
}

function trackingFromLine(line: any): any[] | undefined {
  const tracking = line?.tracking || line?.Tracking;
  if (!Array.isArray(tracking) || tracking.length === 0) return undefined;
  const options = tracking
    .map((item: any) => {
      const name = String(item?.Name || item?.name || "").trim();
      const option = String(item?.Option || item?.option || "").trim();
      if (!name || !option) return null;
      return { Name: name, Option: option };
    })
    .filter(Boolean);
  return options.length > 0 ? options : undefined;
}

export function buildAccpayLineItems(rawLines: unknown): any[] {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new SupplierBillError(
      "line_items required",
      400,
      "LINE_ITEMS_REQUIRED",
    );
  }
  const lines = rawLines.map((line: any, index: number) => {
    const description = String(
      line?.description || line?.Description || "",
    ).trim();
    const quantity = Number(line?.quantity ?? line?.Quantity ?? 1);
    const unitAmount = Number(
      line?.unit_price ?? line?.unit_amount ?? line?.UnitAmount ?? 0,
    );
    const accountCode = String(
      line?.account_code || line?.AccountCode || ACCPAY_ACCOUNT_DEFAULT,
    ).trim();
    const taxType = String(line?.tax_type || line?.TaxType || "NONE").trim() ||
      "NONE";
    if (!description) {
      throw new SupplierBillError(
        `line_items[${index}] needs a description`,
        400,
      );
    }
    if (!Number.isFinite(quantity) || quantity === 0) {
      throw new SupplierBillError(
        `line_items[${index}] needs a non-zero quantity`,
        400,
      );
    }
    if (!Number.isFinite(unitAmount)) {
      throw new SupplierBillError(
        `line_items[${index}] needs a numeric unit amount`,
        400,
      );
    }
    const item: Record<string, unknown> = {
      Description: description,
      Quantity: quantity,
      UnitAmount: round2(unitAmount),
      AccountCode: accountCode,
      TaxType: taxType,
    };
    const tracking = trackingFromLine(line);
    if (tracking) item.Tracking = tracking;
    return item;
  });
  return lines;
}

function accpayCacheRow(inv: any): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    org_id: DEFAULT_ORG_ID,
    xero_invoice_id: inv.InvoiceID,
    xero_contact_id: inv.Contact?.ContactID || null,
    contact_name: inv.Contact?.Name || null,
    invoice_number: inv.InvoiceNumber || null,
    invoice_type: inv.Type || "ACCPAY",
    status: inv.Status || "DRAFT",
    reference: inv.Reference || null,
    sub_total: inv.SubTotal || 0,
    total_tax: inv.TotalTax || 0,
    total: inv.Total || 0,
    amount_due: inv.AmountDue || 0,
    amount_paid: inv.AmountPaid || 0,
    invoice_date: inv.DateString || null,
    due_date: inv.DueDateString || null,
    line_items: inv.LineItems || [],
    raw_json: inv,
    synced_at: now,
    updated_at: now,
  };
}

async function cacheAccpay(
  client: any,
  inv: any,
): Promise<void> {
  if (!inv?.InvoiceID) return;
  try {
    await client.from("xero_invoices").upsert(accpayCacheRow(inv), {
      onConflict: "org_id,xero_invoice_id",
    });
  } catch {
    /* local cache is best-effort */
  }
}

export const SUPPLIER_BILL_MAX_PAGE_SIZE = 100;
export const SUPPLIER_BILL_DEFAULT_PAGE_SIZE = 100;

/**
 * Bounded page size for the ACCPAY list door.
 * Xero caps /Invoices at 100 rows per page, so anything larger is a caller
 * mistake rather than a bigger read. Clamp instead of rejecting so an existing
 * `limit=1000` caller keeps working on a single bounded page. The default is
 * 100 to match the page Xero already returned before this door asked for one,
 * so omitting page_size cannot silently shrink an existing caller's result.
 */
export function clampBillPageSize(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SUPPLIER_BILL_DEFAULT_PAGE_SIZE;
  }
  return Math.min(SUPPLIER_BILL_MAX_PAGE_SIZE, Math.floor(parsed));
}

/**
 * Cache a whole provider page in one upsert.
 * The old per-invoice awaited loop cost one Postgres round trip per bill, so a
 * full page of 100 ACCPAY rows (each carrying raw_json) routinely outran the
 * MCP per-attempt abort budget before any rows reached the caller.
 */
async function cacheAccpayBatch(client: any, invoices: any[]): Promise<void> {
  // Dedupe by InvoiceID first. An ON CONFLICT batch that touches the same key
  // twice is rejected whole, so one duplicate row from the provider would drop
  // the entire page's cache instead of just its own.
  const byId = new Map<string, Record<string, unknown>>();
  for (const inv of invoices || []) {
    if (!inv?.InvoiceID) continue;
    byId.set(String(inv.InvoiceID), accpayCacheRow(inv));
  }
  const rows = [...byId.values()];
  if (rows.length === 0) return;
  try {
    await client.from("xero_invoices").upsert(rows, {
      onConflict: "org_id,xero_invoice_id",
    });
  } catch {
    /* local cache is best-effort */
  }
}

async function loadAccpayFromXero(
  xeroGet: XeroGetFn,
  accessToken: string,
  tenantId: string,
  xeroInvoiceId: string,
): Promise<any> {
  const result = await xeroGet(
    `/Invoices/${encodeURIComponent(xeroInvoiceId)}`,
    accessToken,
    tenantId,
  );
  const inv = result?.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new SupplierBillError("Supplier bill not found in Xero", 404, "NOT_FOUND");
  }
  if (String(inv.Type || "").toUpperCase() !== "ACCPAY") {
    throw new SupplierBillError(
      "Xero id is not a supplier bill (ACCPAY)",
      409,
      "NOT_ACCPAY",
    );
  }
  return inv;
}

export function buildSupplierBillWhere(input: {
  contactName?: string | null;
  invoiceRef?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  status?: AccpayStatusFilter | null;
}): string {
  const parts = ['Type=="ACCPAY"'];
  if (input.status) parts.push(`Status=="${input.status}"`);
  const invoiceRef = String(
    input.invoiceRef || input.invoiceNumber || input.reference || "",
  ).trim();
  if (invoiceRef) {
    parts.push(xeroInvoiceRefOrNumberWhere(escapeXeroLiteral(invoiceRef)));
  }
  const contactName = String(input.contactName || "").trim();
  if (contactName) {
    parts.push(
      `Contact.Name!=null AND Contact.Name.Contains("${
        escapeXeroLiteral(contactName)
      }")`,
    );
  }
  return parts.join(" AND ");
}

export async function getSupplierBill(
  client: any,
  params: URLSearchParams | Record<string, string>,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
) {
  const read = (key: string) =>
    params instanceof URLSearchParams
      ? params.get(key)
      : (params as Record<string, string>)[key];
  const ids = ["xero_invoice_id", "xero_bill_id", "xero_id"]
    .map((key) => String(read(key) ?? "").trim())
    .filter((id) => id.length > 0);
  const xeroInvoiceId = ids[0];
  if (!xeroInvoiceId) {
    throw new SupplierBillError("xero_invoice_id required", 400);
  }
  if (ids.some((id) => id.toLowerCase() !== xeroInvoiceId.toLowerCase())) {
    throw new SupplierBillError(
      "Conflicting supplier bill IDs; supply one ID or matching aliases",
      400,
      "SUPPLIER_BILL_ID_CONFLICT",
    );
  }
  const { accessToken, tenantId } = await deps.getToken(client);
  const inv = await loadAccpayFromXero(
    deps.xeroGet,
    accessToken,
    tenantId,
    xeroInvoiceId,
  );
  await cacheAccpay(client, inv);
  return { ok: true, bill: presentBill(inv) };
}

function readParamOrBody(
  params: URLSearchParams | Record<string, string>,
  body: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const fromParams = params instanceof URLSearchParams
    ? params.get(key)
    : (params as Record<string, string>)[key];
  if (fromParams) return String(fromParams);
  const fromBody = body?.[key];
  return fromBody == null ? "" : String(fromBody);
}

/**
 * Read-only point-get of one Xero invoice by InvoiceID.
 * Returns Type (ACCPAY or ACCREC), Status, and LineItems so classify is not
 * fail-closed. Never approves, voids, pays, emails, or rewrites a draft.
 */
export async function getXeroInvoice(
  client: any,
  params: URLSearchParams | Record<string, string>,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
  body?: Record<string, unknown> | null,
) {
  const xeroInvoiceId = String(
    readParamOrBody(params, body, "xero_invoice_id") ||
      readParamOrBody(params, body, "invoice_id") ||
      readParamOrBody(params, body, "xero_id") ||
      "",
  ).trim();
  if (!xeroInvoiceId) {
    throw new SupplierBillError("xero_invoice_id required", 400);
  }
  const { accessToken, tenantId } = await deps.getToken(client);
  const result = await deps.xeroGet(
    `/Invoices/${encodeURIComponent(xeroInvoiceId)}`,
    accessToken,
    tenantId,
  );
  const inv = result?.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new SupplierBillError("Xero invoice not found", 404, "NOT_FOUND");
  }
  const presented = presentBill(inv);
  return {
    ok: true,
    invoice: {
      ...presented,
      type: presented.invoice_type,
    },
  };
}

export async function listSupplierBills(
  client: any,
  params: URLSearchParams | Record<string, string>,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn },
) {
  const read = (key: string) =>
    params instanceof URLSearchParams
      ? params.get(key)
      : (params as Record<string, string>)[key];
  const status = mapSupplierBillStatusFilter(read("status"));
  const contactName = String(read("contact") || read("contact_name") || "")
    .trim();
  const invoiceRef = String(
    read("invoice_ref") || read("invoice_number") || read("reference") ||
      read("ref") || "",
  ).trim();
  const page = Math.max(1, Number(read("page") || 1) || 1);
  const pageSize = clampBillPageSize(
    read("page_size") ?? read("limit") ?? null,
  );
  const where = buildSupplierBillWhere({
    contactName,
    invoiceRef: invoiceRef || null,
    status,
  });
  const { accessToken, tenantId } = await deps.getToken(client);
  const result = await deps.xeroGet("/Invoices", accessToken, tenantId, {
    where,
    page: String(page),
    pageSize: String(pageSize),
    order: "Date DESC",
  });
  // One bounded provider page only. This door never traverses Xero pages: the
  // caller pages explicitly, so a full ACCPAY ledger cannot blow the MCP
  // per-attempt abort budget on a single read.
  const invoices = result?.Invoices || [];
  // An over-run page means Xero ignored pageSize. Trimming it silently would
  // hide supplier bills from a books read and hand back has_more the caller
  // cannot trust, so fail the way listXeroReceivables does.
  if (invoices.length > pageSize) {
    throw new SupplierBillError(
      "Xero exceeded the requested page size",
      502,
      "XERO_RESPONSE_INVALID",
    );
  }
  await cacheAccpayBatch(client, invoices);
  return {
    ok: true,
    bills: invoices.map(presentBill),
    page,
    page_size: pageSize,
    count: invoices.length,
    has_more: invoices.length >= pageSize,
    next_page: invoices.length >= pageSize ? page + 1 : null,
  };
}

async function resolveSupplierContactId(
  body: any,
  deps: { xeroGet: XeroGetFn; xeroPost: XeroPostFn },
  accessToken: string,
  tenantId: string,
): Promise<string> {
  const contactId = String(
    body?.xero_contact_id || body?.contact_id || "",
  ).trim();
  if (contactId) return contactId;
  const contactName = String(body?.contact_name || body?.contact || "").trim();
  if (!contactName) {
    throw new SupplierBillError(
      "contact_name or xero_contact_id required",
      400,
    );
  }
  const escaped = escapeXeroLiteral(contactName);
  const found = await deps.xeroGet(
    `/Contacts?where=${encodeURIComponent(`Name=="${escaped}"`)}`,
    accessToken,
    tenantId,
  );
  const existing = (found?.Contacts || []).find((c: any) =>
    String(c.ContactStatus || "").toUpperCase() !== "ARCHIVED"
  ) || found?.Contacts?.[0];
  if (existing?.ContactID) return existing.ContactID;
  const created = await deps.xeroPost("/Contacts", accessToken, tenantId, {
    Contacts: [{
      Name: contactName,
      EmailAddress: body?.contact_email || undefined,
      IsSupplier: true,
    }],
  }, "PUT");
  const id = created?.Contacts?.[0]?.ContactID;
  if (!id) {
    throw new SupplierBillError(
      "Could not create Xero supplier contact",
      502,
      "CONTACT_CREATE_FAILED",
    );
  }
  return id;
}

function lineAmountTypes(body: any): "Exclusive" | "NoTax" | "Inclusive" {
  const raw = String(body?.line_amount_types || body?.LineAmountTypes || "")
    .trim();
  if (/notax|none|bas.?excl/i.test(raw)) return "NoTax";
  if (/incl/i.test(raw)) return "Inclusive";
  if (body?.gst_on === false || body?.tax_on === false) return "NoTax";
  return "Exclusive";
}

export async function createSupplierBill(
  client: any,
  body: any,
  deps: {
    getToken: GetTokenFn;
    xeroGet: XeroGetFn;
    xeroPost: XeroPostFn;
    fetchImpl?: typeof fetch;
  },
) {
  requireDraftStatus(body?.status || body?.xero_status, "create_supplier_bill");
  const lineItems = buildAccpayLineItems(body?.line_items || body?.lines);
  const { accessToken, tenantId } = await deps.getToken(client);
  const contactId = await resolveSupplierContactId(
    body,
    deps,
    accessToken,
    tenantId,
  );
  const date = String(body?.date || body?.invoice_date || "")
    .slice(0, 10) || new Date().toISOString().slice(0, 10);
  const dueDate = String(body?.due_date || body?.dueDate || "").slice(0, 10) ||
    null;
  const reference = String(body?.reference || body?.ref || "").trim();
  const payload = {
    Invoices: [{
      Type: "ACCPAY",
      Contact: { ContactID: contactId },
      Reference: reference || undefined,
      Date: date,
      DueDate: dueDate || undefined,
      Status: "DRAFT",
      LineAmountTypes: lineAmountTypes(body),
      LineItems: lineItems,
    }],
  };
  const result = await deps.xeroPost(
    "/Invoices",
    accessToken,
    tenantId,
    payload,
    "PUT",
    body?.idempotency_key || undefined,
  );
  const inv = result?.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new SupplierBillError(
      "Xero did not return a supplier bill",
      502,
      "XERO_CREATE_FAILED",
    );
  }
  requireDraftStatus(inv.Status, "created supplier bill");
  await cacheAccpay(client, inv);

  let pdf: { attached: boolean; filename?: string; error?: string } = {
    attached: false,
  };
  if (hasXeroPdfBase64Payload(body?.pdf_base64)) {
    const attached = await attachPdfBase64ToXeroInvoice({
      invoiceId: inv.InvoiceID,
      filename: body.pdf_filename || reference || inv.InvoiceNumber ||
        "supplier-bill",
      pdfBase64: body.pdf_base64,
      accessToken,
      tenantId,
      fetchImpl: deps.fetchImpl,
    });
    pdf = { attached: true, filename: attached.filename };
  }

  return {
    ok: true,
    status: "DRAFT",
    bill: presentBill(inv),
    pdf,
  };
}

export async function updateSupplierBill(
  client: any,
  body: any,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn; xeroPost: XeroPostFn },
) {
  const xeroInvoiceId = String(
    body?.xero_invoice_id || body?.xero_id || "",
  ).trim();
  if (!xeroInvoiceId) {
    throw new SupplierBillError("xero_invoice_id required", 400);
  }
  requireDraftStatus(body?.status || body?.xero_status || "DRAFT", "update_supplier_bill");
  const lineItems = buildAccpayLineItems(body?.line_items || body?.lines);
  const { accessToken, tenantId } = await deps.getToken(client);
  const existing = await loadAccpayFromXero(
    deps.xeroGet,
    accessToken,
    tenantId,
    xeroInvoiceId,
  );
  requireDraftStatus(existing.Status, "existing supplier bill");

  const payload: Record<string, unknown> = {
    InvoiceID: xeroInvoiceId,
    Type: "ACCPAY",
    Status: "DRAFT",
    LineItems: lineItems,
  };
  if (body?.reference || body?.ref) {
    payload.Reference = String(body.reference || body.ref).trim();
  }
  if (body?.date || body?.invoice_date) {
    payload.Date = String(body.date || body.invoice_date).slice(0, 10);
  }
  if (body?.due_date || body?.dueDate) {
    payload.DueDate = String(body.due_date || body.dueDate).slice(0, 10);
  }
  if (body?.line_amount_types || body?.gst_on === false) {
    payload.LineAmountTypes = lineAmountTypes(body);
  }

  const result = await deps.xeroPost(
    `/Invoices/${encodeURIComponent(xeroInvoiceId)}`,
    accessToken,
    tenantId,
    { Invoices: [payload] },
    "POST",
  );
  const inv = result?.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new SupplierBillError(
      "Xero did not return the updated supplier bill",
      502,
      "XERO_UPDATE_FAILED",
    );
  }
  requireDraftStatus(inv.Status, "updated supplier bill");
  await cacheAccpay(client, inv);
  return { ok: true, status: "DRAFT", bill: presentBill(inv) };
}

export async function attachSupplierBillPdf(
  client: any,
  body: any,
  deps: {
    getToken: GetTokenFn;
    xeroGet: XeroGetFn;
    fetchImpl?: typeof fetch;
  },
) {
  const xeroInvoiceId = String(
    body?.xero_invoice_id || body?.xero_id || "",
  ).trim();
  if (!xeroInvoiceId) {
    throw new SupplierBillError("xero_invoice_id required", 400);
  }
  if (!body?.pdf_base64) {
    throw new SupplierBillError("pdf_base64 required", 400);
  }
  const { accessToken, tenantId } = await deps.getToken(client);
  const existing = await loadAccpayFromXero(
    deps.xeroGet,
    accessToken,
    tenantId,
    xeroInvoiceId,
  );
  try {
    const attached = await attachPdfBase64ToXeroInvoice({
      invoiceId: xeroInvoiceId,
      filename: body.pdf_filename || existing.InvoiceNumber ||
        existing.Reference || "supplier-bill",
      pdfBase64: body.pdf_base64,
      accessToken,
      tenantId,
      fetchImpl: deps.fetchImpl,
    });
    return {
      ok: true,
      attached: true,
      xero_invoice_id: xeroInvoiceId,
      filename: attached.filename,
      status: existing.Status || null,
    };
  } catch (error) {
    if (error instanceof XeroPdfAttachError) {
      throw new SupplierBillError(error.message, error.status, error.code);
    }
    throw error;
  }
}

export async function createSupplierCreditNote(
  client: any,
  body: any,
  deps: { getToken: GetTokenFn; xeroGet: XeroGetFn; xeroPost: XeroPostFn },
) {
  requireDraftStatus(
    body?.status || body?.xero_status,
    "create_supplier_credit_note",
  );
  const lineItems = buildAccpayLineItems(body?.line_items || body?.lines);
  const { accessToken, tenantId } = await deps.getToken(client);
  const contactId = await resolveSupplierContactId(
    body,
    deps,
    accessToken,
    tenantId,
  );
  const date = String(body?.date || "").slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const payload = {
    CreditNotes: [{
      Type: "ACCPAYCREDIT",
      Contact: { ContactID: contactId },
      Reference: String(body?.reference || body?.ref || "").trim() || undefined,
      Date: date,
      Status: "DRAFT",
      LineAmountTypes: lineAmountTypes(body),
      LineItems: lineItems,
    }],
  };
  const result = await deps.xeroPost(
    "/CreditNotes",
    accessToken,
    tenantId,
    payload,
    "PUT",
    body?.idempotency_key || undefined,
  );
  const note = result?.CreditNotes?.[0];
  if (!note?.CreditNoteID) {
    throw new SupplierBillError(
      "Xero did not return a supplier credit note",
      502,
      "XERO_CREDIT_CREATE_FAILED",
    );
  }
  requireDraftStatus(note.Status, "created supplier credit note");
  return { ok: true, status: "DRAFT", credit_note: presentCreditNote(note) };
}
