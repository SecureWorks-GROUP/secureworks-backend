// Read-only insurance evidence readers.
//
// This module deliberately does not import the ops-api entrypoint. The entrypoint
// owns authentication and response/CORS wiring; it passes a trusted auth envelope
// and the already configured Supabase client into insuranceReadAction.
import { sanitizeJobRecord } from "./read_job_record.ts";

export const INSURANCE_READ_DEFAULT_ORG =
  "00000000-0000-0000-0000-000000000001";
export const INSURANCE_READ_CONTRACT_VERSION = "2026-09-10.1";
export const INSURANCE_READ_DEFAULT_PAGE_SIZE = 25;
export const INSURANCE_READ_MAX_PAGE_SIZE = 100;
export const INSURANCE_READ_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const INSURANCE_READ_MAX_BYTES = 10 * 1024 * 1024;
export const INSURANCE_READ_STORAGE_BUCKET = "job-documents";
export const INSURANCE_READ_JOB_PDFS_BUCKET = "job-pdfs";
export const INSURANCE_READ_MAX_JSON_BYTES = 4 * 1024 * 1024;
const CURSOR_MAX_LENGTH = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_CHARS = /^[A-Za-z0-9_-]+$/;
const OPERATOR_ROLES = new Set(["admin", "owner", "ops_manager"]);
type InsuranceReadStorageBucket =
  | typeof INSURANCE_READ_STORAGE_BUCKET
  | typeof INSURANCE_READ_JOB_PDFS_BUCKET;
const INSURANCE_READ_STORAGE_BUCKETS = new Set<InsuranceReadStorageBucket>([
  INSURANCE_READ_STORAGE_BUCKET,
  INSURANCE_READ_JOB_PDFS_BUCKET,
]);

function isInsuranceReadStorageBucket(
  value: string,
): value is InsuranceReadStorageBucket {
  return INSURANCE_READ_STORAGE_BUCKETS.has(
    value as InsuranceReadStorageBucket,
  );
}
const DOCUMENT_COLUMNS = [
  "id",
  "job_id",
  "type",
  "version",
  "pdf_url",
  "data_snapshot_json",
  "created_by",
  "sent_to_client",
  "sent_at",
  "viewed_at",
  "accepted_at",
  "declined_at",
  "created_at",
  "quote_number",
  "visible_to_trades",
  "storage_url",
  "file_name",
  "uploaded_by",
  "job_contact_id",
  "run_label",
  "metadata",
  "quote_revision_id",
  "superseded_at",
  "superseded_by_revision_id",
  "html_url",
  "attendance_cycle_id",
  "cycle_attribution",
  "makesafe_fact_version",
  "makesafe_content_hash",
  "trade_pack_json",
] as const;
const SERVICE_REPORT_COLUMNS = [
  "id",
  "job_id",
  "submitted_by",
  "checklist_json",
  "notes",
  "signature_data",
  "status",
  "submitted_at",
  "created_at",
  "updated_at",
  "weather",
  "start_time",
  "end_time",
  "variations",
  "cycle_number",
  "attendance_cycle_id",
  "cycle_attribution",
  "makesafe_fact_version",
  "makesafe_content_hash",
] as const;
const ROOF_REPORT_COLUMNS = [
  "id",
  "org_id",
  "job_id",
  "pack_kind",
  "template_version",
  "fields_json",
  "storey",
  "status",
  "report_doc_id",
  "last_render_hash",
  "submitted_cycle",
  "submitted_by",
  "submitted_at",
  "created_by",
  "created_at",
  "updated_at",
] as const;

type Row = Record<string, unknown>;
interface InsuranceReadQueryResult {
  data: Row[] | null;
  error: unknown;
}

export interface InsuranceReadQuery
  extends PromiseLike<InsuranceReadQueryResult> {
  select(columns: string): InsuranceReadQuery;
  eq(column: string, value: unknown): InsuranceReadQuery;
  gt(column: string, value: unknown): InsuranceReadQuery;
  order(column: string, options?: { ascending?: boolean }): InsuranceReadQuery;
  limit(count: number): InsuranceReadQuery;
}

export interface InsuranceReadDeps {
  from(table: string): InsuranceReadQuery;
  storageProjectUrl: string;
  storageBearerToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  documentFetchTimeoutMs?: number;
  defaultOrgId?: string;
}

export interface InsuranceReadAuth {
  mode: "api_key" | "jwt" | "routine" | "agent_read" | "none";
  orgId?: string | null;
  role?: string | null;
  serverSecretPresented?: boolean;
}

export interface InsuranceReadResult {
  status: number;
  body: Record<string, unknown>;
}

class InsuranceReadError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function errorResult(error: InsuranceReadError): InsuranceReadResult {
  return {
    status: error.status,
    body: {
      ...error.details,
      ok: false,
      code: error.code,
      error: error.message,
    },
  };
}

function genericFailure(code: string, status = 502): InsuranceReadResult {
  return {
    status,
    body: {
      ok: false,
      code,
      error: status === 400
        ? "The request could not be read"
        : "The requested stored evidence could not be read",
    },
  };
}

