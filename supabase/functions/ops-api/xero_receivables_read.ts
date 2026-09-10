// Direct Xero accounting reads. Only the injected token helper may maintain
// credentials; this module has no business/cache write or provider POST capability.
import type { GetTokenFn, XeroGetFn } from "./xero_accpay_books.ts";
import {
  XeroCooldownError,
  xeroCooldownReport,
} from "../_shared/xero_cooldown.ts";

export class XeroReceivablesReadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "XERO_READ_INVALID",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "XeroReceivablesReadError";
  }
}

type RawRecord = Record<string, unknown>;
type Params = URLSearchParams | Record<string, unknown>;
type XeroResponseMetadata = {
  shared_cooldown: Record<string, unknown> | null;
  request_id: string | null;
  quota: {
    minute_remaining: string | null;
    day_remaining: string | null;
    app_minute_remaining: string | null;
    limit_problem: string | null;
  };
};
type XeroReadResult = { data: unknown; metadata: XeroResponseMetadata };
type XeroReadGetFn = (
  ...args: Parameters<XeroGetFn>
) => Promise<XeroReadResult>;
type ReadDeps = {
  getToken: GetTokenFn;
  xeroGet: XeroReadGetFn;
  now?: () => Date;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_TIMEOUT_MS = 12_000;

function responseMetadata(response: Response): XeroResponseMetadata {
  const header = (name: string) =>
    response.headers.get(name)?.slice(0, 256) ?? null;
  return {
    shared_cooldown: xeroCooldownReport(response),
    request_id: header("xero-correlation-id") ?? header("xero-request-id") ??
      header("x-request-id"),
    quota: {
      minute_remaining: header("x-minlimit-remaining"),
      day_remaining: header("x-daylimit-remaining"),
      app_minute_remaining: header("x-appminlimit-remaining"),
      limit_problem: header("x-rate-limit-problem"),
    },
  };
}

// Unlike the shared legacy xeroGet, evidence reads never sleep on a 429.
// A provider Retry-After can be hours; surface it to the caller immediately.
export function createXeroReadGet(options: {
  fetchFn?: typeof fetch;
  now?: () => Date;
} = {}): XeroReadGetFn {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  return async (path, accessToken, tenantId, params) => {
    const url = new URL(`https://api.xero.com/api.xro/2.0${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Xero-tenant-id": tenantId,
          Accept: "application/json",
        },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof XeroCooldownError) throw error;
      throw new XeroReceivablesReadError(
        signal.aborted
          ? "Xero read timed out"
          : "Xero read could not reach the provider",
        signal.aborted ? 504 : 502,
        signal.aborted ? "XERO_READ_TIMEOUT" : "XERO_READ_UNAVAILABLE",
      );
    }
    if (!response.ok) {
      const requestedAt = now();
      const rawRetry = response.headers.get("Retry-After");
      const retryDate = rawRetry ? Date.parse(rawRetry) : NaN;
      const retrySeconds = rawRetry && /^\d+$/.test(rawRetry)
        ? Number(rawRetry)
        : Number.isFinite(retryDate)
        ? Math.max(0, Math.ceil((retryDate - requestedAt.getTime()) / 1000))
        : null;
      const retryAtMs = retrySeconds === null
        ? NaN
        : requestedAt.getTime() + retrySeconds * 1000;
      const validRetry = retrySeconds !== null &&
        Number.isSafeInteger(retrySeconds) &&
        Number.isFinite(new Date(retryAtMs).getTime());
      // Preserve only useful headers. Provider error bodies may include submitted
      // data or implementation detail, so they are never reflected or logged here.
      const details = {
        provider_status: response.status,
        retry_after_seconds: validRetry ? retrySeconds : null,
        retry_at: validRetry ? new Date(retryAtMs).toISOString() : null,
        ...responseMetadata(response),
        provenance: {
          source: "xero",
          tenant_id: tenantId,
          retrieved_at: requestedAt.toISOString(),
          method: "GET",
          path,
          cache_used: false,
        },
      };
      // Release an unread body without waiting for a large provider error payload.
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        throw new XeroReceivablesReadError(
          "Xero rate limit reached; wait until retry_at before another provider read",
          429,
          "XERO_RATE_LIMITED",
          details,
        );
      }
      throw new XeroReceivablesReadError(
        `Xero read failed with provider status ${response.status}`,
        response.status === 404 ? 404 : 502,
        "XERO_PROVIDER_ERROR",
        details,
      );
    }
    try {
      return {
        data: await response.json(),
        metadata: responseMetadata(response),
      };
    } catch {
      throw new XeroReceivablesReadError(
        signal.aborted ? "Xero read timed out" : "Xero returned invalid JSON",
        signal.aborted ? 504 : 502,
        signal.aborted ? "XERO_READ_TIMEOUT" : "XERO_RESPONSE_INVALID",
      );
    }
  };
}

const STATUSES = new Set([
  "OUTSTANDING",
  "ALL",
  "DRAFT",
  "SUBMITTED",
  "AUTHORISED",
  "PAID",
  "VOIDED",
  "DELETED",
]);

function read(params: Params, key: string): unknown {
  return params instanceof URLSearchParams ? params.get(key) : params[key];
}

function validateKeys(params: Params, allowed: string[]) {
  const keys = params instanceof URLSearchParams
    ? [...params.keys()]
    : Object.keys(params);
  for (const key of keys) {
    if (key !== "action" && !allowed.includes(key)) {
      throw new XeroReceivablesReadError(`Unsupported parameter: ${key}`);
    }
    if (params instanceof URLSearchParams && params.getAll(key).length !== 1) {
      throw new XeroReceivablesReadError(`Repeated parameter: ${key}`);
    }
  }
}

function uuid(value: unknown, field: string, status = 400): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new XeroReceivablesReadError(
      `${field} must be a UUID`,
      status,
      status === 400 ? "XERO_READ_INVALID" : "XERO_TENANT_INVALID",
    );
  }
  return value.toLowerCase();
}

function positiveInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === null) return fallback;
  const isIntegerText = typeof value === "string" &&
    /^[1-9][0-9]*$/.test(value);
  const number = typeof value === "number" || isIntegerText
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new XeroReceivablesReadError(
      `${field} must be an integer from 1 to ${maximum}`,
    );
  }
  return number;
}

function rawRecord(value: unknown): value is RawRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function records(result: unknown, field: string): RawRecord[] {
  if (!rawRecord(result) || !Array.isArray(result[field])) {
    throw new XeroReceivablesReadError(
      `Xero response is missing ${field}`,
      502,
      "XERO_RESPONSE_INVALID",
    );
  }
  const rows = result[field];
  if (!rows.every(rawRecord)) {
    throw new XeroReceivablesReadError(
      `Xero ${field} contains an invalid record`,
      502,
      "XERO_RESPONSE_INVALID",
    );
  }
  return rows;
}

function requireReceivable(invoice: RawRecord) {
  if (invoice.Type !== "ACCREC") {
    throw new XeroReceivablesReadError(
      "Xero invoice is not an accounts receivable invoice (ACCREC)",
      409,
      "NOT_ACCREC",
    );
  }
}

function oneRecord(
  result: unknown,
  collection: string,
  idField: string,
  id: string,
) {
  const rows = records(result, collection);
  if (rows.length === 0) {
    throw new XeroReceivablesReadError(
      "Xero record not found",
      404,
      "XERO_RECORD_NOT_FOUND",
    );
  }
  if (rows.length !== 1 || String(rows[0][idField]).toLowerCase() !== id) {
    throw new XeroReceivablesReadError(
      "Xero response did not match the requested record identity",
      502,
      "XERO_RECORD_MISMATCH",
    );
  }
  return rows[0];
}

// Match structured credential labels, not business values, prose, or URLs.
// Generic Key/PublicKey and identity/tax/bank fields are not credential labels.
const CREDENTIAL_FIELD =
  /^(?:(?:oauth)?(?:access|refresh|id|auth|authentication|authorization|bearer|api|portal|share|download|session|reset|invite|invitation|verification|sas)?token(?:secret)?|(?:oauth)?(?:x?api|service(?:role)?|private|secret|signing|encryption|client|consumer|access|secretaccess)(?:key|secret)(?:id)?|secret|password|passwd|pwd|bearer|auth|authentication|authorization|cookie|setcookie|credential|credentials|connectionstring|signedurl|signeddownloadurl)$/i;

function redactXeroCredentialFields(providerResult: unknown) {
  const redactedPaths: string[] = [];
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > 1_000_000 || depth > 64) {
      throw new XeroReceivablesReadError(
        "Xero response exceeds the supported redaction structure",
        502,
        "XERO_RESPONSE_INVALID",
      );
    }
    if (Array.isArray(value)) {
      const next = value.map((item, index) =>
        visit(item, `${path}/${index}`, depth + 1)
      );
      return next.some((item, index) => item !== value[index]) ? next : value;
    }
    if (!rawRecord(value)) return value;
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const nextPath = `${path}/${
        key.replace(/~/g, "~0").replace(/\//g, "~1")
      }`;
      let next: unknown;
      if (CREDENTIAL_FIELD.test(key.replace(/[^a-z0-9]/gi, ""))) {
        redactedPaths.push(nextPath);
        next = "[REDACTED_CREDENTIAL]";
      } else next = visit(item, nextPath, depth + 1);
      if (next !== item) changed = true;
      return [key, next];
    });
    // Do not mutate the provider response; untouched business records retain
    // their original values and identity, including future provider fields.
    return changed ? Object.fromEntries(entries) : value;
  };
  const result = visit(providerResult, "", 0);
  return { result, redactedPaths: redactedPaths.sort() };
}

async function providerRead(
  client: unknown,
  deps: ReadDeps,
  path: string,
  params?: Record<string, string>,
) {
  const { accessToken, tenantId } = await deps.getToken(client);
  // Tenant is selected by existing server credential handling, never by caller input.
  const tenant = uuid(tenantId, "Configured Xero tenant_id", 502);
  const { data, metadata } = await deps.xeroGet(
    path,
    accessToken,
    tenant,
    params,
  );
  // Every exported record reader passes this boundary before selecting records
  // or copying provider fields into provenance. Paths refer to the raw provider
  // JSON, not the renamed/plucked collections in the outward response.
  const { result, redactedPaths } = redactXeroCredentialFields(data);
  return {
    result,
    provenance: {
      source: "xero" as const,
      tenant_id: tenant,
      retrieved_at: (deps.now?.() ?? new Date()).toISOString(),
      method: "GET" as const,
      path,
      query: params ?? {},
      ...metadata,
      provider_response_id: rawRecord(result) ? result.Id ?? null : null,
      provider_date_time_utc: rawRecord(result)
        ? result.DateTimeUTC ?? null
        : null,
      cache_used: false,
      content_redacted: redactedPaths.length > 0,
      redacted_paths: redactedPaths,
      redaction_policy: "structured_credential_fields_v1",
      redacted_paths_root: "provider_response",
    },
  };
}

export async function readXeroOrganisation(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, []);
  const { result, provenance } = await providerRead(
    client,
    deps,
    "/Organisation",
  );
  const organisations = records(result, "Organisations");
  if (organisations.length === 0) {
    throw new XeroReceivablesReadError(
      "Xero organisation not found",
      404,
      "XERO_RECORD_NOT_FOUND",
    );
  }
  return { ok: true, organisations, provenance };
}

export async function readXeroTrackingCategories(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, []);
  const { result, provenance } = await providerRead(
    client,
    deps,
    "/TrackingCategories",
    { includeArchived: "true" },
  );
  return {
    ok: true,
    tracking_categories: records(result, "TrackingCategories"),
    provenance,
  };
}

function pagination(page: number, pageSize: number, count: number) {
  // Xero pages are live reads, not an immutable snapshot. A full page means
  // another page may exist; do not infer a total from this single invocation.
  const hasMore = count === pageSize;
  const limitReached = hasMore && page === 1_000_000;
  return {
    page,
    page_size: pageSize,
    count,
    has_more: hasMore,
    next_page: hasMore && !limitReached ? page + 1 : null,
    traversal_complete: false,
    traversal_limit_reached: limitReached,
    end_of_results_observed: !hasMore,
    limitations: [
      "One provider page per invocation; follow next_page until an incomplete or empty page.",
      "A full page indicates possible continuation, not a confirmed remaining record count.",
      "Pages are not a snapshot: source changes between reads can cause omissions or duplicates. Reconcile record IDs across pages.",
      "Traversal is bounded at page 1000000; reaching the bound is not completion.",
    ],
  };
}

export async function listXeroReceivables(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["status", "page", "page_size", "contact_id"]);
  const rawStatus = read(params, "status");
  const status = rawStatus === undefined || rawStatus === null
    ? "OUTSTANDING"
    : typeof rawStatus === "string"
    ? rawStatus.toUpperCase()
    : "";
  if (!STATUSES.has(status)) {
    throw new XeroReceivablesReadError(
      `status must be one of ${[...STATUSES].join(", ")}`,
    );
  }
  const page = positiveInteger(read(params, "page"), "page", 1, 1_000_000);
  const pageSize = positiveInteger(
    read(params, "page_size"),
    "page_size",
    100,
    100,
  );
  const rawContact = read(params, "contact_id");
  const contactId = rawContact === undefined || rawContact === null
    ? null
    : uuid(rawContact, "contact_id");
  const where = ['Type=="ACCREC"'];
  if (status === "OUTSTANDING") {
    where.push('Status=="AUTHORISED"', "AmountDue>0");
  } else if (status !== "ALL") {
    where.push(`Status=="${status}"`);
  }
  const query: Record<string, string> = {
    where: where.join(" AND "),
    page: String(page),
    pageSize: String(pageSize),
    order: "InvoiceID ASC",
  };
  if (contactId) query.ContactIDs = contactId;
  const { result, provenance } = await providerRead(
    client,
    deps,
    "/Invoices",
    query,
  );
  const invoices = records(result, "Invoices");
  if (invoices.length > pageSize) {
    throw new XeroReceivablesReadError(
      "Xero exceeded the requested page size",
      502,
      "XERO_RESPONSE_INVALID",
    );
  }
  const seen = new Set<string>();
  for (const invoice of invoices) {
    requireReceivable(invoice);
    const id = typeof invoice.InvoiceID === "string"
      ? invoice.InvoiceID.toLowerCase()
      : "";
    if (!UUID.test(id) || seen.has(id)) {
      throw new XeroReceivablesReadError(
        "Xero page contains missing or duplicate invoice identities",
        502,
        "XERO_RESPONSE_INVALID",
      );
    }
    seen.add(id);
    const expectedStatus = status === "OUTSTANDING" ? "AUTHORISED" : status;
    if (
      (status !== "ALL" && invoice.Status !== expectedStatus) ||
      (status === "OUTSTANDING" &&
        !(typeof invoice.AmountDue === "number" && invoice.AmountDue > 0)) ||
      (contactId &&
        (!rawRecord(invoice.Contact) ||
          String(invoice.Contact.ContactID).toLowerCase() !== contactId))
    ) {
      throw new XeroReceivablesReadError(
        "Xero returned an invoice outside the requested filters",
        502,
        "XERO_FILTER_MISMATCH",
      );
    }
  }
  return {
    ok: true,
    invoices,
    filters: { type: "ACCREC", status, contact_id: contactId },
    pagination: pagination(page, pageSize, invoices.length),
    provenance,
  };
}

export async function getXeroReceivable(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["xero_invoice_id"]);
  const id = uuid(read(params, "xero_invoice_id"), "xero_invoice_id");
  const { result, provenance } = await providerRead(
    client,
    deps,
    `/Invoices/${id}`,
  );
  const invoice = oneRecord(result, "Invoices", "InvoiceID", id);
  requireReceivable(invoice);
  return { ok: true, invoice, provenance };
}

const SETTLEMENTS = {
  payment: {
    collection: "Payments",
    idField: "PaymentID",
    typeField: "PaymentType",
    types: [
      "ACCRECPAYMENT",
      "ARCREDITPAYMENT",
      "AROVERPAYMENTPAYMENT",
      "ARPREPAYMENTPAYMENT",
    ],
  },
  credit_note: {
    collection: "CreditNotes",
    idField: "CreditNoteID",
    typeField: "Type",
    types: ["ACCRECCREDIT"],
  },
  overpayment: {
    collection: "Overpayments",
    idField: "OverpaymentID",
    typeField: "Type",
    types: ["RECEIVE-OVERPAYMENT"],
  },
  prepayment: {
    collection: "Prepayments",
    idField: "PrepaymentID",
    typeField: "Type",
    types: ["RECEIVE-PREPAYMENT"],
  },
} as const;

function settlementKind(params: Params): keyof typeof SETTLEMENTS {
  const recordType = read(params, "record_type");
  if (
    typeof recordType !== "string" || !Object.hasOwn(SETTLEMENTS, recordType)
  ) {
    throw new XeroReceivablesReadError(
      "record_type must be payment, credit_note, overpayment, or prepayment",
    );
  }
  return recordType as keyof typeof SETTLEMENTS;
}

function requireReceivableSettlement(
  record: RawRecord,
  kind: keyof typeof SETTLEMENTS,
) {
  const config = SETTLEMENTS[kind];
  if (
    !(config.types as readonly unknown[]).includes(record[config.typeField])
  ) {
    throw new XeroReceivablesReadError(
      "Xero settlement record is not a receivables record",
      409,
      "NOT_ACCREC_SETTLEMENT",
    );
  }
  if (rawRecord(record.Invoice) && record.Invoice.Type !== undefined) {
    requireReceivable(record.Invoice);
  }
}

export async function readXeroSettlementRecord(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["record_type", "record_id"]);
  const kind = settlementKind(params);
  const config = SETTLEMENTS[kind];
  const id = uuid(read(params, "record_id"), "record_id");
  const { result, provenance } = await providerRead(
    client,
    deps,
    `/${config.collection}/${id}`,
  );
  const record = oneRecord(result, config.collection, config.idField, id);
  requireReceivableSettlement(record, kind);
  return { ok: true, record_type: kind, record, provenance };
}

export async function listXeroSettlementRecords(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["record_type", "page", "page_size"]);
  const kind = settlementKind(params);
  const config = SETTLEMENTS[kind];
  const page = positiveInteger(read(params, "page"), "page", 1, 1_000_000);
  const pageSize = positiveInteger(
    read(params, "page_size"),
    "page_size",
    100,
    100,
  );
  const where = config.types.map((type) => `${config.typeField}=="${type}"`)
    .join(" OR ");
  const { result, provenance } = await providerRead(
    client,
    deps,
    `/${config.collection}`,
    {
      where,
      page: String(page),
      pageSize: String(pageSize),
      order: `${config.idField} ASC`,
    },
  );
  const rows = records(result, config.collection);
  if (rows.length > pageSize) {
    throw new XeroReceivablesReadError(
      "Xero exceeded the requested page size",
      502,
      "XERO_RESPONSE_INVALID",
    );
  }
  const seen = new Set<string>();
  for (const row of rows) {
    requireReceivableSettlement(row, kind);
    const id = typeof row[config.idField] === "string"
      ? String(row[config.idField]).toLowerCase()
      : "";
    if (!UUID.test(id) || seen.has(id)) {
      throw new XeroReceivablesReadError(
        "Xero page contains missing or duplicate settlement identities",
        502,
        "XERO_RESPONSE_INVALID",
      );
    }
    seen.add(id);
  }
  return {
    ok: true,
    record_type: kind,
    records: rows,
    pagination: pagination(page, pageSize, rows.length),
    provenance,
  };
}

// ── Bank evidence reads (CIO, 2026-09-11; BOOKKEEPING ask 3, D-07 foundation) ──
//
// Xero exposes bank TRANSACTIONS (spend/receive money and their reconciled
// flag) and bank account BALANCES through the Bank Summary report. It does not
// expose raw bank statement lines through the public API. So "arrived and not
// yet reconciled" here means a Xero bank transaction whose IsReconciled is
// false, which is the closest provider fact available; a statement line with no
// Xero transaction yet is invisible to this read and must be stated as such.

const BANK_TRANSACTION_STATUSES = new Set(["UNRECONCILED", "ALL", "AUTHORISED", "DELETED"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z"))) {
    throw new XeroReceivablesReadError(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function xeroDateTimeLiteral(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `DateTime(${y}, ${m}, ${d})`;
}

export async function listXeroBankTransactions(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["status", "bank_account_id", "date_from", "date_to", "page", "page_size"]);
  const status = String(read(params, "status") ?? "UNRECONCILED").toUpperCase();
  if (!BANK_TRANSACTION_STATUSES.has(status)) {
    throw new XeroReceivablesReadError(`status must be one of ${[...BANK_TRANSACTION_STATUSES].join(", ")}`);
  }
  const page = positiveInteger(read(params, "page"), "page", 1, 1_000_000);
  const pageSize = positiveInteger(read(params, "page_size"), "page_size", 100, 100);
  const rawAccount = read(params, "bank_account_id");
  const bankAccountId = rawAccount === undefined || rawAccount === null || rawAccount === "" ? null : uuid(rawAccount, "bank_account_id");
  const dateFrom = isoDate(read(params, "date_from"), "date_from");
  const dateTo = isoDate(read(params, "date_to"), "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new XeroReceivablesReadError("date_from must not be after date_to");
  const where: string[] = [];
  if (status === "UNRECONCILED") where.push("IsReconciled==false", 'Status=="AUTHORISED"');
  else if (status !== "ALL") where.push(`Status=="${status}"`);
  if (bankAccountId) where.push(`BankAccount.AccountID==Guid("${bankAccountId}")`);
  if (dateFrom) where.push(`Date>=${xeroDateTimeLiteral(dateFrom)}`);
  if (dateTo) where.push(`Date<=${xeroDateTimeLiteral(dateTo)}`);
  const query: Record<string, string> = {
    page: String(page),
    pageSize: String(pageSize),
    order: "Date DESC, BankTransactionID ASC",
  };
  if (where.length) query.where = where.join(" AND ");
  const { result, provenance } = await providerRead(client, deps, "/BankTransactions", query);
  const rows = records(result, "BankTransactions");
  if (rows.length > pageSize) {
    throw new XeroReceivablesReadError("Xero exceeded the requested page size", 502, "XERO_RESPONSE_INVALID");
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.BankTransactionID === "string" ? row.BankTransactionID.toLowerCase() : "";
    if (!UUID.test(id) || seen.has(id)) {
      throw new XeroReceivablesReadError("Xero page contains missing or duplicate bank transaction identities", 502, "XERO_RESPONSE_INVALID");
    }
    seen.add(id);
    if (status === "UNRECONCILED" && row.IsReconciled !== false) {
      throw new XeroReceivablesReadError("Xero returned a reconciled transaction outside the requested filter", 502, "XERO_FILTER_MISMATCH");
    }
  }
  // Matching inputs the BOOKKEEPING rules read, lifted beside the raw row so a
  // matcher never has to re-derive them; the raw record stays for evidence.
  const transactions = rows.map((row) => ({
    bank_transaction_id: String(row.BankTransactionID).toLowerCase(),
    type: row.Type ?? null,
    status: row.Status ?? null,
    is_reconciled: row.IsReconciled === true,
    date: row.DateString ?? row.Date ?? null,
    total: typeof row.Total === "number" ? row.Total : null,
    sub_total: typeof row.SubTotal === "number" ? row.SubTotal : null,
    reference: typeof row.Reference === "string" ? row.Reference : null,
    contact_name: rawRecord(row.Contact) && typeof row.Contact.Name === "string" ? row.Contact.Name : null,
    contact_id: rawRecord(row.Contact) && typeof row.Contact.ContactID === "string" ? row.Contact.ContactID.toLowerCase() : null,
    bank_account_id: rawRecord(row.BankAccount) && typeof row.BankAccount.AccountID === "string" ? row.BankAccount.AccountID.toLowerCase() : null,
    bank_account_name: rawRecord(row.BankAccount) && typeof row.BankAccount.Name === "string" ? row.BankAccount.Name : null,
    line_item_descriptions: Array.isArray(row.LineItems)
      ? row.LineItems.filter(rawRecord).map((li) => (typeof li.Description === "string" ? li.Description : "")).filter(Boolean)
      : [],
    raw: row,
  }));
  return {
    ok: true,
    transactions,
    filters: { status, bank_account_id: bankAccountId, date_from: dateFrom, date_to: dateTo },
    pagination: pagination(page, pageSize, rows.length),
    provenance,
    coverage: {
      source: "xero_bank_transactions",
      statement_lines: "not_exposed_by_xero_api",
      note: "IsReconciled=false means a Xero bank transaction not yet matched. A bank statement line with no Xero transaction is not visible here. An allocation in Xero is not bank cash.",
    },
  };
}

export async function readXeroBankSummary(
  client: unknown,
  params: Params,
  deps: ReadDeps,
) {
  validateKeys(params, ["date_from", "date_to"]);
  const dateFrom = isoDate(read(params, "date_from"), "date_from");
  const dateTo = isoDate(read(params, "date_to"), "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new XeroReceivablesReadError("date_from must not be after date_to");
  const query: Record<string, string> = {};
  if (dateFrom) query.fromDate = dateFrom;
  if (dateTo) query.toDate = dateTo;
  const { result, provenance } = await providerRead(client, deps, "/Reports/BankSummary", query);
  const reports = records(result, "Reports");
  const report = reports[0];
  if (!report || report.ReportID !== "BankSummary") {
    throw new XeroReceivablesReadError("Xero did not return the Bank Summary report", 502, "XERO_RESPONSE_INVALID");
  }
  // Flatten the report's row grid into one line per bank account. Column order
  // in Xero's Bank Summary: Bank Accounts, Opening Balance, Cash Received,
  // Cash Spent, FX Gain, Closing Balance (FX Gain absent when not applicable).
  const headerCells: string[] = [];
  const accounts: Array<Record<string, unknown>> = [];
  const sections = Array.isArray(report.Rows) ? report.Rows.filter(rawRecord) : [];
  for (const section of sections) {
    if (section.RowType === "Header" && Array.isArray(section.Cells)) {
      for (const cell of section.Cells) headerCells.push(rawRecord(cell) && typeof cell.Value === "string" ? cell.Value : "");
    }
    const rows = Array.isArray(section.Rows) ? section.Rows.filter(rawRecord) : [];
    for (const row of rows) {
      if (row.RowType !== "Row" || !Array.isArray(row.Cells)) continue;
      const cells = row.Cells.filter(rawRecord);
      const value = (i: number) => (cells[i] && typeof cells[i].Value === "string" ? cells[i].Value : null);
      const number = (i: number) => { const v = value(i); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
      const attrs = cells[0] && Array.isArray(cells[0].Attributes) ? cells[0].Attributes.filter(rawRecord) : [];
      const accountId = attrs.find((a) => a.Id === "accountID" && typeof a.Value === "string")?.Value;
      const byHeader = (name: string) => { const i = headerCells.indexOf(name); return i >= 0 ? number(i) : null; };
      accounts.push({
        account_name: value(0),
        account_id: typeof accountId === "string" ? accountId.toLowerCase() : null,
        opening_balance: byHeader("Opening Balance"),
        cash_received: byHeader("Cash Received"),
        cash_spent: byHeader("Cash Spent"),
        closing_balance: byHeader("Closing Balance"),
        raw_cells: cells.map((c) => (typeof c.Value === "string" ? c.Value : null)),
      });
    }
  }
  return {
    ok: true,
    report: { id: report.ReportID, name: report.ReportName ?? null, date: report.ReportDate ?? null, titles: report.ReportTitles ?? null, columns: headerCells },
    accounts,
    filters: { date_from: dateFrom, date_to: dateTo },
    provenance,
    coverage: {
      source: "xero_reports_bank_summary",
      note: "Closing balance is Xero's ledger balance for the bank account at the report date, not the bank's own statement balance. Unreconciled statement lines can make the two differ.",
    },
  };
}