function oneParam(
  params: URLSearchParams,
  key: string,
): string | null {
  const values = params.getAll(key);
  if (values.length > 1) {
    throw new InsuranceReadError(
      "INVALID_QUERY",
      400,
      "Repeated query parameters are not supported",
    );
  }
  return values.length ? values[0] : null;
}

function assertAllowedParams(
  params: URLSearchParams,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed);
  for (const key of params.keys()) {
    if (!allowedSet.has(key)) {
      throw new InsuranceReadError(
        "INVALID_QUERY",
        400,
        "The read request contains an unsupported selector",
      );
    }
  }
}

function exactUuid(value: string | null, field: string): string {
  const trimmed = String(value || "").trim();
  if (!UUID.test(trimmed)) {
    throw new InsuranceReadError(
      "INVALID_SELECTOR",
      400,
      "A complete " + field + " UUID is required",
    );
  }
  return trimmed.toLowerCase();
}

function parsePageSize(value: string | null): number {
  if (value === null || value === "") return INSURANCE_READ_DEFAULT_PAGE_SIZE;
  if (!/^[0-9]+$/.test(value)) {
    throw new InsuranceReadError(
      "INVALID_PAGE_SIZE",
      400,
      "page_size must be an integer from 1 to 100",
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > INSURANCE_READ_MAX_PAGE_SIZE
  ) {
    throw new InsuranceReadError(
      "INVALID_PAGE_SIZE",
      400,
      "page_size must be an integer from 1 to 100",
    );
  }
  return parsed;
}

function parseMaxBytes(value: string | null): number {
  if (value === null || value === "") return INSURANCE_READ_DEFAULT_MAX_BYTES;
  if (!/^[0-9]+$/.test(value)) {
    throw new InsuranceReadError(
      "INVALID_MAX_BYTES",
      400,
      "max_bytes must be an integer from 1 to 10485760",
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > INSURANCE_READ_MAX_BYTES
  ) {
    throw new InsuranceReadError(
      "INVALID_MAX_BYTES",
      400,
      "max_bytes must be an integer from 1 to 10485760",
    );
  }
  return parsed;
}

interface Cursor {
  v: 1;
  action: string;
  org: string;
  job: string;
  id: string;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/g,
    "",
  );
}

function decodeBase64Url(value: string): string {
  if (
    !value ||
    value.length > CURSOR_MAX_LENGTH ||
    !CURSOR_CHARS.test(value)
  ) {
    throw new InsuranceReadError(
      "INVALID_CURSOR",
      400,
      "The pagination cursor is invalid",
    );
  }
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new InsuranceReadError(
      "INVALID_CURSOR",
      400,
      "The pagination cursor is invalid",
    );
  }
}

function cursorFor(
  action: string,
  org: string,
  job: string,
  value: string | null,
): Cursor | null {
  if (!value) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof InsuranceReadError) throw error;
    throw new InsuranceReadError(
      "INVALID_CURSOR",
      400,
      "The pagination cursor is invalid",
    );
  }
  const candidate = decoded as Partial<Cursor> | null;
  if (
    !candidate ||
    candidate.v !== 1 ||
    candidate.action !== action ||
    candidate.org !== org ||
    candidate.job !== job ||
    typeof candidate.id !== "string" ||
    !UUID.test(candidate.id)
  ) {
    throw new InsuranceReadError(
      "INVALID_CURSOR",
      400,
      "The pagination cursor is not valid for this organisation, job, or read",
    );
  }
  return {
    v: 1,
    action,
    org,
    job,
    id: candidate.id.toLowerCase(),
  };
}

function makeCursor(cursor: Cursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

function currentTime(deps: InsuranceReadDeps): string {
  const date = deps.now ? deps.now() : new Date();
  return date.toISOString();
}

function operatorOrg(
  deps: InsuranceReadDeps,
  auth: InsuranceReadAuth,
): string {
  if (auth.mode === "api_key" && auth.serverSecretPresented === true) {
    const org = String(deps.defaultOrgId || INSURANCE_READ_DEFAULT_ORG)
      .trim().toLowerCase();
    if (UUID.test(org)) return org;
  }
  if (
    auth.mode === "jwt" &&
    OPERATOR_ROLES.has(String(auth.role || "").toLowerCase())
  ) {
    const org = String(auth.orgId || "").trim().toLowerCase();
    if (UUID.test(org)) return org;
  }
  throw new InsuranceReadError(
    "OPERATOR_ACCESS_REQUIRED",
    403,
    "An authorised operator or server connection is required",
  );
}

function parseListRequest(
  params: URLSearchParams,
  action: string,
) {
  assertAllowedParams(params, ["action", "job_id", "page_size", "cursor"]);
  const suppliedAction = oneParam(params, "action");
  if (suppliedAction !== null && suppliedAction !== action) {
    throw new InsuranceReadError(
      "INVALID_ACTION",
      400,
      "The requested read action is invalid",
    );
  }
  const jobId = exactUuid(oneParam(params, "job_id"), "job_id");
  const pageSize = parsePageSize(oneParam(params, "page_size"));
  return { jobId, pageSize, cursorValue: oneParam(params, "cursor") };
}

function parseDocumentRequest(params: URLSearchParams) {
  assertAllowedParams(params, ["action", "job_id", "document_id", "max_bytes"]);
  const suppliedAction = oneParam(params, "action");
  if (suppliedAction !== null && suppliedAction !== "get_job_document") {
    throw new InsuranceReadError(
      "INVALID_ACTION",
      400,
      "The requested read action is invalid",
    );
  }
  const jobId = exactUuid(oneParam(params, "job_id"), "job_id");
  const documentId = exactUuid(
    oneParam(params, "document_id"),
    "document_id",
  );
  return {
    jobId,
    documentId,
    maxBytes: parseMaxBytes(oneParam(params, "max_bytes")),
  };
}

async function runQuery(
  query: InsuranceReadQuery,
): Promise<Row[]> {
  try {
    const result = await query;
    if (result.error || !Array.isArray(result.data)) {
      throw new InsuranceReadError(
        "READ_FAILED",
        502,
        "The stored evidence could not be read",
      );
    }
    return result.data;
  } catch (error) {
    if (error instanceof InsuranceReadError) throw error;
    throw new InsuranceReadError(
      "READ_FAILED",
      502,
      "The stored evidence could not be read",
    );
  }
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new InsuranceReadError(
      "RESPONSE_UNAVAILABLE",
      502,
      "The stored evidence response could not be encoded",
    );
  }
}

function assertJsonResponseWithinLimit(value: unknown) {
  if (jsonByteLength(value) > INSURANCE_READ_MAX_JSON_BYTES) {
    throw new InsuranceReadError(
      "RESPONSE_TOO_LARGE",
      413,
      "The stored evidence response exceeds the supported JSON limit",
    );
  }
}

async function authorizeJob(
  deps: InsuranceReadDeps,
  orgId: string,
  jobId: string,
) {
  const rows = await runQuery(
    deps.from("jobs")
      .select("id,org_id")
      .eq("org_id", orgId)
      .eq("id", jobId)
      .limit(2),
  );
  if (
    rows.length !== 1 ||
    String(rows[0].id || "").toLowerCase() !== jobId ||
    String(rows[0].org_id || "").toLowerCase() !== orgId
  ) {
    throw new InsuranceReadError(
      "JOB_NOT_FOUND",
      404,
      "Job not found in the authorised organisation",
    );
  }
}

function rowId(row: Row): string {
  const id = String(row.id || "").trim().toLowerCase();
  if (!UUID.test(id)) {
    throw new InsuranceReadError(
      "ROW_IDENTITY_MISMATCH",
      502,
      "The stored evidence row did not have a valid identity",
    );
  }
  return id;
}

function assertChildIdentity(
  rows: Row[],
  jobId: string,
  orgId: string,
  requireOrg: boolean,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = rowId(row);
    if (seen.has(id)) {
      throw new InsuranceReadError(
        "ROW_IDENTITY_MISMATCH",
        502,
        "The stored evidence contained duplicate row identities",
      );
    }
    seen.add(id);
    if (String(row.job_id || "").toLowerCase() !== jobId) {
      throw new InsuranceReadError(
        "ROW_IDENTITY_MISMATCH",
        502,
        "The stored evidence row did not belong to the requested job",
      );
    }
    if (
      requireOrg &&
      String(row.org_id || "").toLowerCase() !== orgId
    ) {
      throw new InsuranceReadError(
        "ROW_IDENTITY_MISMATCH",
        502,
        "The stored evidence row did not belong to the authorised organisation",
      );
    }
  }
}

function sanitizedRows(rows: Row[]): {
  rows: Row[];
  redactions: Array<{ row_id: string; path: string; reason: string }>;
} {
  const redactions: Array<
    { row_id: string; path: string; reason: string }
  > = [];
  const safeRows = rows.map((row) => {
    const inspected = sanitizeJobRecord(row);
    for (const path of inspected.redactedPaths) {
      redactions.push({
        row_id: String(row.id || "").toLowerCase(),
        path,
        reason: "credential_content_redacted",
      });
    }
    return inspected.job;
  });
  return { rows: safeRows, redactions };
}

async function validateRoofReportPointers(
  deps: InsuranceReadDeps,
  rows: Row[],
): Promise<Row[]> {
  const checkedAt = currentTime(deps);
  const result: Row[] = [];
  for (const row of rows) {
    const pointer = String(row.report_doc_id || "").trim().toLowerCase();
    let state = "missing";
    if (pointer) {
      state = "mismatch";
      if (UUID.test(pointer)) {
        try {
          const docs = await runQuery(
            deps.from("job_documents")
              .select("id,job_id,type")
              .eq("id", pointer)
              .eq("job_id", String(row.job_id || "").toLowerCase())
              .limit(2),
          );
          const doc = docs.length === 1 ? docs[0] : null;
          if (
            doc &&
            String(doc.id || "").toLowerCase() === pointer &&
            String(doc.job_id || "").toLowerCase() ===
              String(row.job_id || "").toLowerCase() &&
            String(doc.type || "").toLowerCase() === "roof_report"
          ) {
            state = "verified";
          } else if (!doc) {
            state = "missing";
          }
        } catch {
          state = "unverified";
        }
      }
    }
    result.push({
      ...row,
      report_pointer_status: state,
      report_pointer_checked_at: checkedAt,
    });
  }
  return result;
}

function childSource(action: string): string {
  if (action === "list_job_service_reports") return "job_service_reports";
  if (action === "list_job_roof_report_drafts") {
    return "makesafe_roof_report_drafts";
  }
  return "job_documents";
}

function pageResponse(
  action: string,
  orgId: string,
  jobId: string,
  pageSize: number,
  rows: Row[],
  snapshot: string,
  retrievedAt: string,
): Record<string, unknown> {
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const safe = sanitizedRows(pageRows);
  const nextCursor = hasMore
    ? makeCursor({
      v: 1,
      action,
      org: orgId,
      job: jobId,
      id: rowId(pageRows[pageRows.length - 1]),
    })
    : null;
  return {
    ok: true,
    contract_version: INSURANCE_READ_CONTRACT_VERSION,
    action,
    job_id: jobId,
    rows: safe.rows,
    redactions: safe.redactions,
    pagination: {
      page_size: pageSize,
      has_more: hasMore,
      next_cursor: nextCursor,
      order_by: "id asc",
      snapshot: {
        kind: "mutable",
        boundary: snapshot,
        limits: [
          "Keyset order is stable by row id.",
          "Rows can be inserted, updated, or removed between pages.",
          "This read does not claim an MVCC snapshot.",
        ],
      },
    },
    provenance: {
      source: "supabase.public." + childSource(action),
      provider_live: false,
      organisation: orgId,
      retrieved_at: retrievedAt,
      omitted_fields: [
        "share_token",
        "send_claim_token",
        "send_resend_idempotency_key",
      ],
    },
  };
}

async function listChildRows(
  deps: InsuranceReadDeps,
  action:
    | "list_job_service_reports"
    | "list_job_roof_report_drafts"
    | "list_job_documents",
  orgId: string,
  jobId: string,
  pageSize: number,
  cursorValue: string | null,
): Promise<InsuranceReadResult> {
  const retrievedAt = currentTime(deps);
  const cursor = cursorFor(action, orgId, jobId, cursorValue);
  await authorizeJob(deps, orgId, jobId);
  const table = action === "list_job_service_reports"
    ? "job_service_reports"
    : action === "list_job_roof_report_drafts"
    ? "makesafe_roof_report_drafts"
    : "job_documents";
  const columns = action === "list_job_service_reports"
    ? SERVICE_REPORT_COLUMNS
    : action === "list_job_roof_report_drafts"
    ? ROOF_REPORT_COLUMNS
    : DOCUMENT_COLUMNS;
  let query = deps.from(table)
    .select(columns.join(","))
    .eq("job_id", jobId);
  if (action === "list_job_roof_report_drafts") {
    // This table carries org_id; the other two child tables do not.
    query = query.eq("org_id", orgId);
  }
  if (cursor) query = query.gt("id", cursor.id);
  const rows = await runQuery(
    query.order("id", { ascending: true }).limit(
      pageSize + 1,
    ),
  );
  assertChildIdentity(
    rows,
    jobId,
    orgId,
    action === "list_job_roof_report_drafts",
  );
  let outputRows = rows;
  if (action === "list_job_service_reports") {
    outputRows = rows.map((row) => {
      const { signature_data, ...withoutSignature } = row;
      return {
        ...withoutSignature,
        signature_present: signature_data !== null &&
          signature_data !== undefined,
      };
    });
  }
  if (action === "list_job_roof_report_drafts") {
    outputRows = await validateRoofReportPointers(deps, rows);
  }
  const body = pageResponse(
    action,
    orgId,
    jobId,
    pageSize,
    outputRows,
    "Rows are evaluated at retrieval time; later pages are not a frozen snapshot",
    retrievedAt,
  );
  assertJsonResponseWithinLimit(body);
  return {
    status: 200,
    body,
  };
}

function assertSafePathEncoding(value: string, allowLeadingSlash: boolean) {
  let probe = value;
  for (let attempt = 0; attempt < 5; attempt++) {
    const segments = probe.split("/");
    const checkedSegments = allowLeadingSlash && segments[0] === ""
      ? segments.slice(1)
      : segments;
    if (
      !checkedSegments.length ||
      checkedSegments.some((segment) =>
        !segment || segment === "." || segment === ".."
      ) ||
      probe.includes("\\") ||
      probe.includes("?") ||
      probe.includes("#") ||
      /%(?:2f|5c)/i.test(probe) ||
      probe.includes("\u0000") ||
      [...probe].some((char) => char.charCodeAt(0) < 32)
    ) {
      throw new InsuranceReadError(
        "DOCUMENT_STORAGE_REFERENCE_INVALID",
        502,
        "The stored document reference is invalid",
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(probe);
    } catch {
      throw new InsuranceReadError(
        "DOCUMENT_STORAGE_REFERENCE_INVALID",
        502,
        "The stored document reference is invalid",
      );
    }
    if (decoded === probe) return;
    probe = decoded;
  }
  throw new InsuranceReadError(
    "DOCUMENT_STORAGE_REFERENCE_INVALID",
    502,
    "The stored document reference is invalid",
  );
}

function validateRelativeStoragePath(value: string): string {
  if (
    !value || value.startsWith("/") || value.includes("\\") ||
    value.includes("?") || value.includes("#")
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  assertSafePathEncoding(value, false);
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    decoded.includes("\u0000") ||
    [...decoded].some((char) => char.charCodeAt(0) < 32) ||
    decoded.split("/").some((segment) =>
      !segment || segment === "." ||
      segment === ".."
    )
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  if (!decoded) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  return decoded;
}

interface DocumentStorageReference {
  bucket: InsuranceReadStorageBucket;
  path: string;
}

function invalidStorageReference(): never {
  throw new InsuranceReadError(
    "DOCUMENT_STORAGE_REFERENCE_INVALID",
    502,
    "The stored document reference is invalid",
  );
}

function validateDocumentStorageNamespace(
  reference: DocumentStorageReference,
  orgId: string,
  jobId: string,
): DocumentStorageReference {
  if (!INSURANCE_READ_STORAGE_BUCKETS.has(reference.bucket)) {
    return invalidStorageReference();
  }
  if (
    reference.bucket === INSURANCE_READ_JOB_PDFS_BUCKET &&
    reference.path.split("/").slice(0, 2).some((segment) =>
      /%[0-9a-f]{2}/i.test(segment)
    )
  ) {
    return invalidStorageReference();
  }
  const path = validateRelativeStoragePath(reference.path);
  if (reference.bucket === INSURANCE_READ_JOB_PDFS_BUCKET) {
    const segments = path.split("/");
    // job-pdfs is the current project namespace: {org_uuid}/{job_uuid}/file.
    // Bind both parents to the already authenticated organisation and job before
    // constructing the storage URL, even though the row itself is job-scoped.
    if (
      segments.length < 3 ||
      segments[0].toLowerCase() !== orgId ||
      segments[1].toLowerCase() !== jobId
    ) {
      return invalidStorageReference();
    }
  }
  return { bucket: reference.bucket, path };
}

function relativeStorageReference(
  value: string,
  orgId: string,
  jobId: string,
): DocumentStorageReference {
  const decoded = validateRelativeStoragePath(value);
  const rawSegments = value.split("/");
  const segments = decoded.split("/");
  const first = segments[0];
  const rawFirst = rawSegments[0];
  if (
    /%[0-9a-f]{2}/i.test(rawFirst) &&
    (first.toLowerCase() === INSURANCE_READ_STORAGE_BUCKET ||
      first.toLowerCase() === INSURANCE_READ_JOB_PDFS_BUCKET ||
      UUID.test(first))
  ) {
    return invalidStorageReference();
  }
  if (
    first.toLowerCase() === INSURANCE_READ_STORAGE_BUCKET ||
    first.toLowerCase() === INSURANCE_READ_JOB_PDFS_BUCKET
  ) {
    if (first !== first.toLowerCase() || segments.length < 2) {
      return invalidStorageReference();
    }
    if (!isInsuranceReadStorageBucket(first)) {
      return invalidStorageReference();
    }
    return validateDocumentStorageNamespace(
      {
        bucket: first,
        // Keep encoded parents intact through namespace validation. The
        // decoded value is used only to classify the bucket-qualified form.
        path: rawSegments.slice(1).join("/"),
      },
      orgId,
      jobId,
    );
  }

  // Legacy job-documents rows store a job-relative path. A bare UUID/UUID/file
  // path is the current job-pdfs shape, so classify it explicitly rather than
  // silently fetching it from the legacy bucket.
  if (
    segments.length >= 2 && UUID.test(segments[0]) && UUID.test(segments[1])
  ) {
    return validateDocumentStorageNamespace(
      {
        bucket: INSURANCE_READ_JOB_PDFS_BUCKET,
        path: value,
      },
      orgId,
      jobId,
    );
  }
  return validateDocumentStorageNamespace(
    {
      bucket: INSURANCE_READ_STORAGE_BUCKET,
      path: value,
    },
    orgId,
    jobId,
  );
}

function storagePathFromReference(
  raw: string,
  configuredProjectUrl: string,
  orgId: string,
  jobId: string,
): DocumentStorageReference {
  if (!raw) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_MISSING",
      502,
      "The stored document has no usable storage reference",
    );
  }
  if (!/^https?:\/\//i.test(raw)) {
    return relativeStorageReference(raw, orgId, jobId);
  }
  const rawPathMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?$/i.exec(raw);
  if (!rawPathMatch) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  assertSafePathEncoding(rawPathMatch[1] || "/", true);
  let project: URL;
  let parsed: URL;
  try {
    project = new URL(configuredProjectUrl);
    parsed = new URL(raw);
  } catch {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    project.protocol !== "https:" ||
    parsed.origin !== project.origin ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  const prefix = "/storage/v1/object/";
  if (!parsed.pathname.startsWith(prefix)) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The stored document reference is invalid",
    );
  }
  const remainder = parsed.pathname.slice(prefix.length);
  const bucketPrefix =
    /^(?:public|authenticated|sign)\/(job-documents|job-pdfs)\/(.+)$/.exec(
      remainder,
    );
  if (!bucketPrefix) {
    return invalidStorageReference();
  }
  if (!isInsuranceReadStorageBucket(bucketPrefix[1])) {
    return invalidStorageReference();
  }
  return validateDocumentStorageNamespace(
    {
      bucket: bucketPrefix[1],
      path: bucketPrefix[2],
    },
    orgId,
    jobId,
  );
}

function documentStorageReference(
  row: Row,
  configuredProjectUrl: string,
  orgId: string,
  jobId: string,
): DocumentStorageReference {
  const references = [
    typeof row.storage_url === "string" ? row.storage_url.trim() : "",
    typeof row.pdf_url === "string" ? row.pdf_url.trim() : "",
  ].filter(Boolean);
  if (!references.length) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_MISSING",
      502,
      "The stored document has no usable storage reference",
    );
  }
  const paths = references.map((reference) =>
    storagePathFromReference(reference, configuredProjectUrl, orgId, jobId)
  );
  if (
    paths.some((reference) =>
      reference.bucket !== paths[0].bucket || reference.path !== paths[0].path
    )
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_AMBIGUOUS",
      502,
      "The stored document has conflicting storage references",
    );
  }
  return paths[0];
}

function canonicalStorageUrl(
  projectUrl: string,
  reference: DocumentStorageReference,
): string {
  let project: URL;
  try {
    project = new URL(projectUrl);
  } catch {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The current storage project is not configured",
    );
  }
  if (
    project.protocol !== "https:" || project.username || project.password ||
    project.search || project.hash
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      502,
      "The current storage project is not configured",
    );
  }
  if (!INSURANCE_READ_STORAGE_BUCKETS.has(reference.bucket)) {
    return invalidStorageReference();
  }
  const encodedPath = reference.path.split("/").map(encodeURIComponent).join(
    "/",
  );
  return project.origin + "/storage/v1/object/authenticated/" +
    reference.bucket + "/" + encodedPath;
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  deadlineAt: number,
  controller: AbortController,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (!response.body) {
    let bytes: ArrayBuffer;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const remaining = Math.max(1, deadlineAt - Date.now());
      bytes = await Promise.race([
        response.arrayBuffer(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() =>
            reject(
              new InsuranceReadError(
                "DOCUMENT_FETCH_TIMEOUT",
                504,
                "The stored document read timed out",
              ),
            ), remaining);
        }),
      ]);
    } catch (error) {
      if (error instanceof InsuranceReadError) throw error;
      throw new InsuranceReadError(
        "DOCUMENT_BYTES_UNAVAILABLE",
        502,
        "The stored document bytes could not be read",
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (bytes.byteLength > maxBytes) {
      throw new InsuranceReadError(
        "DOCUMENT_TOO_LARGE",
        413,
        "The stored document exceeds the requested byte limit",
      );
    }
    return new Uint8Array(bytes);
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          throw new InsuranceReadError(
            "DOCUMENT_FETCH_TIMEOUT",
            504,
            "The stored document read timed out",
          );
        }
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() =>
              reject(
                new InsuranceReadError(
                  "DOCUMENT_FETCH_TIMEOUT",
                  504,
                  "The stored document read timed out",
                ),
              ), remaining);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new InsuranceReadError(
          "DOCUMENT_TOO_LARGE",
          413,
          "The stored document exceeds the requested byte limit",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    controller.abort();
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // Cancellation is best effort; the original bounded-read error wins.
    }
    if (error instanceof InsuranceReadError) throw error;
    throw new InsuranceReadError(
      "DOCUMENT_BYTES_UNAVAILABLE",
      502,
      "The stored document bytes could not be read",
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary);
}

function responseMime(
  response: Response,
  row: Row,
  bytes: Uint8Array,
): string {
  const header = response.headers.get("content-type")?.split(";")[0].trim()
    .toLowerCase() || "";
  const fileName = String(row.file_name || "").toLowerCase();
  const documentType = String(row.type || "").toLowerCase();
  const requiresPdf = fileName.endsWith(".pdf") ||
    ["roof_report", "makesafe_report", "work_order", "invoice", "swms"]
      .includes(
        documentType,
      );
  const inferred = fileName.endsWith(".pdf")
    ? "application/pdf"
    : "application/octet-stream";
  const mime = header || inferred;
  if (
    mime === "text/html" ||
    mime === "text/plain" ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime.includes("javascript")
  ) {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_UNSUPPORTED",
      502,
      "The stored document returned an unsupported media type",
    );
  }
  const startsWith = (values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  const detected = startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])
    ? "application/pdf"
    : startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? "image/png"
    : startsWith([0xff, 0xd8, 0xff])
    ? "image/jpeg"
    : startsWith([0x47, 0x49, 0x46, 0x38])
    ? "image/gif"
    : startsWith([0x52, 0x49, 0x46, 0x46]) &&
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    ? "image/webp"
    : null;
  if (detected && mime !== "application/octet-stream" && mime !== detected) {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_MISMATCH",
      502,
      "The stored document bytes did not match their media type",
    );
  }
  if (mime === "application/pdf" && detected !== "application/pdf") {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_MISMATCH",
      502,
      "The stored document bytes did not match their media type",
    );
  }
  if (requiresPdf && detected !== "application/pdf") {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_MISMATCH",
      502,
      "The stored document bytes did not match their media type",
    );
  }
  if (mime.startsWith("image/") && detected && mime !== detected) {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_MISMATCH",
      502,
      "The stored document bytes did not match their media type",
    );
  }
  if (!detected) {
    throw new InsuranceReadError(
      "DOCUMENT_MIME_UNKNOWN",
      502,
      "The stored document bytes had no supported signature",
    );
  }
  return detected;
}

async function fetchDocumentBytes(
  deps: InsuranceReadDeps,
  row: Row,
  maxBytes: number,
  reference: DocumentStorageReference,
): Promise<{ bytes: Uint8Array; sha256: string; mime: string }> {
  const url = canonicalStorageUrl(deps.storageProjectUrl, reference);
  if (!deps.storageBearerToken?.trim()) {
    throw new InsuranceReadError(
      "DOCUMENT_STORAGE_AUTH_UNAVAILABLE",
      503,
      "The configured document storage connection is unavailable",
    );
  }
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = Math.max(
    1,
    Math.min(30_000, Math.floor(deps.documentFetchTimeoutMs || 10_000)),
  );
  const deadlineAt = Date.now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          // The storage gateway identifies the calling Supabase project with
          // apikey. Keep the server credential in Authorization as well so
          // private-bucket RLS is evaluated with the same service identity.
          apikey: deps.storageBearerToken,
          Authorization: "Bearer " + deps.storageBearerToken,
          Accept: "application/pdf,application/octet-stream,*/*",
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (Date.now() >= deadlineAt) {
        throw new InsuranceReadError(
          "DOCUMENT_FETCH_TIMEOUT",
          504,
          "The stored document read timed out",
        );
      }
      throw new InsuranceReadError(
        "DOCUMENT_FETCH_FAILED",
        502,
        "The stored document could not be fetched",
      );
    }
    const responseUrlMismatch = Boolean(response.url && response.url !== url);
    if (
      response.redirected || response.status !== 200 || !response.ok ||
      responseUrlMismatch
    ) {
      const failureReason = response.redirected
        ? "redirected_response"
        : responseUrlMismatch
        ? "response_url_mismatch"
        : "unexpected_http_status";
      throw new InsuranceReadError(
        "DOCUMENT_FETCH_FAILED",
        502,
        "The stored document could not be fetched",
        {
          // Safe provider diagnostics only. Never reflect the URL, headers,
          // response body, or any credential-bearing value.
          provider_status: response.status,
          provider_failure_reason: failureReason,
        },
      );
    }
    const encoding = response.headers.get("content-encoding")?.trim()
      .toLowerCase();
    if (encoding && encoding !== "identity") {
      throw new InsuranceReadError(
        "DOCUMENT_ENCODING_UNSUPPORTED",
        502,
        "The stored document used an unsupported content encoding",
      );
    }
    const lengthHeader = response.headers.get("content-length");
    let declaredLength: number | null = null;
    if (lengthHeader !== null) {
      if (!/^[0-9]+$/.test(lengthHeader.trim())) {
        throw new InsuranceReadError(
          "DOCUMENT_LENGTH_INVALID",
          502,
          "The stored document length was invalid",
        );
      }
      declaredLength = Number(lengthHeader.trim());
      if (!Number.isSafeInteger(declaredLength)) {
        throw new InsuranceReadError(
          "DOCUMENT_LENGTH_INVALID",
          502,
          "The stored document length was invalid",
        );
      }
      if (declaredLength > maxBytes) {
        throw new InsuranceReadError(
          "DOCUMENT_TOO_LARGE",
          413,
          "The stored document exceeds the requested byte limit",
        );
      }
    }
    const bytes = await readResponseBytes(
      response,
      maxBytes,
      deadlineAt,
      controller,
    );
    if (bytes.byteLength === 0) {
      throw new InsuranceReadError(
        "DOCUMENT_BYTES_EMPTY",
        502,
        "The stored document had no bytes",
      );
    }
    if (declaredLength !== null && declaredLength !== bytes.byteLength) {
      throw new InsuranceReadError(
        "DOCUMENT_LENGTH_MISMATCH",
        502,
        "The stored document length did not match its bytes",
      );
    }
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        bytes as unknown as BufferSource,
      ),
    );
    const sha256 = Array.from(digest).map((value) =>
      value.toString(16).padStart(2, "0")
    ).join("");
    return { bytes, sha256, mime: responseMime(response, row, bytes) };
  } finally {
    clearTimeout(timeout);
  }
}

function listAction(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  auth: InsuranceReadAuth,
  action:
    | "list_job_service_reports"
    | "list_job_roof_report_drafts"
    | "list_job_documents",
): Promise<InsuranceReadResult> {
  const orgId = operatorOrg(deps, auth);
  if (params.has("org_id")) {
    throw new InsuranceReadError(
      "INVALID_QUERY",
      400,
      "The organisation is taken from the verified caller",
    );
  }
  const request = parseListRequest(params, action);
  return listChildRows(
    deps,
    action,
    orgId,
    request.jobId,
    request.pageSize,
    request.cursorValue,
  );
}

export function listJobServiceReports(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  auth: InsuranceReadAuth,
): Promise<InsuranceReadResult> {
  return listAction(deps, params, auth, "list_job_service_reports");
}

export function listJobRoofReportDrafts(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  auth: InsuranceReadAuth,
): Promise<InsuranceReadResult> {
  return listAction(deps, params, auth, "list_job_roof_report_drafts");
}

export function listJobDocuments(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  auth: InsuranceReadAuth,
): Promise<InsuranceReadResult> {
  return listAction(deps, params, auth, "list_job_documents");
}

export async function getJobDocument(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  auth: InsuranceReadAuth,
): Promise<InsuranceReadResult> {
  const orgId = operatorOrg(deps, auth);
  if (params.has("org_id")) {
    throw new InsuranceReadError(
      "INVALID_QUERY",
      400,
      "The organisation is taken from the verified caller",
    );
  }
  const request = parseDocumentRequest(params);
  await authorizeJob(deps, orgId, request.jobId);
  const rows = await runQuery(
    deps.from("job_documents")
      .select(DOCUMENT_COLUMNS.join(","))
      .eq("job_id", request.jobId)
      .eq("id", request.documentId)
      .limit(2),
  );
  if (rows.length !== 1) {
    throw new InsuranceReadError(
      "DOCUMENT_NOT_FOUND",
      404,
      "Document not found in the authorised organisation",
    );
  }
  const row = rows[0];
  if (
    rowId(row) !== request.documentId ||
    String(row.job_id || "").toLowerCase() !== request.jobId
  ) {
    throw new InsuranceReadError(
      "ROW_IDENTITY_MISMATCH",
      502,
      "The stored document row did not match the requested identity",
    );
  }
  const storageReference = documentStorageReference(
    row,
    deps.storageProjectUrl,
    orgId,
    request.jobId,
  );
  const storagePath = storageReference.path;
  const inspected = sanitizeJobRecord({ ...row, storage_path: storagePath });
  const safeDocument = inspected.job;
  // These fields are excluded by the projection; retain this defense if the
  // projection is widened later.
  delete safeDocument.share_token;
  delete safeDocument.send_claim_token;
  delete safeDocument.send_resend_idempotency_key;
  assertJsonResponseWithinLimit(safeDocument);
  const fetched = await fetchDocumentBytes(
    deps,
    row,
    request.maxBytes,
    storageReference,
  );
  return {
    status: 200,
    body: {
      ok: true,
      contract_version: INSURANCE_READ_CONTRACT_VERSION,
      action: "get_job_document",
      document: safeDocument,
      content: {
        base64: base64Bytes(fetched.bytes),
        sha256: fetched.sha256,
        mime_type: fetched.mime,
        byte_size: fetched.bytes.byteLength,
        original_bytes: true,
        transformed: false,
      },
      provenance: {
        source: "supabase.public.job_documents",
        provider_live: false,
        organisation: orgId,
        retrieved_at: currentTime(deps),
        storage_bucket: storageReference.bucket,
        storage_path: safeDocument.storage_path,
        redacted_paths: inspected.redactedPaths,
        redactions: inspected.redactedPaths.map((path) => ({
          path,
          reason: "credential_content_redacted",
        })),
        omitted_fields: [
          "share_token",
          "send_claim_token",
          "send_resend_idempotency_key",
          "signature_data",
        ],
        mutable_data_limit:
          "Metadata and bytes were read at different points if the row changed during retrieval",
      },
    },
  };
}

export async function insuranceReadAction(
  deps: InsuranceReadDeps,
  params: URLSearchParams,
  method: string,
  auth: InsuranceReadAuth,
): Promise<InsuranceReadResult> {
  try {
    const action = oneParam(params, "action");
    if (!action) return genericFailure("INVALID_ACTION", 400);
    // Authenticate before method dispatch, matching _readJobRecordAction.
    operatorOrg(deps, auth);
    if (method !== "GET") return genericFailure("METHOD_NOT_ALLOWED", 405);
    switch (action) {
      case "list_job_service_reports":
        return await listJobServiceReports(deps, params, auth);
      case "list_job_roof_report_drafts":
        return await listJobRoofReportDrafts(deps, params, auth);
      case "list_job_documents":
        return await listJobDocuments(deps, params, auth);
      case "get_job_document":
        return await getJobDocument(deps, params, auth);
      default:
        return genericFailure("INVALID_ACTION", 400);
    }
  } catch (error) {
    if (error instanceof InsuranceReadError) return errorResult(error);
    return genericFailure("READ_FAILED");
  }
}

// Stable aliases for focused tests and the entrypoint integration.
export const _listJobServiceReports = listJobServiceReports;
export const _listJobRoofReportDrafts = listJobRoofReportDrafts;
export const _listJobDocuments = listJobDocuments;
export const _getJobDocument = getJobDocument;
