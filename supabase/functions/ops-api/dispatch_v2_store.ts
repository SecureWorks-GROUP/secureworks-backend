// deno-lint-ignore-file no-explicit-any
// Dispatch v2 (slices 5 and 6): the draft list, the supplier boxes, photos,
// and the supplier order email sent from admin@ through Outlook.
// Contract: docs/dispatch-v2-emails-contract.md. Rules: dispatch_v2_emails.ts.
//
// What this touches:
//   reads   jobs (one job), suppliers (names, active), the approved supplier
//           order email list and its links
//   writes  job_material_lines, job_material_suppliers, dispatch_material_photos,
//           dispatch_supplier_order_emails, the private bucket
//           dispatch-material-photos, and one job_events row (the audit
//           line, dispatch_v2_date_mode_set) when Make email changes a box's
//           ASAP or Pick a date choice (piece C)
//   sends   one email per real press of Send now (or Send test), through the
//           injected sender (production: send-outlook-email, from admin@).
// Never jobs, suppliers.email, purchase_orders, Xero, business_events, GHL or
// any SMS, and no other job_events row.
//
// v2 has no purchase orders. The v1 actions (dispatch_materials_*,
// dispatch_order_*) are left as they were; the v2 screen calls these instead.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`. A failed read is never "nothing there".

import { assertJobDepositsBeforeWork } from "./job_start_deposits.ts";
import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
} from "./dispatch_materials_store.ts";
import {
  cleanDispatchDescription,
  cleanDispatchQuantity,
  cleanDispatchStatus,
  cleanDispatchUnit,
  DISPATCH_MATERIAL_LINES_PER_JOB_MAX,
  dispatchSuggestedLines,
  type DispatchSuggestedLine,
  isDispatchUuid,
} from "./dispatch_materials.ts";
import {
  DISPATCH_FAMILY_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";
import {
  cleanDispatchV2EmailList,
  DISPATCH_V2_FROM_MAILBOX,
  DISPATCH_V2_PHOTO_BUCKET,
  DISPATCH_V2_PHOTO_LINK_SECONDS,
  DISPATCH_V2_PHOTOS_PER_EMAIL_MAX,
  DISPATCH_V2_PHOTOS_PER_JOB_MAX,
  DISPATCH_V2_STALE_SENDING_MS,
  DISPATCH_V2_TEST_TO,
  dispatchV2BodyHtml,
  dispatchV2BuildEmail,
  type DispatchV2DateMode,
  dispatchV2DateModeParam,
  dispatchV2FulfilmentOf,
  dispatchV2FulfilmentParam,
  dispatchV2BytesToBase64,
  dispatchV2CanSuggest,
  dispatchV2CheckPhoto,
  dispatchV2DefaultCc,
  dispatchV2EmailHasSomethingToOrder,
  dispatchV2EmptyDetailLines,
  dispatchV2MainSupplierId,
  dispatchV2OrderableLines,
  dispatchV2PhotoFileName,
  dispatchV2SameLines,
  dispatchV2Sha256Hex,
  dispatchV2SuggestionAllowed,
  dispatchV2TeamCc,
  dispatchV2TestEmail,
  dispatchV2UnsentPhotoIds,
  isDispatchV2Date,
} from "./dispatch_v2_emails.ts";
import {
  dispatchV2FenceLinesFromScope,
  type DispatchV2FenceLine,
  dispatchV2MatchScopeSupplier,
  dispatchV2ScopeSupplierName,
} from "./dispatch_v2_fence_scope.ts";
import {
  readDispatchV2FrozenScope,
  readDispatchV2LatestFrozen,
  readDispatchV2OrderRevision,
} from "./dispatch_v2_sealed_scope.ts";
import {
  isScopeEnginePatioRecord,
  scopeEngineSealedLines,
} from "./scope_engine_materials.ts";
import { fetchAllRows } from "./makesafe_compact_reads.ts";
import { takenQuoteOptionOrderItems } from "./dispatch_quote_options.ts";
// Tweak 4: the supplier picker rules and the name a box shows.
import {
  dispatchV2BuildSupplierPicker,
  dispatchV2MainReason,
  dispatchV2RankLinkedContacts,
  dispatchV2SupplierDisplayName,
} from "./dispatch_v2_supplier_picker.ts";
import {
  dispatchV2BoxDateMode,
  dispatchV2BoxStage,
} from "./dispatch_v2_material_stage.ts";
import { dispatchV2PaymentTerms } from "./dispatch_v2_payment.ts";
import {
  loadDispatchInstall,
  loadDispatchV2MatchedReplies,
  perthDayOf,
} from "./dispatch_board.ts";

// ── The send seam ───────────────────────────────────────────────────────────

// What the sender is asked to send. Production posts exactly this to
// send-outlook-email (dispatch_v2_send.ts); tests pass a fake.
export type DispatchV2OutlookPayload = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  htmlBody: string;
  // Shaun's signature on every order email, the real send and the TEST
  // copy alike (Shaun, 29 Oct 2026: "Always use my sign"). send-outlook-email
  // renders "shaun" from admin@ as Kind regards, the logo, Shaun Lee,
  // Operations Coordinator, 0489 267 771 and admin@secureworkswa.com.au.
  signature: "shaun";
  // Ask send-outlook-email for the sent message's ids.
  capture_thread_ids: true;
  attachments: { name: string; contentType: string; contentBytes: string }[];
};

export type DispatchV2SentIds = {
  graph_message_id: string | null;
  internet_message_id: string | null;
  conversation_id: string | null;
};

export type DispatchV2SendOutcome =
  // Outlook took it.
  | { kind: "sent"; ids: DispatchV2SentIds }
  // It did not go (refused before sending). Safe to try again.
  | { kind: "refused"; reason: string }
  // We cannot tell whether it went.
  | { kind: "unknown"; reason: string; ids: DispatchV2SentIds | null };

export type DispatchV2Sender = (
  payload: DispatchV2OutlookPayload,
) => Promise<DispatchV2SendOutcome>;

export type DispatchV2Context = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // ops-api's extractMaterialsFromScope, always called with null pricing.
  extractMaterialsFromScope: (scopeJson: unknown, pricingJson: null) => any[];
  sender: DispatchV2Sender;
  now?: () => string;
  // RQ-19.e: no supplier order goes out until every paying party has
  // accepted and paid (or the owner or office recorded an override). Tests
  // may replace it; production always runs the real gate.
  depositGate?: (client: any, jobId: string, purpose: "materials") => Promise<void>;
};

export const DISPATCH_V2_READ_ACTIONS = [
  "dispatch_v2_materials",
  "dispatch_v2_supplier_search",
  "dispatch_v2_photo_url",
] as const;

export const DISPATCH_V2_WRITE_ACTIONS = [
  "dispatch_v2_save_line",
  "dispatch_v2_move_line",
  "dispatch_v2_delete_line",
  "dispatch_v2_suggest_draft",
  "dispatch_v2_add_supplier",
  "dispatch_v2_remove_supplier",
  "dispatch_v2_set_main_supplier",
  "dispatch_v2_upload_photo",
  "dispatch_v2_move_photo",
  "dispatch_v2_delete_photo",
  "dispatch_v2_make_email",
  "dispatch_v2_save_email",
  "dispatch_v2_discard_email",
  "dispatch_v2_send_email",
] as const;

export const DISPATCH_V2_ACTIONS = [
  ...DISPATCH_V2_READ_ACTIONS,
  ...DISPATCH_V2_WRITE_ACTIONS,
] as const;

// source_kind, source_version_id, source_version, source_line_id: the line's
// provenance (production migration 20261019200000); a scope fill writes the
// sealed scope revision and the engine's own line there (T20).
const LINE_SELECT =
  "id, job_id, supplier_id, description, quantity, unit, detail, profile, colour, status, purchase_order_id, dispatch_order_email_id, source, position, updated_at, source_kind, source_version_id, source_version, source_line_id";
const SCOPE_REVISION_KINDS = new Set(["fence_scope_revision", "patio_scope_revision"]);
const BOX_SELECT =
  "id, supplier_id, supplier_name, position, is_main_supplier, created_at, delivery_date, delivery_date_set_at, delivery_date_confirmed_at, material_stage, material_stage_set_at, material_stage_set_by_email, paid_at, paid_by_email, pay_on, pay_on_set_at, pay_on_set_by_email, payment_reopened_at, order_date_mode, order_date_mode_set_at, order_date_mode_set_by_email";
const PHOTO_SELECT =
  "id, job_id, supplier_id, file_name, content_type, size_bytes, storage_path, created_at, created_by_email";
const EMAIL_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, approved_email_id, work_type, is_main_supplier, standing_lines_included, status, team_cc_email, to_emails, cc_emails, subject, body_text, built_body_text, delivery_date, order_lines, photo_ids, test_sent_at, test_sent_to, test_sent_by_email, send_claimed_at, sent_at, sent_by_email, sent_from_mailbox, sent_to_emails, sent_cc_emails, sent_internet_message_id, sent_conversation_id, sent_graph_message_id, last_error, created_at, created_by_email, updated_at, updated_by_email, origin";
// origin: migration 20261105170000_dispatch_v2_outlook_orders.sql ('outlook'
// = recorded from an order Shaun sent from Outlook, contract section 3f.1).
// on_account: migration 20261029120000_dispatch_v2_on_account_suppliers.sql
// (the payment step, dispatch_v2_payment.ts).
const APPROVED_SELECT =
  "id, name, used_for, to_emails, cc_emails, active, on_account";
const JOB_SELECT =
  "id, org_id, job_number, type, client_name, client_phone, site_address, site_suburb, " +
  DISPATCH_FAMILY_PROJECTION.join(", ");

const OPEN_EMAIL_STATUSES = ["draft", "sending", "send_unknown"];
const DETAIL_MAX = 300;
const PROFILE_MAX = 80;
const SUBJECT_MAX = 250;
const BODY_MAX = 20000;

// ── Small helpers ───────────────────────────────────────────────────────────

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchMaterialsError(status, code, message, extra);
}

function badRequest(message: string): never {
  refuse(400, "invalid_request", message);
}

function readFailed(label: string, error: any): never {
  console.error(`[dispatch_v2] ${label} failed:`, error);
  refuse(500, "dispatch_read_failed", `${label} failed`);
}

function writeFailed(label: string, error: any): never {
  console.error(`[dispatch_v2] ${label} failed:`, error);
  refuse(500, "dispatch_write_failed", `${label} failed`);
}

function errorCode(error: any): string {
  return String(error?.code || "");
}

function nowIso(ctx: DispatchV2Context): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function field<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  if (!result.ok) badRequest(result.error);
  return result.value;
}

function optionalText(
  value: unknown,
  name: string,
  max: number,
  { multiline = false } = {},
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") badRequest(`${name} must be text or null`);
  const trimmed = multiline
    ? value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(
      "\n",
    )
    : value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    badRequest(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function supplierIdOrNull(value: unknown, name = "supplier_id"): string | null {
  if (value === null) return null;
  if (!isDispatchUuid(value)) {
    badRequest(`${name} must be a uuid, or null for the draft list`);
  }
  return value;
}

function expectedStamp(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) badRequest("expected_updated_at required");
    return null;
  }
  if (typeof value !== "string" || !value) {
    badRequest("expected_updated_at must be a timestamp");
  }
  return value;
}

function senderEmail(ctx: DispatchV2Context): string {
  if (!ctx.actor.email) {
    refuse(
      400,
      "operator_email_required",
      "Say who is sending: operator_email is required with the ops key",
    );
  }
  return ctx.actor.email;
}

// ── The job ─────────────────────────────────────────────────────────────────

type V2Job = {
  id: string;
  org_id: string;
  job_number: string | null;
  work_type: string;
  client_name: string | null;
  client_phone: string | null;
  site_address: string | null;
  site_suburb: string | null;
};

async function loadJob(
  client: any,
  jobIdInput: unknown,
  ctx: DispatchV2Context,
): Promise<V2Job> {
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
  // Repair wins over the stored type, by the Dispatch list's own rule.
  const workType = dispatchWorkType(job);
  if (workType === "makesafe") {
    refuse(
      409,
      "not_dispatch_work",
      "Supplier orders are not offered on a make-safe job",
    );
  }
  return {
    id: job.id,
    org_id: job.org_id,
    job_number: job.job_number ?? null,
    work_type: workType,
    client_name: job.client_name ?? null,
    client_phone: job.client_phone ?? null,
    site_address: job.site_address ?? null,
    site_suburb: job.site_suburb ?? null,
  };
}

function bodyJobId(body: any): unknown {
  return body?.job_id ?? body?.jobId;
}

// ── Reads shared by the actions ─────────────────────────────────────────────

async function readJobLines(client: any, jobId: string): Promise<any[]> {
  // Never capped: paged past PostgREST's 1000-row ceiling.
  try {
    return await fetchAllRows<any>(
      () =>
        client.from("job_material_lines")
          .select(LINE_SELECT)
          .eq("job_id", jobId)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true }),
      "dispatch_v2.lines",
      "id",
    );
  } catch (error) {
    readFailed("lines read", error);
  }
}

async function readBoxes(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("job_material_suppliers")
    .select(BOX_SELECT)
    .eq("job_id", jobId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) readFailed("supplier boxes read", error);
  return data || [];
}

async function readBox(client: any, jobId: string, supplierId: string) {
  const { data, error } = await client.from("job_material_suppliers")
    .select(BOX_SELECT)
    .eq("job_id", jobId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (error) readFailed("supplier box read", error);
  return data || null;
}

async function readLine(client: any, id: string) {
  const { data, error } = await client.from("job_material_lines")
    .select(LINE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) readFailed("line read", error);
  return data || null;
}

async function readPhotos(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("dispatch_material_photos")
    .select(PHOTO_SELECT)
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) readFailed("photos read", error);
  return data || [];
}

/** True when an order Shaun sent from Outlook was recorded on the job. */
async function hasOutlookOrder(client: any, jobId: string): Promise<boolean> {
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select("id")
    .eq("job_id", jobId)
    .eq("origin", "outlook")
    .limit(1);
  if (error) readFailed("outlook order read", error);
  return Array.isArray(data) && data.length > 0;
}

async function readJobEmails(client: any, jobId: string): Promise<any[]> {
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select(EMAIL_SELECT)
    .eq("job_id", jobId)
    .neq("status", "discarded")
    .order("created_at", { ascending: true });
  if (error) readFailed("order emails read", error);
  return data || [];
}

async function readEmail(client: any, id: unknown, ctx: DispatchV2Context) {
  if (!isDispatchUuid(id)) badRequest("email_id must be a uuid");
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select(EMAIL_SELECT)
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("order email read", error);
  if (!data) refuse(404, "email_not_found", "That order email was not found");
  return data;
}

async function readContacts(
  client: any,
  ids: string[],
  ctx: DispatchV2Context,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (ids.length === 0) return out;
  const { data, error } = await client.from("suppliers")
    .select("id, org_id, name, is_active")
    .in("id", ids)
    .eq("org_id", ctx.orgId);
  if (error) readFailed("supplier contacts read", error);
  for (const row of data || []) out.set(String(row.id), row);
  return out;
}

// supplier id -> its approved order email entry (active entries only).
async function readApprovedFor(
  client: any,
  supplierIds: string[],
  ctx: DispatchV2Context,
): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (supplierIds.length === 0) return out;
  const { data: links, error } = await client
    .from("dispatch_approved_supplier_email_links")
    .select("supplier_id, approved_id")
    .in("supplier_id", supplierIds)
    .eq("org_id", ctx.orgId);
  if (error) readFailed("approved email links read", error);
  const approvedIds = [
    ...new Set((links || []).map((l: any) => String(l.approved_id))),
  ];
  if (approvedIds.length === 0) return out;
  const { data: entries, error: entriesError } = await client
    .from("dispatch_approved_supplier_emails")
    .select(APPROVED_SELECT)
    .in("id", approvedIds)
    .eq("org_id", ctx.orgId)
    .eq("active", true);
  if (entriesError) readFailed("approved emails read", entriesError);
  const byId = new Map<string, any>(
    (entries || []).map((e: any) => [String(e.id), e]),
  );
  for (const link of links || []) {
    const entry = byId.get(String(link.approved_id));
    if (entry) out.set(String(link.supplier_id), entry);
  }
  return out;
}

// Has anyone sent a test copy yet? Shown on the screen only: a test copy is
// optional and no longer holds back a real supplier send (Shaun, 26 Oct).
async function testSendDone(client: any, ctx: DispatchV2Context) {
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select("id")
    .eq("org_id", ctx.orgId)
    .not("test_sent_at", "is", null)
    .limit(1);
  if (error) readFailed("test send read", error);
  return Array.isArray(data) && data.length > 0;
}

// ── Projections ─────────────────────────────────────────────────────────────

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function lineLocked(row: any): boolean {
  return !!row?.dispatch_order_email_id || !!row?.purchase_order_id;
}

function scopeProvenance(row: any) {
  const scope = SCOPE_REVISION_KINDS.has(String(row?.source_kind ?? ""));
  return {
    scope_revision_id: scope ? row?.source_version_id ?? null : null,
    scope_revision_number: scope ? numberOrNull(row?.source_version) : null,
    scope_line_id: scope ? row?.source_line_id ?? null : null,
  };
}

export function projectDispatchV2Line(row: any) {
  return {
    id: row?.id,
    // null = on the draft list.
    supplier_id: row?.supplier_id ?? null,
    description: row?.description,
    quantity: numberOrNull(row?.quantity),
    unit: row?.unit ?? null,
    detail: row?.detail ?? null,
    profile: row?.profile ?? null,
    colour: row?.colour ?? null,
    status: row?.status,
    source: row?.source,
    position: row?.position,
    // T20: the sealed scope revision a scope line was filled from (its id and
    // number), and the engine's own id for the line (patio). Null on a line
    // typed in, and on lines filled before T20.
    ...scopeProvenance(row),
    // Set once the line went out on a sent order email; the line is locked.
    sent_on_email_id: row?.dispatch_order_email_id ?? null,
    locked: lineLocked(row),
    updated_at: row?.updated_at,
  };
}

function projectPhoto(row: any) {
  return {
    id: row?.id,
    supplier_id: row?.supplier_id ?? null,
    file_name: row?.file_name,
    content_type: row?.content_type,
    size_bytes: row?.size_bytes,
    added_at: row?.created_at,
    added_by_email: row?.created_by_email ?? null,
  };
}

function projectApproved(entry: any) {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    used_for: entry.used_for,
    to: entry.to_emails || [],
    cc: entry.cc_emails || [],
    // On account (no payment step) or pay first (dispatch_v2_payment.ts).
    on_account: entry.on_account === true,
  };
}

function isStaleSending(row: any, nowMs: number): boolean {
  if (row?.status !== "sending") return false;
  const claimed = Date.parse(String(row?.send_claimed_at ?? ""));
  return !Number.isFinite(claimed) ||
    nowMs - claimed > DISPATCH_V2_STALE_SENDING_MS;
}

export function projectDispatchV2Email(row: any, nowMs = Date.now()) {
  const status = isStaleSending(row, nowMs) ? "send_unknown" : row?.status;
  return {
    id: row?.id,
    job_id: row?.job_id,
    supplier_id: row?.supplier_id,
    supplier_name: row?.supplier_name,
    status,
    // Tweak 2: true for an order Shaun sent from Outlook that the reply scan
    // recorded. Always sent: never edited, sent again or discarded here.
    from_outlook: row?.origin === "outlook",
    from: DISPATCH_V2_FROM_MAILBOX,
    to: row?.to_emails || [],
    cc: row?.cc_emails || [],
    team_cc: row?.team_cc_email ?? null,
    subject: row?.subject,
    body_text: row?.body_text,
    edited: row?.body_text !== row?.built_body_text,
    delivery_date: row?.delivery_date ?? null,
    // Delivery or pickup, read from the body's opening line.
    fulfilment: dispatchV2FulfilmentOf(row?.body_text),
    is_main_supplier: row?.is_main_supplier === true,
    standing_lines_included: row?.standing_lines_included === true,
    line_count: (Array.isArray(row?.order_lines) ? row.order_lines : []).length,
    photo_ids: row?.photo_ids || [],
    empty_detail_lines: dispatchV2EmptyDetailLines(String(row?.body_text ?? "")),
    test: row?.test_sent_at
      ? {
        sent_at: row.test_sent_at,
        sent_to: row.test_sent_to,
        sent_by_email: row.test_sent_by_email ?? null,
      }
      : null,
    sent: row?.sent_at || row?.sent_conversation_id
      ? {
        sent_at: row.sent_at ?? null,
        sent_by_email: row.sent_by_email ?? null,
        from: row.sent_from_mailbox ?? null,
        to: row.sent_to_emails || [],
        cc: row.sent_cc_emails || [],
        internet_message_id: row.sent_internet_message_id ?? null,
        conversation_id: row.sent_conversation_id ?? null,
      }
      : null,
    last_error: row?.last_error ?? null,
    created_at: row?.created_at,
    updated_at: row?.updated_at,
  };
}

// ── The one read ────────────────────────────────────────────────────────────

export async function readDispatchV2Materials(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchV2Context,
) {
  const job = await loadJob(
    client,
    params.get("job_id") ?? params.get("jobId"),
    ctx,
  );
  const [boxes, lines, photos, emails, scopeFill, replies, install] =
    await Promise.all([
      readBoxes(client, job.id),
      readJobLines(client, job.id),
      readPhotos(client, job.id),
      readJobEmails(client, job.id),
      readScopeFill(client, job.id),
      // The matched supplier replies (the reply step, the board's read too).
      // A failed read never refuses the panel: no reply moves, as on the
      // board.
      loadDispatchV2MatchedReplies(client, [job.id], "dispatch_v2_materials"),
      // The install, as the board reads it: for skips_ready (a pickup on the
      // install's first day). A failed read never refuses the panel: no box
      // skips Materials ready.
      loadDispatchInstall(
        client,
        job.id,
        perthDayOf(nowIso(ctx)) ?? nowIso(ctx).slice(0, 10),
        "dispatch_v2_materials",
      ),
    ]);
  // T20: the list fills only from a frozen scope revision. Read while the
  // list is empty, when a fill can run. A failed read is unknown, never
  // frozen, so the screen's own fill waits.
  const seal = dispatchV2CanSuggest(job.work_type, lines.length)
    ? await readDispatchV2LatestFrozen(client, job.id)
    : null;
  // S08: scope lines from an older revision than the order's say so.
  const scopeChanged = await readScopeChanged(client, job, lines);
  const supplierIds = boxes.map((b) => String(b.supplier_id));
  const [contacts, approved, testDone] = await Promise.all([
    readContacts(client, supplierIds, ctx),
    readApprovedFor(client, supplierIds, ctx),
    testSendDone(client, ctx),
  ]);
  const mainId = dispatchV2MainSupplierId(boxes, lines);
  const teamCc = dispatchV2TeamCc(job.work_type);
  const nowMs = Date.parse(nowIso(ctx));
  return {
    job_id: job.id,
    job_number: job.job_number,
    work_type: job.work_type,
    team_cc: teamCc,
    from: DISPATCH_V2_FROM_MAILBOX,
    test_send_done: testDone,
    main_supplier_id: mainId,
    main_supplier_ticked: boxes.some((b) => b.is_main_supplier === true),
    // The matched supplier replies read: failed = no reply moves.
    replies_read: replies.error ? "failed" : "ok",
    can_suggest: dispatchV2CanSuggest(job.work_type, lines.length),
    // The screen fills a fencing job from the scope on its own when it opens
    // and this is true: no lines, never filled before, and the job has a
    // frozen scope revision (T20).
    // Tweak 2 (contract section 3f.1): never once Shaun's own Outlook order
    // was recorded on the job; he ordered without the list.
    auto_fill: job.work_type === "fencing" && lines.length === 0 && !scopeFill &&
      seal?.state === "frozen" && !emails.some((e) => e?.origin === "outlook"),
    // The job's latest frozen scope revision, or why there is none (null when
    // the list already has lines). The fill uses the accepted revision when
    // the job has one.
    scope_seal: seal,
    // S08: null, or the scope lines came from an older sealed revision than
    // the one the order follows now: which ones, which revision, whether Fill
    // from the scope may refill them (nothing went out), and the plain words.
    scope_changed: scopeChanged,
    scope_filled: scopeFill
      ? {
        filled_at: scopeFill.filled_at,
        auto: scopeFill.auto === true,
        by: scopeFill.filled_by_email ?? null,
        scope_revision_id: scopeFill.scope_revision_id ?? null,
      }
      : null,
    draft_list: {
      lines: lines.filter((l) => !l.supplier_id).map(projectDispatchV2Line),
      photos: photos.filter((p) => !p.supplier_id).map(projectPhoto),
    },
    suppliers: boxes.map((box) => {
      const id = String(box.supplier_id);
      const contact = contacts.get(id);
      const entry = approved.get(id) ?? null;
      const boxEmails = emails.filter((e) => String(e.supplier_id) === id);
      const open = boxEmails.find((e) => OPEN_EMAIL_STATUSES.includes(e.status));
      // The same rule the board's Arrival line uses (dispatchV2BoxStage).
      // The approved list read above only keeps active entries, and a failed
      // read refuses the whole panel, so the terms are always known here.
      const view = dispatchV2BoxStage({
        box,
        emails: boxEmails,
        lines,
        terms: dispatchV2PaymentTerms({
          readOk: true,
          linked: !!entry,
          onAccount: entry ? entry.on_account === true : null,
        }),
        replies: replies.error ? [] : replies.data,
        installDay: install?.day ?? null,
        installFirstDay: install?.first_day ?? null,
        openEmail: open ?? null,
      });
      return {
        supplier_id: id,
        // Tweak 4: the approved name when the box's Xero contact is linked
        // to an approved supplier ("BD Metals"), else the Xero name.
        name: dispatchV2SupplierDisplayName(
          entry,
          contact?.is_active && contact?.name ? contact.name : box.supplier_name,
        ),
        // The Xero contact the box is on, as Xero names it.
        xero_name: contact?.name ?? box.supplier_name ?? null,
        active: contact?.is_active === true,
        position: box.position,
        is_main: id === mainId,
        approved_email: projectApproved(entry),
        // Why Make email / Send now are blocked for this box, or null.
        send_blocked: entry ? null : {
          code: "no_approved_email",
          message:
            "This supplier has no approved order email. Ask Shaun to add one before sending.",
        },
        lines: lines.filter((l) => String(l.supplier_id ?? "") === id).map(
          projectDispatchV2Line,
        ),
        photos: photos.filter((p) => String(p.supplier_id ?? "") === id).map(
          projectPhoto,
        ),
        open_email: open ? projectDispatchV2Email(open, nowMs) : null,
        sent_emails: boxEmails.filter((e) => e.status === "sent").map((e) =>
          projectDispatchV2Email(e, nowMs)
        ),
        // Delivery or pickup: the open email's, else the newest sent one's,
        // else null (nothing made yet: the screen shows Delivery).
        fulfilment: boxFulfilment(open, boxEmails),
        material_stage: boxMaterialStage(box, view),
        // The box's payment step (contract section 3c).
        payment: view.payment,
        // ASAP or Pick a date (piece C). mode: for the box's next order
        // email (the toggle). sent_mode: what the newest sent order asked
        // (null when nothing was sent). derived: the box's own choice is
        // NULL (made before piece C) and the mode was worked out.
        date_mode: {
          mode: view.date_mode,
          sent_mode: view.sent_date_mode,
          set_at: box.order_date_mode_set_at ?? null,
          set_by_email: box.order_date_mode_set_by_email ?? null,
          derived: view.date_mode_derived,
        },
      };
    }),
    // Sent order emails whose supplier box was taken off the job with the X
    // (Shaun, 12 Nov 2026). The email went and is kept, so the Emails panel
    // still lists it. Oldest first, as the boxes' emails are.
    unboxed_sent_emails: emails
      .filter((e) =>
        e.status === "sent" &&
        !supplierIds.includes(String(e.supplier_id ?? ""))
      )
      .map((e) => ({
        supplier_id: e.supplier_id ? String(e.supplier_id) : null,
        supplier_name: e.supplier_name ?? null,
        email: projectDispatchV2Email(e, nowMs),
      })),
  };
}

// The box's delivery or pickup: the open email's opening line, else the
// newest sent email's, else null.
function boxFulfilment(open: any, boxEmails: any[]) {
  if (open) return dispatchV2FulfilmentOf(open.body_text);
  let newest: any = null;
  for (const e of boxEmails) {
    if (e.status !== "sent") continue;
    if (!newest || String(e.sent_at ?? "") > String(newest.sent_at ?? "")) {
      newest = e;
    }
  }
  return newest ? dispatchV2FulfilmentOf(newest.body_text) : null;
}

// The box's material stage as the box shows it, from dispatchV2BoxStage (the
// board's rule too, dispatch_v2_material_stage.ts): the stage, whether a
// person set it or it was worked out from the box, and the stamp the set
// press guards on (material_stage_set_at, null = never set).
function boxMaterialStage(
  box: any,
  view: ReturnType<typeof dispatchV2BoxStage>,
) {
  return {
    box_id: box?.id ?? null,
    key: view.key,
    label: view.label,
    source: view.source,
    set_at: box?.material_stage_set_at ?? null,
    set_by_email: view.set_by_email,
    // A confirmed date is saved but the payment gate holds the stage.
    held_by_payment: view.held_by_payment,
    // The matched supplier reply that moved the box (source "reply").
    reply: view.reply,
    // A reply that came in but said too little to move a box at Sent (no
    // PDF, date or price): the screen shows it as a note.
    reply_note: view.reply_note,
    // A pickup on the install's first day: leave Materials ready out of the
    // box's strip and picker.
    skips_ready: view.skips_ready,
  };
}

// ── Supplier search for Add supplier ────────────────────────────────────────

// Tweak 4 (contract section "Tweak 4", rules in dispatch_v2_supplier_picker.ts):
// one row per approved supplier under its approved name, with its main Xero
// contact behind it; the other Xero contacts of the approved suppliers and
// every other active Xero supplier come back as well, for Show more. `q`
// filters by name, ignoring case, spaces, punctuation, "&" and "and". No q
// lists everything approved and the first `limit` others.
//
// The bill counts come from the dispatch_approved_supplier_contact_bills view
// (migration 20261105184500), worked out by Postgres on every read, so the
// main contact is always as fresh as the 06:55 Xero sync. If that read
// fails, the search still answers (ranking "unavailable") and each main
// contact falls back to the name order.
export async function searchDispatchV2Suppliers(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchV2Context,
) {
  const q = String(params.get("q") ?? "").replace(/[%_,()*\\]/g, " ").trim()
    .slice(0, 60);
  const limitRaw = Number(params.get("limit") ?? 25);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100
    ? limitRaw
    : 25;

  const { data: entries, error: entriesError } = await client
    .from("dispatch_approved_supplier_emails")
    .select(APPROVED_SELECT)
    .eq("org_id", ctx.orgId)
    .eq("active", true)
    .order("name", { ascending: true });
  if (entriesError) readFailed("approved emails read", entriesError);
  const { data: links, error: linksError } = await client
    .from("dispatch_approved_supplier_email_links")
    .select("supplier_id, approved_id")
    .eq("org_id", ctx.orgId);
  if (linksError) readFailed("approved email links read", linksError);
  // Only links to an active entry count: a supplier linked to a retired entry
  // shows with the others, as having no approved order email.
  const activeIds = new Set((entries || []).map((e: any) => String(e.id)));
  const activeLinks = (links || []).filter((l: any) =>
    activeIds.has(String(l.approved_id))
  );
  const linked = new Set(activeLinks.map((l: any) => String(l.supplier_id)));

  // Every supplier contact of the organisation, in one paged read (about 300
  // today): the linked ones for the approved rows, the rest for Show more.
  // Matching is done here, not with ilike, so "b&d" finds "B & D".
  let all: any[];
  try {
    all = await fetchAllRows<any>(
      () =>
        client.from("suppliers")
          .select("id, name, is_active, xero_contact_id")
          .eq("org_id", ctx.orgId),
      "supplier contacts search",
      "id",
    );
  } catch (error) {
    readFailed("supplier contacts search", error);
  }
  const contacts = new Map<string, any>(all!.map((r: any) => [String(r.id), r]));

  // The bill counts and pins: a failed read is "unavailable", never a refusal.
  let bills: Map<string, any> | null = null;
  const billRead = await client
    .from("dispatch_approved_supplier_contact_bills")
    .select("supplier_id, approved_id, bills_12m, last_bill_date, is_pinned")
    .eq("org_id", ctx.orgId);
  if (billRead.error) {
    console.error(
      "[dispatch_v2] supplier bill counts read failed:",
      billRead.error?.message ?? billRead.error,
    );
  } else {
    bills = new Map(
      (billRead.data || []).map((
        r: any,
      ) => [String(r.supplier_id), {
        bills_12m: Number(r.bills_12m) || 0,
        last_bill_date: r.last_bill_date ?? null,
        is_pinned: r.is_pinned === true,
      }]),
    );
  }

  const others = all!
    .filter((row: any) => row.is_active === true && !linked.has(String(row.id)))
    .sort((a: any, b: any) =>
      String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
      String(a.id).localeCompare(String(b.id))
    );
  const picker = dispatchV2BuildSupplierPicker({
    entries: entries || [],
    links: activeLinks,
    contacts,
    bills,
    others,
    q,
    limit,
  });
  return { q, ranking: bills ? "bills" : "unavailable", ...picker };
}

// ── Lines ───────────────────────────────────────────────────────────────────

function lineIsLocked(row: any): never {
  refuse(
    409,
    "line_locked",
    row?.dispatch_order_email_id
      ? "This line went out on a sent order email and cannot be changed"
      : "This line is on a purchase order and cannot be changed here",
    { line: projectDispatchV2Line(row) },
  );
}

function lineChanged(row: any): never {
  refuse(
    409,
    "line_changed",
    row ? "This line changed somewhere else" : "This line was removed somewhere else",
    { line: row ? projectDispatchV2Line(row) : null },
  );
}

async function boxOrRefuse(client: any, jobId: string, supplierId: string) {
  const box = await readBox(client, jobId, supplierId);
  if (!box) {
    refuse(409, "supplier_not_on_job", "That supplier box is not on this job");
  }
  return box;
}

async function nextLinePosition(client: any, jobId: string) {
  const { data, error } = await client.from("job_material_lines")
    .select("position")
    .eq("job_id", jobId)
    .order("position", { ascending: false })
    .limit(1);
  if (error) readFailed("line position read", error);
  const top = Array.isArray(data) && data.length > 0
    ? Number(data[0]?.position)
    : 0;
  return (Number.isFinite(top) ? top : 0) + 1;
}

// Save one line: a new line (no expected_updated_at) or an edit of one (with
// it). supplier_id null puts it on the draft list.
export async function saveDispatchV2Line(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const input = body?.line;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("line required");
  }
  if (!isDispatchUuid(input.id)) badRequest("line.id must be a uuid");
  const supplierId = input.supplier_id === undefined
    ? undefined
    : supplierIdOrNull(input.supplier_id, "line.supplier_id");
  const values = {
    description: field(cleanDispatchDescription(input.description)),
    quantity: field(cleanDispatchQuantity(input.quantity)),
    unit: field(cleanDispatchUnit(input.unit)),
    detail: optionalText(input.detail, "line.detail", DETAIL_MAX, {
      multiline: true,
    }),
    profile: optionalText(input.profile, "line.profile", PROFILE_MAX),
    colour: optionalText(input.colour, "line.colour", PROFILE_MAX),
  };
  const status = input.status === undefined
    ? undefined
    : field(cleanDispatchStatus(input.status));
  const expected = expectedStamp(body?.expected_updated_at, false);

  const stored = await readLine(client, input.id);
  if (stored && String(stored.job_id) !== job.id) {
    refuse(409, "line_not_on_job", "That line belongs to another job");
  }
  const now = nowIso(ctx);

  if (stored) {
    if (lineLocked(stored)) lineIsLocked(stored);
    // No expected stamp on a line that exists: a retried insert.
    if (expected === null) {
      return { success: true, unchanged: true, line: projectDispatchV2Line(stored) };
    }
    const target = supplierId === undefined
      ? (stored.supplier_id ?? null)
      : supplierId;
    if (target) await boxOrRefuse(client, job.id, target);
    const patch: Record<string, unknown> = {
      ...values,
      supplier_id: target,
      status: status ?? stored.status,
      updated_at: now,
      updated_by: ctx.actor.userId,
      updated_by_email: ctx.actor.email,
    };
    if (String(stored.supplier_id ?? "") !== String(target ?? "")) {
      patch.position = await nextLinePosition(client, job.id);
    }
    return await guardedLineUpdate(client, job.id, input.id, expected, patch);
  }

  if (expected !== null) lineChanged(null);
  const target = supplierId ?? null;
  if (target) await boxOrRefuse(client, job.id, target);
  const { count, error: countError } = await client.from("job_material_lines")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  if (countError) readFailed("line count", countError);
  if ((Number(count) || 0) >= DISPATCH_MATERIAL_LINES_PER_JOB_MAX) {
    refuse(
      409,
      "too_many_lines",
      `A job holds at most ${DISPATCH_MATERIAL_LINES_PER_JOB_MAX} lines`,
    );
  }
  const { data: inserted, error: insertError } = await client
    .from("job_material_lines")
    .insert({
      id: input.id,
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: target,
      ...values,
      status: status ?? "not_reviewed",
      source: "manual",
      position: await nextLinePosition(client, job.id),
      created_at: now,
      updated_at: now,
      created_by: ctx.actor.userId,
      updated_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
      updated_by_email: ctx.actor.email,
    })
    .select(LINE_SELECT)
    .single();
  if (insertError) {
    if (errorCode(insertError) === "23505") {
      // The same id landed first (a retried save): one row, never two.
      const raced = await readLine(client, input.id);
      if (raced && String(raced.job_id) === job.id) {
        return { success: true, unchanged: true, line: projectDispatchV2Line(raced) };
      }
    }
    if (errorCode(insertError) === "23503") {
      refuse(409, "supplier_not_on_job", "That supplier box is not on this job");
    }
    writeFailed("line insert", insertError);
  }
  return { success: true, line: projectDispatchV2Line(inserted) };
}

async function guardedLineUpdate(
  client: any,
  jobId: string,
  id: string,
  expected: string,
  patch: Record<string, unknown>,
) {
  const { data, error } = await client.from("job_material_lines")
    .update(patch)
    .eq("id", id)
    .eq("job_id", jobId)
    .eq("updated_at", expected)
    .is("dispatch_order_email_id", null)
    .is("purchase_order_id", null)
    .select(LINE_SELECT);
  if (error) {
    if (errorCode(error) === "23503") {
      refuse(409, "supplier_not_on_job", "That supplier box is not on this job");
    }
    writeFailed("line update", error);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // The guard held: someone else changed, sent or removed the line first.
    const latest = await readLine(client, id);
    if (latest && lineLocked(latest)) lineIsLocked(latest);
    lineChanged(latest);
  }
  return { success: true, line: projectDispatchV2Line(row) };
}

// Move a line into a supplier box, out of one (supplier_id null = back to the
// draft list) or between boxes. Nothing else about the line changes.
export async function moveDispatchV2Line(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  if (!isDispatchUuid(body?.id)) badRequest("id must be a uuid");
  if (body?.supplier_id === undefined) {
    badRequest("supplier_id required (null for the draft list)");
  }
  const target = supplierIdOrNull(body.supplier_id);
  const expected = expectedStamp(body?.expected_updated_at, true) as string;
  const stored = await readLine(client, body.id);
  if (!stored) lineChanged(null);
  if (String(stored.job_id) !== job.id) {
    refuse(409, "line_not_on_job", "That line belongs to another job");
  }
  if (lineLocked(stored)) lineIsLocked(stored);
  if (String(stored.supplier_id ?? "") === String(target ?? "")) {
    return { success: true, unchanged: true, line: projectDispatchV2Line(stored) };
  }
  if (target) await boxOrRefuse(client, job.id, target);
  return await guardedLineUpdate(client, job.id, body.id, expected, {
    supplier_id: target,
    position: await nextLinePosition(client, job.id),
    updated_at: nowIso(ctx),
    updated_by: ctx.actor.userId,
    updated_by_email: ctx.actor.email,
  });
}

export async function deleteDispatchV2Line(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  if (!isDispatchUuid(body?.id)) badRequest("id must be a uuid");
  const expected = expectedStamp(body?.expected_updated_at, true) as string;
  const stored = await readLine(client, body.id);
  if (!stored) return { success: true, unchanged: true };
  if (String(stored.job_id) !== job.id) {
    refuse(409, "line_not_on_job", "That line belongs to another job");
  }
  if (lineLocked(stored)) lineIsLocked(stored);
  const { data, error } = await client.from("job_material_lines")
    .delete()
    .eq("id", body.id)
    .eq("job_id", job.id)
    .eq("updated_at", expected)
    .is("dispatch_order_email_id", null)
    .is("purchase_order_id", null)
    .select("id");
  if (error) writeFailed("line delete", error);
  if (!Array.isArray(data) || data.length === 0) {
    const latest = await readLine(client, body.id);
    if (!latest) return { success: true, unchanged: true };
    if (lineLocked(latest)) lineIsLocked(latest);
    lineChanged(latest);
  }
  return { success: true };
}

// A suggested line's id is fixed by its job and place, so two presses insert
// the same ids and the second clashes (23505 -> lines_exist), never twice. A
// refill (S08) names its revision too, so its ids never meet the lines it
// replaces, and two refill presses still clash instead of filling twice.
async function suggestedLineId(
  jobId: string,
  index: number,
  refillRevisionId: string | null = null,
) {
  const seed = refillRevisionId
    ? `dispatch-v2-draft-line:${jobId}:${refillRevisionId}:${index}`
    : `dispatch-v2-draft-line:${jobId}:${index}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(seed),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

// Fill the draft list from the scope (fencing and patio jobs with no line).
// Concrete bags, footings, tek screws, removal and labour are left out: they
// never go on supplier copy.
// ── The scope fill's record and the scope's supplier ────────────────────────

// The job's scope fill record (dispatch_v2_scope_fills), or null. One row per
// job, written the first time its list is filled from the scope, by the
// button or on its own; the auto fill never runs on a job that has one, so a
// list cleared by hand is not filled again.
async function readScopeFill(client: any, jobId: string): Promise<any | null> {
  const { data, error } = await client.from("dispatch_v2_scope_fills")
    .select(
      "job_id, auto, lines_added, supplier_id, scope_supplier, filled_at, filled_by_email, scope_revision_id",
    )
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) readFailed("scope fill read", error);
  return data ?? null;
}

// ── S08: the list against a newer sealed revision ───────────────────────────
//
// Every scope line names the sealed revision it was filled from (T20). When
// the revision the order follows now (the fill's own rule: the accepted
// revision, else the latest frozen one) is a different one, the list is out
// of date with the scope. Fill from the scope then refills the scope lines
// from the newer revision, but only while none of them went out: a line on a
// sent order email or a purchase order is never changed, and the list is not
// refilled. The materials read says which, in plain words. Lines typed in by
// hand are never touched, and lines filled before T20 (no revision named)
// are left as they are.

type DispatchV2ScopeLines = {
  /** Scope lines filled from another revision than the order's. */
  older: any[];
  /** Scope lines already from the order's revision. */
  current: any[];
  /** The older lines that went out (sent order email or purchase order). */
  locked: any[];
  /** The revision numbers the older lines came from, lowest first. */
  revisions: number[];
};

function scopeLinesAgainst(lines: any[], revisionId: string): DispatchV2ScopeLines {
  const scope = lines.filter((l) =>
    l?.source === "scope" && SCOPE_REVISION_KINDS.has(String(l?.source_kind ?? "")) &&
    typeof l?.source_version_id === "string" && l.source_version_id
  );
  const older = scope.filter((l) => l.source_version_id !== revisionId);
  const revisions = [
    ...new Set(
      older.map((l) => numberOrNull(l.source_version)).filter((n): n is number => n !== null),
    ),
  ].sort((a, b) => a - b);
  return {
    older,
    current: scope.filter((l) => l.source_version_id === revisionId),
    locked: older.filter(lineLocked),
    revisions,
  };
}

function scopeChangedWords(from: number[], to: number, sent: boolean): string {
  const was = from.length === 0
    ? "an earlier revision"
    : from.length === 1
    ? `revision ${from[0]}`
    : `revisions ${from.slice(0, -1).join(", ")} and ${from[from.length - 1]}`;
  const head = `Scope changed since these lines: they came from ${was}, and the order now follows revision ${to}.`;
  return sent
    ? `${head} An order already went out from these lines, so they were not refilled. Check that order against revision ${to}.`
    : `${head} Press Fill from the scope to refill them from revision ${to}.`;
}

// The materials read's warning, or null when the scope lines follow the
// order's revision (or there are none, or the revision is not known).
async function readScopeChanged(client: any, job: any, lines: any[]) {
  if (!lines.some((l) => l?.source === "scope" && l?.source_version_id)) return null;
  const revision = await readDispatchV2OrderRevision(client, job);
  if (!revision) return null;
  const state = scopeLinesAgainst(lines, revision.revision_id);
  if (!state.older.length) return null;
  const canRefill = !state.locked.length && !state.current.length;
  return {
    lines_revision_numbers: state.revisions,
    revision_id: revision.revision_id,
    revision_number: revision.revision_number,
    can_refill: canRefill,
    message: state.current.length && !state.locked.length
      ? `Scope changed since some of these lines: they came from ${state.revisions.length === 1 ? `revision ${state.revisions[0]}` : "earlier revisions"}, and the order now follows revision ${revision.revision_number}. Take the earlier lines off by hand, then check the list against revision ${revision.revision_number}.`
      : scopeChangedWords(state.revisions, revision.revision_number, state.locked.length > 0),
  };
}

// The supplier contact a scope's supplier means: the active contact linked to
// the matching approved order email (the one named like it, else the first by
// name). `names` are tried in order (a patio line's catalogue id, then its
// name); `shown` is the name a note uses. No match says why in a note.
async function resolveScopeSupplier(
  client: any,
  names: string[],
  shown: string,
  ctx: DispatchV2Context,
  onList = "The lines are on the draft list: add a supplier and move them in.",
): Promise<{ contact: any | null; note: string | null }> {
  const tried = names.filter((n) => typeof n === "string" && n.trim());
  if (!tried.length) return { contact: null, note: null };
  const { data: entries, error } = await client
    .from("dispatch_approved_supplier_emails")
    .select("id, name")
    .eq("org_id", ctx.orgId)
    .eq("active", true);
  if (error) readFailed("approved emails read", error);
  const list: any[] = entries || [];
  const approvedNames = list.map((e) => String(e.name));
  let name: string | null = null;
  for (const n of tried) {
    name = dispatchV2MatchScopeSupplier(n, approvedNames);
    if (name) break;
  }
  const entry = name ? list.find((e) => String(e.name) === name) : null;
  if (!entry) {
    return {
      contact: null,
      note:
        `The scope names ${shown} as the supplier, which has no approved order email. ${onList}`,
    };
  }
  const { data: links, error: linksError } = await client
    .from("dispatch_approved_supplier_email_links")
    .select("supplier_id")
    .eq("approved_id", entry.id)
    .eq("org_id", ctx.orgId);
  if (linksError) readFailed("approved email links read", linksError);
  const ids: string[] = [
    ...new Set<string>((links || []).map((l: any) => String(l.supplier_id))),
  ];
  const contacts = [...(await readContacts(client, ids, ctx)).values()]
    .filter((c) => c.is_active === true);
  const same = (n: unknown) => String(n ?? "").trim().toLowerCase();
  const named = (c: any) => Number(same(c.name) === same(entry.name));
  contacts.sort((a, b) =>
    named(b) - named(a) || String(a.name).localeCompare(String(b.name)) ||
    String(a.id).localeCompare(String(b.id))
  );
  if (!contacts.length) {
    return {
      contact: null,
      note:
        `The scope names ${shown} as the supplier, but no supplier contact is linked to its approved order email. ${onList}`,
    };
  }
  // Tweak 4: the scope's lines go in a box on the same main contact the Add
  // supplier search uses (a pin, else the most Xero bills in the last 12
  // months). With no pin and no bills, the name order above stands.
  const main = await scopeMainContact(client, entry.id, contacts, ctx);
  return { contact: main ?? contacts[0], note: null };
}

// The main Xero contact of one approved supplier, by its pin or its bill
// count (dispatch_approved_supplier_contact_bills), or null when neither
// decides it or the counts cannot be read (never a refusal).
async function scopeMainContact(
  client: any,
  approvedId: string,
  contacts: any[],
  ctx: DispatchV2Context,
): Promise<any | null> {
  const { data, error } = await client
    .from("dispatch_approved_supplier_contact_bills")
    .select("supplier_id, bills_12m, last_bill_date, is_pinned")
    .eq("org_id", ctx.orgId)
    .eq("approved_id", approvedId);
  if (error) {
    console.error(
      "[dispatch_v2] scope supplier bill counts read failed:",
      error?.message ?? error,
    );
    return null;
  }
  const bills = new Map<string, any>(
    (data || []).map((r: any) => [String(r.supplier_id), r]),
  );
  const ranked = dispatchV2RankLinkedContacts(contacts.map((c) => {
    const b = bills.get(String(c.id));
    return {
      supplier_id: String(c.id),
      name: String(c.name ?? ""),
      is_active: c.is_active === true,
      has_xero_contact: true,
      bills_12m: Number(b?.bills_12m) || 0,
      last_bill_date: b?.last_bill_date ?? null,
      is_pinned: b?.is_pinned === true,
    };
  }));
  const reason = dispatchV2MainReason(ranked);
  if (reason !== "pinned" && reason !== "most_bills") return null;
  return contacts.find((c) => String(c.id) === ranked[0].supplier_id) ?? null;
}

function linesWord(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}

// The line provenance a scope fill writes (columns from production migration
// 20261019200000_dispatch_material_line_provenance, whose check allows these
// two kinds for a scope line): the sealed revision and the engine's own line.
function scopeRevisionKind(workType: string): "fence_scope_revision" | "patio_scope_revision" {
  return workType === "fencing" ? "fence_scope_revision" : "patio_scope_revision";
}

type FillLine = DispatchSuggestedLine &
  Partial<Pick<DispatchV2FenceLine, "detail" | "profile" | "colour">> & {
    scope_line_id?: string | null;
    supplier_key?: string | null;
    supplier_name?: string | null;
  };

// Fill the draft list from the job's frozen scope revision (T20). With auto
// (the screen's own fill when a fencing job with no record is opened) it runs
// once per job, ever. A sealed line names its own supplier (patio, and fence
// revisions that split the order); an older fence scope names one. A supplier with an approved order email and a linked contact
// gets its lines in its box, made if it is not there yet; every other line
// lands on the draft list. Each line carries the revision's id and number and,
// on a patio job, the engine's own line id.
export async function suggestDispatchV2Draft(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const auto = body?.auto === true;
  if (auto && job.work_type !== "fencing") {
    refuse(
      409,
      "no_auto_fill",
      "Only fencing jobs fill from the scope on their own",
    );
  }
  if (auto && await readScopeFill(client, job.id)) {
    refuse(409, "already_filled", "This job was filled from the scope before");
  }
  // Tweak 2 (contract section 3f.1): the screen's own fill never runs on a
  // job whose order Shaun sent from Outlook. The Fill press still works.
  if (auto && await hasOutlookOrder(client, job.id)) {
    refuse(
      409,
      "ordered_from_outlook",
      "This job was ordered from Outlook, so it is not filled on its own",
    );
  }
  if (job.work_type !== "fencing" && job.work_type !== "patio") {
    refuse(
      409,
      "no_suggestion_for_work_type",
      "The draft list is filled from the scope on fencing and patio jobs only",
    );
  }
  const { count, error: countError } = await client.from("job_material_lines")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  if (countError) readFailed("line count", countError);
  // S08: a list that has lines is refilled only by the press, only when its
  // scope lines came from an older sealed revision, and only while none of
  // them went out. The screen's own fill never runs over lines.
  let existing: any[] = [];
  if ((Number(count) || 0) > 0) {
    if (auto) refuse(409, "lines_exist", "This job already has lines");
    existing = await readJobLines(client, job.id);
    if (!existing.some((l) => l?.source === "scope" && l?.source_version_id)) {
      refuse(409, "lines_exist", "This job already has lines");
    }
  }
  // The job's frozen scope revision by Context's material-take rule
  // (dispatch_v2_sealed_scope.ts: the accepted revision, else the latest
  // frozen one), read from that row's own text. Never the job's working
  // scope, and never the pricing: with null pricing the extractor's
  // quote-lines fallback cannot run, so no price becomes a line.
  const frozen = await readDispatchV2FrozenScope(client, job);
  const sealedScope: any = frozen.scope;
  const revision = { id: frozen.revision_id, revision_number: frozen.revision_number };
  let refill: DispatchV2ScopeLines | null = null;
  if (existing.length) {
    const state = scopeLinesAgainst(existing, revision.id);
    if (!state.older.length) refuse(409, "lines_exist", "This job already has lines");
    if (state.locked.length) {
      refuse(
        409,
        "scope_changed",
        scopeChangedWords(state.revisions, revision.revision_number, true),
        { scope_revision: revision, lines_revision_numbers: state.revisions },
      );
    }
    if (state.current.length) {
      refuse(
        409,
        "scope_lines_mixed",
        `Some of these lines came from revision ${revision.revision_number} and some from an earlier revision, so they were not refilled. Take the earlier lines off by hand.`,
        { scope_revision: revision, lines_revision_numbers: state.revisions },
      );
    }
    refill = state;
  }
  // A fencing job scoped in the fence tool is read with the material ordering
  // rules (panels, posts, plinths, gates). A Scope Engine patio record lists
  // its sealed lines; anything else uses the older extractor (patio layout).
  const fence = job.work_type === "fencing"
    ? dispatchV2FenceLinesFromScope(sealedScope)
    : null;
  let suggested: FillLine[];
  const notes: string[] = [
    ...(frozen.changed_since_frozen
      ? [`The job's scope was changed after revision ${revision.revision_number} was frozen. These lines come from revision ${revision.revision_number}: freeze the scope again to order the change.`]
      : []),
    ...(fence ? fence.notes : []),
  ];
  if (fence) {
    suggested = fence.lines;
  } else {
    let items: any[];
    try {
      items = isScopeEnginePatioRecord(sealedScope)
        ? scopeEngineSealedLines(sealedScope.lines)
        : ctx.extractMaterialsFromScope(sealedScope, null);
    } catch (error) {
      console.error("[dispatch_v2] scope could not be read:", error);
      refuse(409, "scope_unreadable", "The job's scope could not be read");
    }
    suggested = (items || [])
      .filter((item) => dispatchV2SuggestionAllowed(item?.description))
      .flatMap((item) => {
        const [line] = dispatchSuggestedLines([item]);
        return line
          ? [{
            ...line,
            scope_line_id: typeof item?.scope_line_id === "string" ? item.scope_line_id : null,
            supplier_key: typeof item?.supplier_id === "string" ? item.supplier_id : null,
            supplier_name: typeof item?.supplier_name === "string" ? item.supplier_name : null,
          }]
          : [];
      });
  }
  // Ruling 14 step 1 (contract 4.4): each quote option the customer took that
  // goes to a supplier is one more sealed line, in its own supplier's box
  // (patio) or, with no supplier on it (a fence option), on the draft list.
  // An untaken option is not here. An option record that cannot be read
  // fills nothing, so the order is never sent short.
  const taken = await takenQuoteOptionOrderItems(client, job.id);
  if (taken.state === "unreadable") {
    refuse(409, "quote_options_unreadable", "The quote options the customer took could not be read, so the list was not filled. Try again.");
  }
  if (taken.state === "unusable") {
    refuse(409, "quote_option_line_unusable", "A quote option the customer took has no usable order line in the sealed quote, so the list was not filled. Check the quote.");
  }
  for (const item of taken.items) {
    if (!dispatchV2SuggestionAllowed(item.description)) continue;
    const [line] = dispatchSuggestedLines([item]);
    if (!line) continue;
    suggested.push({
      ...line,
      scope_line_id: item.scope_line_id,
      supplier_key: item.supplier_id,
      supplier_name: item.supplier_name,
    });
  }
  notes.push(...taken.notes);
  if (suggested.length === 0) {
    if (refill) {
      notes.push(
        `Revision ${revision.revision_number} has no lines to order, so the earlier lines were left as they are.`,
      );
    }
    return {
      success: true,
      added: 0,
      lines: [],
      notes,
      supplier: null,
      suppliers: [],
      scope_revision: revision,
    };
  }
  // The suppliers the scope names, in the order they first appear. A sealed
  // order that splits its lines by supplier (a sealed patio line, or a fence
  // revision whose sealed lines name their supplier) puts each line in its own
  // sealed line's supplier box, line for line. Only a fence scope with no
  // supplier on its sealed lines (the older fence tool) uses the one supplier
  // typed on the scope.
  const perLine = !fence || fence.sealed_suppliers;
  const fenceSupplier = fence && !perLine ? dispatchV2ScopeSupplierName(sealedScope) : null;
  const wanted = new Map<string, { names: string[]; shown: string; count: number }>();
  if (fenceSupplier) {
    wanted.set(fenceSupplier, { names: [fenceSupplier], shown: fenceSupplier, count: suggested.length });
  }
  if (fence && perLine) {
    // A line the sealed order does not place is held on the draft list, never
    // put in a guessed supplier's box.
    const held = suggested.filter((l) => !l.supplier_key);
    if (held.length) {
      notes.push(
        `${held.length === 1 ? "1 line has" : `${held.length} lines have`} no supplier in the sealed order, so ${held.length === 1 ? "it is" : "they are"} on the draft list: ${held.map((l) => l.description).join(", ")}.`,
      );
    }
  }
  if (perLine) {
    for (const line of suggested) {
      const key = line.supplier_key;
      if (!key) continue;
      const seen = wanted.get(key);
      if (seen) seen.count += 1;
      else {
        wanted.set(key, {
          names: line.supplier_name ? [key, line.supplier_name] : [key],
          shown: line.supplier_name ?? key,
          count: 1,
        });
      }
    }
  }
  // The auto fill claims the job first, so two screens never both fill it.
  const fill = {
    job_id: job.id,
    org_id: job.org_id,
    auto,
    lines_added: suggested.length,
    supplier_id: null as string | null,
    scope_supplier: !perLine
      ? fenceSupplier
      : wanted.size === 1 ? [...wanted.values()][0].shown : null,
    filled_at: nowIso(ctx),
    filled_by: ctx.actor.userId,
    filled_by_email: ctx.actor.email,
    scope_revision_id: revision.id,
  };
  if (auto) {
    const { error: claimError } = await client.from("dispatch_v2_scope_fills")
      .insert(fill);
    if (claimError) {
      if (errorCode(claimError) === "23505") {
        refuse(
          409,
          "already_filled",
          "This job was filled from the scope before",
        );
      }
      writeFailed("scope fill claim", claimError);
    }
  }
  const boxes = new Map<string, { supplier_id: string; name: string }>();
  try {
    for (const [key, want] of wanted) {
      const found = await resolveScopeSupplier(
        client,
        want.names,
        want.shown,
        ctx,
        !perLine
          ? undefined
          : `Its ${linesWord(want.count)} ${want.count === 1 ? "is" : "are"} on the draft list: add a supplier and move ${want.count === 1 ? "it" : "them"} in.`,
      );
      if (found.note) notes.push(found.note);
      if (found.contact) {
        const made = await readBox(client, job.id, String(found.contact.id)) ??
          (await insertBox(client, job, found.contact, ctx)).box;
        boxes.set(key, {
          supplier_id: String(made.supplier_id),
          name: String(found.contact.name),
        });
      }
    }
  } catch (error) {
    if (auto) await releaseScopeFill(client, job.id);
    throw error;
  }
  const boxOf = (line: FillLine) =>
    !perLine
      ? (fenceSupplier ? boxes.get(fenceSupplier) ?? null : null)
      : (line.supplier_key ? boxes.get(line.supplier_key) ?? null : null);
  const used = [...new Set(suggested.map((l) => boxOf(l)?.supplier_id ?? null))];
  const single = used.length === 1 && used[0] !== null
    ? [...boxes.values()].find((b) => b.supplier_id === used[0]) ?? null
    : null;
  fill.supplier_id = used.length === 1 ? used[0] : null;
  const now = nowIso(ctx);
  const ids = await Promise.all(
    suggested.map((_line, index) =>
      suggestedLineId(job.id, index, refill ? revision.id : null)
    ),
  );
  // A refill's lines go after every line already there.
  const after = refill
    ? Math.max(0, ...existing.map((l) => Number(l.position) || 0))
    : 0;
  // An engine line id is kept once per fill: the index
  // job_material_lines_source_line_once allows one line per id and revision.
  const lineIds = new Set<string>();
  const rows = suggested.map((line, index) => {
    const own = line.scope_line_id && !lineIds.has(line.scope_line_id)
      ? line.scope_line_id
      : null;
    if (own) lineIds.add(own);
    return {
      id: ids[index],
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: boxOf(line)?.supplier_id ?? null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      detail: line.detail ?? null,
      profile: line.profile ?? null,
      colour: line.colour ?? null,
      status: "not_reviewed",
      source: "scope",
      source_kind: scopeRevisionKind(job.work_type),
      source_version_id: revision.id,
      source_version: String(revision.revision_number),
      source_line_id: own,
      position: after + index + 1,
      created_at: now,
      updated_at: now,
      created_by: ctx.actor.userId,
      updated_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
      updated_by_email: ctx.actor.email,
    };
  });
  const { data: inserted, error: insertError } = await client
    .from("job_material_lines")
    .insert(rows)
    .select(LINE_SELECT);
  if (insertError) {
    if (auto) await releaseScopeFill(client, job.id);
    if (errorCode(insertError) === "23505") {
      if (refill) {
        refuse(
          409,
          "lines_changed",
          "The list changed while it was being refilled, so nothing was changed. Open the job again.",
        );
      }
      refuse(409, "lines_exist", "This job already has lines");
    }
    writeFailed("suggested lines insert", insertError);
  }
  // S08: the newer lines are in; the older scope lines come off. Only lines
  // still on no sent order email and no purchase order are deleted, so a line
  // that went out while this ran stays exactly as it was.
  let replaced = 0;
  if (refill) {
    const oldIds = refill.older.map((l) => String(l.id));
    const { data: gone, error: goneError } = await client
      .from("job_material_lines")
      .delete()
      .eq("job_id", job.id)
      .in("id", oldIds)
      .is("dispatch_order_email_id", null)
      .is("purchase_order_id", null)
      .select("id");
    if (goneError) {
      // Take the newer lines off again, so the list is never doubled.
      const { error: undoError } = await client.from("job_material_lines")
        .delete()
        .eq("job_id", job.id)
        .in("id", rows.map((r) => r.id));
      if (undoError) {
        console.error("[dispatch_v2] refill lines not taken back:", undoError);
      }
      writeFailed("earlier scope lines delete", goneError);
    }
    replaced = Array.isArray(gone) ? gone.length : 0;
    const was = refill.revisions.length === 1
      ? `revision ${refill.revisions[0]}`
      : "earlier revisions";
    if (replaced < oldIds.length) {
      const { data: left, error: leftError } = await client
        .from("job_material_lines")
        .select("id")
        .eq("job_id", job.id)
        .in("id", oldIds);
      if (leftError) console.error("[dispatch_v2] refill check failed:", leftError);
      const kept = Array.isArray(left) ? left.length : 0;
      if (kept > 0) {
        notes.unshift(
          `${linesWord(kept)} from ${was} went out on an order while the list was refilled, so ${kept === 1 ? "it was" : "they were"} kept. Check ${kept === 1 ? "it" : "them"} against revision ${revision.revision_number}.`,
        );
      }
    }
    notes.unshift(
      `Refilled from revision ${revision.revision_number}: the ${linesWord(replaced)} from ${was} ${replaced === 1 ? "was" : "were"} replaced.`,
    );
    // The job's one fill record now names the revision of the refill.
    const { data: noted, error: noteError } = await client
      .from("dispatch_v2_scope_fills")
      .update({
        auto: false,
        lines_added: fill.lines_added,
        supplier_id: fill.supplier_id,
        scope_supplier: fill.scope_supplier,
        filled_at: fill.filled_at,
        filled_by: fill.filled_by,
        filled_by_email: fill.filled_by_email,
        scope_revision_id: revision.id,
      })
      .eq("job_id", job.id)
      .select("job_id");
    if (noteError) {
      console.error("[dispatch_v2] refill not noted:", noteError);
    } else if (!Array.isArray(noted) || noted.length === 0) {
      const { error } = await client.from("dispatch_v2_scope_fills").insert(fill);
      if (error && errorCode(error) !== "23505") {
        console.error("[dispatch_v2] refill not noted:", error);
      }
    }
  } else if (auto) {
    const { error } = await client.from("dispatch_v2_scope_fills")
      .update({ supplier_id: fill.supplier_id })
      .eq("job_id", job.id);
    if (error) console.error("[dispatch_v2] scope fill supplier not noted:", error);
  } else {
    // A fill by the button is noted too (the first one only), so the auto
    // fill never runs after it.
    const { error } = await client.from("dispatch_v2_scope_fills").insert(fill);
    if (error && errorCode(error) !== "23505") {
      console.error("[dispatch_v2] scope fill not noted:", error);
    }
  }
  const out: any[] = Array.isArray(inserted) ? inserted : [];
  out.sort((a, b) => Number(a.position) - Number(b.position));
  // Lines split between boxes: say where they went.
  const suppliers = [...boxes.values()].map((b) => ({
    ...b,
    lines: rows.filter((r) => r.supplier_id === b.supplier_id).length,
  })).filter((b) => b.lines > 0);
  if (!single && suppliers.length) {
    for (const b of suppliers) {
      notes.push(`${linesWord(b.lines)} went into the ${b.name} box.`);
    }
  }
  return {
    success: true,
    added: out.length,
    lines: out.map(projectDispatchV2Line),
    notes,
    supplier: single,
    suppliers,
    scope_revision: revision,
    ...(refill
      ? { refilled: { from_revision_numbers: refill.revisions, replaced } }
      : {}),
  };
}

// An auto fill that failed after its claim gives the claim back, so the next
// open tries again.
async function releaseScopeFill(client: any, jobId: string) {
  const { error } = await client.from("dispatch_v2_scope_fills")
    .delete()
    .eq("job_id", jobId)
    .eq("auto", true);
  if (error) {
    console.error("[dispatch_v2] scope fill claim not released:", error);
  }
}

// ── Supplier boxes ──────────────────────────────────────────────────────────

export async function addDispatchV2Supplier(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");
  const contacts = await readContacts(client, [supplierId], ctx);
  const contact = contacts.get(supplierId);
  if (!contact) refuse(404, "supplier_not_found", "Supplier contact not found");
  const approved = (await readApprovedFor(client, [supplierId], ctx)).get(
    supplierId,
  ) ?? null;
  const answer = (box: any, unchanged = false) => ({
    success: true,
    ...(unchanged ? { unchanged: true } : {}),
    supplier: {
      supplier_id: supplierId,
      // Tweak 4: the approved name when linked, else the Xero name.
      name: dispatchV2SupplierDisplayName(approved, contact.name),
      xero_name: contact.name,
      position: box.position,
      approved_email: projectApproved(approved),
      send_blocked: approved ? null : {
        code: "no_approved_email",
        message:
          "This supplier has no approved order email. Ask Shaun to add one before sending.",
      },
    },
  });
  const existing = await readBox(client, job.id, supplierId);
  if (existing) return answer(existing, true);
  if (contact.is_active !== true) {
    refuse(409, "supplier_inactive", "That supplier contact is not active");
  }
  const made = await insertBox(client, job, contact, ctx);
  return answer(made.box, made.raced);
}

// A new box at the end of the job's boxes. A box another press made meanwhile
// is the same box (raced), never a second one.
async function insertBox(
  client: any,
  job: any,
  contact: any,
  ctx: DispatchV2Context,
): Promise<{ box: any; raced: boolean }> {
  const supplierId = String(contact.id);
  const { data: top, error: topError } = await client
    .from("job_material_suppliers")
    .select("position")
    .eq("job_id", job.id)
    .order("position", { ascending: false })
    .limit(1);
  if (topError) readFailed("box position read", topError);
  const position = (Number(top?.[0]?.position) || 0) + 1;
  const { data: inserted, error } = await client.from("job_material_suppliers")
    .insert({
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: supplierId,
      supplier_name: contact.name,
      position,
      created_at: nowIso(ctx),
      created_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
    })
    .select(BOX_SELECT)
    .single();
  if (error) {
    if (errorCode(error) === "23505") {
      const raced = await readBox(client, job.id, supplierId);
      if (raced) return { box: raced, raced: true };
    }
    writeFailed("supplier box insert", error);
  }
  return { box: inserted, raced: false };
}

// The X on a supplier box (Shaun, 12 Nov 2026): take the supplier off the job
// at any time, whatever the box holds. The screen asks first. Removing:
//   - discards the box's held (unsent) order email;
//   - deletes the box's lines;
//   - deletes the box's photos, except a photo that went out on a sent order
//     email, which is kept and moves to the draft list;
//   - deletes the box.
// A sent order email is kept: it stays on the job (the Emails panel lists it
// under unboxed_sent_emails) and its replies stay matched. Nothing is sent to
// the supplier, and no job status, purchase order or Xero record changes.
// With the ticked main supplier gone, the main supplier default applies again.
// The one refusal: an order email to this supplier is sending right now, or
// may have gone (send_unknown). Check admin@ Sent Items first.
// Each step can be repeated, so a press that fails part way finishes on Retry.
export async function removeDispatchV2Supplier(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");
  const box = await readBox(client, job.id, supplierId);
  if (!box) return { success: true, unchanged: true };

  const [emailRes, photoRes, lineRes] = await Promise.all([
    client.from("dispatch_supplier_order_emails")
      .select("id, status, photo_ids")
      .eq("job_id", job.id)
      .eq("supplier_id", supplierId)
      .neq("status", "discarded"),
    client.from("dispatch_material_photos")
      .select("id, storage_path")
      .eq("job_id", job.id)
      .eq("supplier_id", supplierId),
    client.from("job_material_lines")
      .select("id")
      .eq("job_id", job.id)
      .eq("supplier_id", supplierId),
  ]);
  if (emailRes.error) readFailed("box emails read", emailRes.error);
  if (photoRes.error) readFailed("box photos read", photoRes.error);
  if (lineRes.error) readFailed("box lines read", lineRes.error);
  const emails: any[] = emailRes.data || [];
  const photos: any[] = photoRes.data || [];
  const lineCount = (lineRes.data || []).length;

  const inFlight = emails.find((e) =>
    e.status === "sending" || e.status === "send_unknown"
  );
  if (inFlight) {
    refuse(
      409,
      "supplier_email_sending",
      inFlight.status === "sending"
        ? "An order email to this supplier is sending right now. Wait a moment, then try again."
        : "An order email to this supplier may have gone. Check admin@ Sent Items first.",
    );
  }

  // 1. The held email: discarded, as Discard does. Only a draft is touched,
  // so a send that claimed it meanwhile is left alone.
  const drafts = emails.filter((e) => e.status === "draft");
  if (drafts.length > 0) {
    const { error } = await client.from("dispatch_supplier_order_emails")
      .update({
        status: "discarded",
        updated_at: nowIso(ctx),
        updated_by_email: ctx.actor.email,
      })
      .in("id", drafts.map((e) => String(e.id)))
      .eq("status", "draft");
    if (error) writeFailed("held email discard", error);
  }

  // 2. Photos: one that went out on a sent email is kept (to the draft list);
  // the rest are deleted with their files.
  const sentPhotoIds = new Set<string>();
  for (const e of emails) {
    if (e.status !== "sent") continue;
    for (const id of e.photo_ids || []) sentPhotoIds.add(String(id));
  }
  const keep = photos.filter((p) => sentPhotoIds.has(String(p.id)));
  const drop = photos.filter((p) => !sentPhotoIds.has(String(p.id)));
  if (keep.length > 0) {
    const { error } = await client.from("dispatch_material_photos")
      .update({ supplier_id: null })
      .eq("job_id", job.id)
      .in("id", keep.map((p) => String(p.id)));
    if (error) writeFailed("sent photo keep", error);
  }
  if (drop.length > 0) {
    const { error } = await client.from("dispatch_material_photos")
      .delete()
      .eq("job_id", job.id)
      .in("id", drop.map((p) => String(p.id)));
    if (error) writeFailed("box photos delete", error);
    const paths = drop.map((p) => String(p.storage_path ?? "")).filter(Boolean);
    if (paths.length > 0) {
      const removed = await client.storage.from(DISPATCH_V2_PHOTO_BUCKET)
        .remove(paths);
      if (removed?.error) {
        // The rows are gone; a stray file is harmless and private.
        console.error("[dispatch_v2] box photo files remove failed:", removed.error);
      }
    }
  }

  // 3. The lines.
  if (lineCount > 0) {
    const { error } = await client.from("job_material_lines")
      .delete()
      .eq("job_id", job.id)
      .eq("supplier_id", supplierId);
    if (error) writeFailed("box lines delete", error);
  }

  // 4. The box.
  const { error } = await client.from("job_material_suppliers")
    .delete()
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId);
  if (error) {
    // A line or photo landed in the box meanwhile: the foreign key refuses,
    // and the box stays. Pressing X again takes it too.
    if (errorCode(error) === "23503") {
      refuse(
        409,
        "box_changed",
        "Something was added to this box while it was being removed. Press X again.",
      );
    }
    writeFailed("supplier box delete", error);
  }
  return {
    success: true,
    removed: {
      lines: lineCount,
      photos_deleted: drop.length,
      photos_kept: keep.length,
      held_emails_discarded: drafts.length,
      sent_emails_kept: emails.filter((e) => e.status === "sent").length,
    },
  };
}

// Tick a box as the job's main supplier (supplier_id null clears the tick, so
// the default rule applies again).
export async function setDispatchV2MainSupplier(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  if (body?.supplier_id === undefined) {
    badRequest("supplier_id required (null clears the tick)");
  }
  const target = supplierIdOrNull(body.supplier_id);
  if (target) await boxOrRefuse(client, job.id, target);
  // Clear first: at most one tick per job is a unique rule in the database.
  const { error: clearError } = await client.from("job_material_suppliers")
    .update({ is_main_supplier: false })
    .eq("job_id", job.id)
    .eq("is_main_supplier", true);
  if (clearError) writeFailed("main supplier clear", clearError);
  if (target) {
    const { error } = await client.from("job_material_suppliers")
      .update({ is_main_supplier: true })
      .eq("job_id", job.id)
      .eq("supplier_id", target);
    if (error) {
      if (errorCode(error) === "23505") {
        refuse(
          409,
          "main_supplier_changed",
          "The main supplier was changed somewhere else. Reload and try again.",
        );
      }
      writeFailed("main supplier set", error);
    }
  }
  const [boxes, lines] = await Promise.all([
    readBoxes(client, job.id),
    readJobLines(client, job.id),
  ]);
  return {
    success: true,
    main_supplier_id: dispatchV2MainSupplierId(boxes, lines),
    main_supplier_ticked: boxes.some((b) => b.is_main_supplier === true),
  };
}

// ── Photos ──────────────────────────────────────────────────────────────────

async function readPhoto(client: any, jobId: string, id: unknown) {
  if (!isDispatchUuid(id)) badRequest("photo_id must be a uuid");
  const { data, error } = await client.from("dispatch_material_photos")
    .select(PHOTO_SELECT)
    .eq("id", id)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) readFailed("photo read", error);
  return data || null;
}

// Photos on an email that is held or being sent cannot be moved or removed
// (the email names them).
async function photoInUse(client: any, jobId: string, photoId: string) {
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select("id, status, photo_ids")
    .eq("job_id", jobId)
    .neq("status", "discarded");
  if (error) readFailed("emails read", error);
  return (data || []).find((e: any) =>
    (e.photo_ids || []).map(String).includes(photoId)
  ) ?? null;
}

export async function uploadDispatchV2Photo(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id === undefined
    ? null
    : supplierIdOrNull(body.supplier_id);
  if (supplierId) await boxOrRefuse(client, job.id, supplierId);
  const checked = dispatchV2CheckPhoto(body?.data_base64);
  if (!checked.ok) {
    refuse(
      checked.code === "photo_too_large" ? 413 : 400,
      checked.code,
      checked.error,
      checked.size_bytes ? { size_bytes: checked.size_bytes } : {},
    );
  }
  const { count, error: countError } = await client
    .from("dispatch_material_photos")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id);
  if (countError) readFailed("photo count", countError);
  if ((Number(count) || 0) >= DISPATCH_V2_PHOTOS_PER_JOB_MAX) {
    refuse(
      409,
      "too_many_photos",
      `A job holds at most ${DISPATCH_V2_PHOTOS_PER_JOB_MAX} photos`,
    );
  }
  const id = crypto.randomUUID();
  const fileName = dispatchV2PhotoFileName(body?.file_name, checked.extension);
  const path = `${job.id}/${id}.${checked.extension}`;
  const sha256 = await dispatchV2Sha256Hex(checked.bytes);
  const upload = await client.storage.from(DISPATCH_V2_PHOTO_BUCKET).upload(
    path,
    checked.bytes,
    { contentType: checked.contentType, upsert: false },
  );
  if (upload?.error) writeFailed("photo upload", upload.error);
  const { data: row, error } = await client.from("dispatch_material_photos")
    .insert({
      id,
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: supplierId,
      file_name: fileName,
      content_type: checked.contentType,
      size_bytes: checked.bytes.length,
      storage_path: path,
      sha256,
      created_at: nowIso(ctx),
      created_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
    })
    .select(PHOTO_SELECT)
    .single();
  if (error) {
    // Leave no stray file behind.
    await client.storage.from(DISPATCH_V2_PHOTO_BUCKET).remove([path]).catch(
      () => {},
    );
    if (errorCode(error) === "23503") {
      refuse(409, "supplier_not_on_job", "That supplier box is not on this job");
    }
    writeFailed("photo insert", error);
  }
  return { success: true, photo: projectPhoto(row) };
}

export async function moveDispatchV2Photo(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const photo = await readPhoto(client, job.id, body?.photo_id);
  if (!photo) refuse(404, "photo_not_found", "That photo was not found");
  if (body?.supplier_id === undefined) {
    badRequest("supplier_id required (null for the draft list)");
  }
  const target = supplierIdOrNull(body.supplier_id);
  if (String(photo.supplier_id ?? "") === String(target ?? "")) {
    return { success: true, unchanged: true, photo: projectPhoto(photo) };
  }
  if (target) await boxOrRefuse(client, job.id, target);
  const using = await photoInUse(client, job.id, photo.id);
  if (using) {
    refuse(
      409,
      "photo_on_email",
      "This photo is on an order email. Take it off the email first.",
    );
  }
  const { data, error } = await client.from("dispatch_material_photos")
    .update({ supplier_id: target })
    .eq("id", photo.id)
    .eq("job_id", job.id)
    .select(PHOTO_SELECT);
  if (error) writeFailed("photo move", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) refuse(404, "photo_not_found", "That photo was not found");
  return { success: true, photo: projectPhoto(row) };
}

export async function deleteDispatchV2Photo(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const photo = await readPhoto(client, job.id, body?.photo_id);
  if (!photo) return { success: true, unchanged: true };
  const using = await photoInUse(client, job.id, photo.id);
  if (using) {
    refuse(
      409,
      "photo_on_email",
      using.status === "sent"
        ? "This photo went out on a sent order email and is kept"
        : "This photo is on an order email. Take it off the email first.",
    );
  }
  const { error } = await client.from("dispatch_material_photos")
    .delete()
    .eq("id", photo.id)
    .eq("job_id", job.id);
  if (error) writeFailed("photo delete", error);
  const removed = await client.storage.from(DISPATCH_V2_PHOTO_BUCKET).remove([
    photo.storage_path,
  ]);
  if (removed?.error) {
    // The row is gone; a stray file is harmless and private.
    console.error("[dispatch_v2] photo file remove failed:", removed.error);
  }
  return { success: true };
}

export async function readDispatchV2PhotoUrl(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, params.get("job_id"), ctx);
  const photo = await readPhoto(client, job.id, params.get("photo_id"));
  if (!photo) refuse(404, "photo_not_found", "That photo was not found");
  const { data, error } = await client.storage.from(DISPATCH_V2_PHOTO_BUCKET)
    .createSignedUrl(photo.storage_path, DISPATCH_V2_PHOTO_LINK_SECONDS);
  if (error || !data?.signedUrl) readFailed("photo link", error);
  return {
    photo: projectPhoto(photo),
    url: data.signedUrl,
    expires_in_seconds: DISPATCH_V2_PHOTO_LINK_SECONDS,
  };
}

// ── Make email (the held email) ─────────────────────────────────────────────

async function boxContext(
  client: any,
  job: V2Job,
  supplierId: string,
  ctx: DispatchV2Context,
) {
  const box = await boxOrRefuse(client, job.id, supplierId);
  const [boxes, lines, approvedMap, contacts] = await Promise.all([
    readBoxes(client, job.id),
    readJobLines(client, job.id),
    readApprovedFor(client, [supplierId], ctx),
    readContacts(client, [supplierId], ctx),
  ]);
  const approved = approvedMap.get(supplierId) ?? null;
  const contact = contacts.get(supplierId);
  const isMain = dispatchV2MainSupplierId(boxes, lines) === supplierId;
  return {
    box,
    lines,
    approved,
    // Tweak 4: the approved name when linked ("BD Metals"), so the order row,
    // the crew pickup line and the reply cards name the supplier the way
    // Shaun does. The order email body never names the supplier.
    supplierName: dispatchV2SupplierDisplayName(
      approved,
      contact?.name || box.supplier_name,
    ),
    isMain,
    orderable: dispatchV2OrderableLines(lines, supplierId),
  };
}

function noApprovedEmail(): never {
  refuse(
    409,
    "no_approved_email",
    "This supplier has no approved order email, so Dispatch cannot send to it. Ask Shaun to add one.",
  );
}

// Make the held email for one supplier box, in the template, with To and CC
// from the approved list plus the team mailbox. An open email for the box is
// returned as it is (rebuild: true rebuilds it from the lines, losing edits).
// The box needs a line to order or a photo not sent yet (Tweak 5): a box with
// only photos makes a photo-only email ("Please see attached for materials
// needed."), and photos already sent on an earlier order are left off.
// fulfilment: "delivery" (the default) or "pickup" (no Address line). A
// rebuild without one keeps the open email's, read from its opening line.
// date_mode (piece C):
//   - "asap" writes "Date: ASAP" and needs no delivery_date; "date" works as
//     before. Either is saved on the box once the email has landed, with an
//     audit line, when it changes the box's choice.
//   - null: the box's own choice for its next email ("date" when a
//     delivery_date is given). Nothing is saved.
//   - left out (a screen from before piece C): exactly as before, the Date
//     line is the delivery_date given, blank without one (the send is then
//     refused). The box's choice is neither used nor saved.
export async function makeDispatchV2Email(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");
  const deliveryDate = body?.delivery_date ?? null;
  if (deliveryDate !== null && !isDispatchV2Date(deliveryDate)) {
    badRequest("delivery_date must be a date (YYYY-MM-DD) or null");
  }
  const asked = dispatchV2FulfilmentParam(body?.fulfilment);
  if (asked === undefined) {
    badRequest('fulfilment must be "delivery" or "pickup"');
  }
  const modeSent = !!body && typeof body === "object" && "date_mode" in body;
  const askedMode = dispatchV2DateModeParam(body?.date_mode);
  if (askedMode === undefined) {
    badRequest('date_mode must be "asap" or "date"');
  }
  if (askedMode === "asap" && deliveryDate !== null) {
    badRequest("An ASAP order has no delivery_date: leave it out, or choose Pick a date");
  }
  const rebuild = body?.rebuild === true;
  const info = await boxContext(client, job, supplierId, ctx);
  if (!info.approved) noApprovedEmail();
  // The box's photos not sent yet (Tweak 5): oldest first, at most three.
  const photoIds = await unsentBoxPhotoIds(client, job.id, supplierId);
  if (info.orderable.length === 0 && photoIds.length === 0) {
    refuse(
      409,
      "no_lines_to_order",
      "This supplier box has nothing to order. Add a line or a photo (In stock lines, and lines and photos already sent, are left out)",
    );
  }

  const { data: openRows, error: openError } = await client
    .from("dispatch_supplier_order_emails")
    .select(EMAIL_SELECT)
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId)
    .in("status", OPEN_EMAIL_STATUSES);
  if (openError) readFailed("open email read", openError);
  const open = (openRows || [])[0] ?? null;
  const nowMs = Date.parse(nowIso(ctx));
  if (open && (!rebuild || open.status !== "draft")) {
    return {
      success: true,
      unchanged: true,
      email: projectDispatchV2Email(open, nowMs),
    };
  }

  // The Date line: the choice asked for; null asks for the box's own
  // choice; left out keeps the behaviour from before piece C ("date").
  let dateMode: DispatchV2DateMode = "date";
  if (askedMode) {
    dateMode = askedMode;
  } else if (modeSent && deliveryDate === null) {
    dateMode = dispatchV2BoxDateMode({
      stored: info.box.order_date_mode,
      storedSetAt: info.box.order_date_mode_set_at,
      boxHasDate: !!info.box.delivery_date,
      newestSent: null,
      openEmail: open,
    }).mode;
  }
  const built = dispatchV2BuildEmail({
    job,
    workType: job.work_type,
    isMainSupplier: info.isMain,
    lines: info.orderable,
    deliveryDate,
    fulfilment: asked ?? (open ? dispatchV2FulfilmentOf(open.body_text) : null),
    dateMode,
    photoCount: photoIds.length,
  });
  const to = (info.approved.to_emails || []).map((e: string) =>
    String(e).toLowerCase()
  );
  const team = dispatchV2TeamCc(job.work_type);
  const cc = dispatchV2DefaultCc(info.approved.cc_emails || [], team.email, to);
  const now = nowIso(ctx);
  const values = {
    supplier_name: info.supplierName,
    approved_email_id: info.approved.id,
    work_type: job.work_type,
    is_main_supplier: info.isMain,
    standing_lines_included: built.standing_lines_included,
    team_cc_email: team.email,
    to_emails: to,
    cc_emails: cc,
    subject: built.subject,
    body_text: built.body_text,
    built_body_text: built.body_text,
    delivery_date: deliveryDate,
    order_lines: built.lines,
    photo_ids: photoIds,
    last_error: null,
    updated_at: now,
    updated_by_email: ctx.actor.email,
  };
  if (open) {
    const { data, error } = await client.from("dispatch_supplier_order_emails")
      .update(values)
      .eq("id", open.id)
      .eq("status", "draft")
      .eq("updated_at", open.updated_at)
      .select(EMAIL_SELECT);
    if (error) writeFailed("email rebuild", error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      refuse(409, "email_changed", "This email changed somewhere else. Reload it.");
    }
    return {
      success: true,
      rebuilt: true,
      email: projectDispatchV2Email(row, nowMs),
      missing: built.missing,
      photo_only: built.photo_only,
      date_mode: dateMode,
      date_mode_saved: await saveBoxDateMode(client, job.id, info.box, askedMode, ctx),
      team_cc_open_question: team.open_question,
    };
  }
  const { data: inserted, error: insertError } = await client
    .from("dispatch_supplier_order_emails")
    .insert({
      ...values,
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: supplierId,
      status: "draft",
      created_at: now,
      created_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
    })
    .select(EMAIL_SELECT)
    .single();
  if (insertError) {
    if (errorCode(insertError) === "23505") {
      // Another tab made it first: one open email per box.
      const { data: raced } = await client.from("dispatch_supplier_order_emails")
        .select(EMAIL_SELECT)
        .eq("job_id", job.id)
        .eq("supplier_id", supplierId)
        .in("status", OPEN_EMAIL_STATUSES);
      if (raced?.[0]) {
        return {
          success: true,
          unchanged: true,
          email: projectDispatchV2Email(raced[0], nowMs),
        };
      }
    }
    writeFailed("email insert", insertError);
  }
  return {
    success: true,
    email: projectDispatchV2Email(inserted, nowMs),
    missing: built.missing,
    photo_only: built.photo_only,
    date_mode: dateMode,
    date_mode_saved: await saveBoxDateMode(client, job.id, info.box, askedMode, ctx),
    team_cc_open_question: team.open_question,
  };
}

// The box's photos a new email takes (Tweak 5): oldest first, at most three,
// leaving out any photo already named on an email that went (or may have
// gone). The box's held email is not "gone", so a rebuild keeps its photos.
async function unsentBoxPhotoIds(
  client: any,
  jobId: string,
  supplierId: string,
): Promise<string[]> {
  const [photoRes, emailRes] = await Promise.all([
    client.from("dispatch_material_photos")
      .select("id, created_at")
      .eq("job_id", jobId)
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: true }),
    client.from("dispatch_supplier_order_emails")
      .select("id, status, photo_ids")
      .eq("job_id", jobId)
      .eq("supplier_id", supplierId),
  ]);
  if (photoRes.error) readFailed("box photos read", photoRes.error);
  if (emailRes.error) readFailed("box emails read", emailRes.error);
  return dispatchV2UnsentPhotoIds(photoRes.data || [], emailRes.data || []);
}

// Save the date choice a Make email was asked for on its box (piece C), so
// the panel and the next email show it. Called only once the email has
// landed. Answers:
//   null    nothing to save (no choice asked for, or the box already says so)
//   true    saved, with its audit line (dispatch_v2_date_mode_set)
//   false   the box could not be written: the email stands, the box keeps
//           its old choice, and the screen can set it with the toggle
// A failed audit line is logged; the choice stays saved.
async function saveBoxDateMode(
  client: any,
  jobId: string,
  box: any,
  mode: DispatchV2DateMode | null,
  ctx: DispatchV2Context,
): Promise<boolean | null> {
  if (!mode || box.order_date_mode === mode) return null;
  const { data, error } = await client.from("job_material_suppliers")
    .update({
      order_date_mode: mode,
      order_date_mode_set_at: nowIso(ctx),
      order_date_mode_set_by_email: ctx.actor.email,
    })
    .eq("id", box.id)
    .eq("org_id", ctx.orgId)
    .select("id");
  if (error || !(Array.isArray(data) ? data[0] : data)) {
    console.error("[dispatch_v2_store] box date choice write failed:", error);
    return false;
  }
  const { error: auditError } = await client.from("job_events").insert({
    job_id: jobId,
    user_id: ctx.actor.userId,
    event_type: "dispatch_v2_date_mode_set",
    detail_json: {
      box_id: box.id,
      supplier_id: box.supplier_id ?? null,
      supplier: box.supplier_name ?? null,
      from: box.order_date_mode ?? null,
      to: mode,
      via: "make_email",
      operator_email: ctx.actor.email,
    },
  });
  if (auditError) {
    console.error("[dispatch_v2_store] job_events insert failed:", auditError);
  }
  return true;
}

// Save edits to a held email: To, CC, subject, body and which photos go.
export async function saveDispatchV2Email(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const email = await readEmail(client, body?.email_id, ctx);
  await loadJob(client, email.job_id, ctx);
  const expected = expectedStamp(body?.expected_updated_at, true) as string;
  if (email.status !== "draft") {
    refuse(409, "email_not_editable", "Only a held email can be edited");
  }
  const patch: Record<string, unknown> = {
    updated_at: nowIso(ctx),
    updated_by_email: ctx.actor.email,
  };
  if (body?.to !== undefined) {
    patch.to_emails = field(
      cleanDispatchV2EmailList(body.to, "to", { min: 1, max: 10 }),
    );
  }
  if (body?.cc !== undefined) {
    patch.cc_emails = field(
      cleanDispatchV2EmailList(body.cc, "cc", { min: 0, max: 12 }),
    );
  }
  if (body?.subject !== undefined) {
    const subject = typeof body.subject === "string"
      ? body.subject.replace(/\s+/g, " ").trim()
      : "";
    if (!subject || subject.length > SUBJECT_MAX) {
      badRequest(`subject must be 1 to ${SUBJECT_MAX} characters`);
    }
    patch.subject = subject;
  }
  if (body?.body_text !== undefined) {
    const text = typeof body.body_text === "string"
      ? body.body_text.replace(/\r\n/g, "\n").trim()
      : "";
    if (!text || text.length > BODY_MAX) {
      badRequest(`body_text must be 1 to ${BODY_MAX} characters`);
    }
    patch.body_text = text;
  }
  if (body?.photo_ids !== undefined) {
    if (
      !Array.isArray(body.photo_ids) ||
      body.photo_ids.length > DISPATCH_V2_PHOTOS_PER_EMAIL_MAX ||
      !body.photo_ids.every(isDispatchUuid)
    ) {
      badRequest(
        `photo_ids must be a list of at most ${DISPATCH_V2_PHOTOS_PER_EMAIL_MAX} photo ids`,
      );
    }
    const ids = [...new Set<string>(body.photo_ids)];
    if (ids.length > 0) {
      const { data, error } = await client.from("dispatch_material_photos")
        .select("id")
        .eq("job_id", email.job_id)
        .in("id", ids);
      if (error) readFailed("photos read", error);
      if ((data || []).length !== ids.length) {
        refuse(409, "photo_not_found", "A photo on this email is not on the job");
      }
    }
    patch.photo_ids = ids;
  }
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .update(patch)
    .eq("id", email.id)
    .eq("status", "draft")
    .eq("updated_at", expected)
    .select(EMAIL_SELECT);
  if (error) writeFailed("email save", error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    const latest = await readEmail(client, email.id, ctx);
    refuse(409, "email_changed", "This email changed somewhere else", {
      email: projectDispatchV2Email(latest, Date.parse(nowIso(ctx))),
    });
  }
  return { success: true, email: projectDispatchV2Email(row, Date.parse(nowIso(ctx))) };
}

export async function discardDispatchV2Email(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const email = await readEmail(client, body?.email_id, ctx);
  await loadJob(client, email.job_id, ctx);
  const expected = expectedStamp(body?.expected_updated_at, true) as string;
  if (email.status === "discarded") return { success: true, unchanged: true };
  if (email.status !== "draft") {
    refuse(
      409,
      "email_not_discardable",
      email.status === "sent"
        ? "This email was sent and is kept"
        : "This email may have been sent. Check admin@ Sent Items first.",
    );
  }
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .update({
      status: "discarded",
      updated_at: nowIso(ctx),
      updated_by_email: ctx.actor.email,
    })
    .eq("id", email.id)
    .eq("status", "draft")
    .eq("updated_at", expected)
    .select("id");
  if (error) writeFailed("email discard", error);
  if (!Array.isArray(data) || data.length === 0) {
    refuse(409, "email_changed", "This email changed somewhere else. Reload it.");
  }
  return { success: true };
}

// ── Send now (and Send test) ────────────────────────────────────────────────

async function emailAttachments(client: any, email: any) {
  const ids: string[] = (email.photo_ids || []).map(String);
  if (ids.length === 0) return [];
  const { data, error } = await client.from("dispatch_material_photos")
    .select(PHOTO_SELECT + ", sha256")
    .eq("job_id", email.job_id)
    .in("id", ids);
  if (error) readFailed("email photos read", error);
  const rows = data || [];
  if (rows.length !== ids.length) {
    refuse(
      409,
      "photo_not_found",
      "A photo on this email was removed. Take it off the email and try again.",
    );
  }
  const out: { name: string; contentType: string; contentBytes: string }[] = [];
  for (const id of ids) {
    const photo = rows.find((r: any) => String(r.id) === id);
    const { data: blob, error: downloadError } = await client.storage.from(
      DISPATCH_V2_PHOTO_BUCKET,
    ).download(photo.storage_path);
    if (downloadError || !blob) readFailed("photo download", downloadError);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (await dispatchV2Sha256Hex(bytes) !== photo.sha256) {
      refuse(
        409,
        "photo_changed",
        "A photo on file is not the one that was uploaded. Nothing was sent.",
      );
    }
    out.push({
      name: photo.file_name,
      contentType: photo.content_type,
      contentBytes: dispatchV2BytesToBase64(bytes),
    });
  }
  return out;
}

// Send a held email. `test: true` sends the same email, clearly marked, to
// admin@ only and records it in the test_* columns: the email stays held and
// nothing is stamped. A test copy is optional (Shaun, 26 Oct). A real send
// needs an approved order email for the supplier, the Date,
// Address and Contact lines filled in (a pickup has no Address line, and its
// "(First name)" Contact line is never required), the box's lines unchanged
// since the email was made, and at least one line or one photo on the email
// (Tweak 5).
export async function sendDispatchV2Email(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const email = await readEmail(client, body?.email_id, ctx);
  const job = await loadJob(client, email.job_id, ctx);
  const expected = expectedStamp(body?.expected_updated_at, true) as string;
  const sender = senderEmail(ctx);
  const test = body?.test === true;
  const nowMs = Date.parse(nowIso(ctx));
  const status = isStaleSending(email, nowMs) ? "send_unknown" : email.status;
  if (!sameStamp(email.updated_at, expected)) {
    refuse(409, "email_changed", "This email changed somewhere else", {
      email: projectDispatchV2Email(email, nowMs),
    });
  }
  if (status === "send_unknown" && !test && body?.confirm_resend !== true) {
    refuse(
      409,
      "send_unknown",
      "We could not tell whether this email went. Check admin@ Sent Items. Send again only if it is not there (confirm_resend: true).",
      { email: projectDispatchV2Email(email, nowMs) },
    );
  }
  if (status !== "draft" && status !== "send_unknown") {
    refuse(409, "email_not_sendable", "This email is not waiting to be sent");
  }

  const info = await boxContext(client, job, String(email.supplier_id), ctx);
  if (!info.approved) noApprovedEmail();
  if (!dispatchV2SameLines(email.order_lines, info.orderable)) {
    refuse(
      409,
      "order_lines_changed",
      "The lines in this supplier box changed after the email was made. Make the email again.",
    );
  }
  // A photo-only email with every photo taken off would say "see attached"
  // with nothing attached.
  if (!dispatchV2EmailHasSomethingToOrder(email)) {
    refuse(
      409,
      "nothing_to_order",
      "This email has no lines and no photo. Put a photo back on it, or discard it.",
    );
  }
  const empty = dispatchV2EmptyDetailLines(email.body_text);
  if (empty.length > 0) {
    refuse(
      409,
      "email_details_missing",
      `Fill in the ${empty.join(", ")} line${empty.length > 1 ? "s" : ""} before sending`,
      { missing: empty },
    );
  }
  const attachments = await emailAttachments(client, email);
  const realTo: string[] = email.to_emails || [];
  const realCc: string[] = email.cc_emails || [];

  // A test goes only to admin@, never the supplier, so it is not an order.
  if (!test) {
    await (ctx.depositGate ?? assertJobDepositsBeforeWork)(
      client,
      String(job.id),
      "materials",
    );
  }
  if (test) {
    const marked = dispatchV2TestEmail({
      subject: email.subject,
      bodyText: email.body_text,
      to: realTo,
      cc: realCc,
    });
    const outcome = await ctx.sender({
      from: DISPATCH_V2_FROM_MAILBOX,
      to: [DISPATCH_V2_TEST_TO],
      cc: [],
      subject: marked.subject,
      htmlBody: dispatchV2BodyHtml(marked.body_text),
      signature: "shaun",
      capture_thread_ids: true,
      attachments,
    });
    if (outcome.kind !== "sent") {
      refuse(
        502,
        outcome.kind === "refused" ? "test_send_refused" : "test_send_unknown",
        `The test email ${
          outcome.kind === "refused" ? "was not sent" : "may not have gone"
        }: ${outcome.reason}`,
      );
    }
    const sentAt = nowIso(ctx);
    // Only the test columns. updated_at is left alone so the screen's
    // expected stamp still holds for the real send.
    const { data, error } = await client.from("dispatch_supplier_order_emails")
      .update({
        test_sent_at: sentAt,
        test_sent_to: DISPATCH_V2_TEST_TO,
        test_sent_by_email: sender,
        test_internet_message_id: outcome.ids.internet_message_id,
        test_conversation_id: outcome.ids.conversation_id,
      })
      .eq("id", email.id)
      .select(EMAIL_SELECT);
    if (error) {
      // The test went; failing to note it only means Shaun sends another.
      console.error("[dispatch_v2] test send record failed:", error);
    }
    const row = (Array.isArray(data) ? data[0] : data) ?? email;
    return {
      success: true,
      test: true,
      sent_to: DISPATCH_V2_TEST_TO,
      recorded: !error,
      email: projectDispatchV2Email(row, nowMs),
    };
  }

  // The claim: only one press, tab or terminal gets past this line.
  const claimedAt = nowIso(ctx);
  const { data: claimed, error: claimError } = await client
    .from("dispatch_supplier_order_emails")
    .update({
      status: "sending",
      send_claimed_at: claimedAt,
      last_error: null,
      updated_at: claimedAt,
      updated_by_email: sender,
    })
    .eq("id", email.id)
    .eq("status", email.status)
    .eq("updated_at", email.updated_at)
    .select("id");
  if (claimError) writeFailed("send claim", claimError);
  if (!Array.isArray(claimed) || claimed.length === 0) {
    refuse(409, "email_not_sendable", "This email is already being sent");
  }

  const outcome = await ctx.sender({
    from: DISPATCH_V2_FROM_MAILBOX,
    to: realTo,
    cc: realCc,
    subject: email.subject,
    htmlBody: dispatchV2BodyHtml(email.body_text),
    signature: "shaun",
    capture_thread_ids: true,
    attachments,
  });

  if (outcome.kind !== "sent") {
    const unknown = outcome.kind === "unknown";
    const ids = unknown ? outcome.ids : null;
    const { error } = await client.from("dispatch_supplier_order_emails")
      .update({
        status: unknown ? "send_unknown" : "draft",
        last_error: outcome.reason.slice(0, 1000),
        updated_at: nowIso(ctx),
        // An unknown send keeps whatever ids Outlook gave, so a reply can
        // still be matched if it did go.
        ...(ids
          ? {
            sent_internet_message_id: ids.internet_message_id,
            sent_conversation_id: ids.conversation_id,
            sent_graph_message_id: ids.graph_message_id,
          }
          : {}),
      })
      .eq("id", email.id)
      .eq("status", "sending");
    if (error) console.error("[dispatch_v2] send release failed:", error);
    refuse(
      502,
      unknown ? "send_unknown" : "send_refused",
      unknown
        ? "We could not tell whether this email went. Check admin@ Sent Items before trying again."
        : `Not sent: ${outcome.reason}`,
      { reason: outcome.reason },
    );
  }

  const sentAt = nowIso(ctx);
  let recorded = true;
  const { data: sentRows, error: sentError } = await client
    .from("dispatch_supplier_order_emails")
    .update({
      status: "sent",
      sent_at: sentAt,
      sent_by: ctx.actor.userId,
      sent_by_email: sender,
      sent_from_mailbox: DISPATCH_V2_FROM_MAILBOX,
      sent_to_emails: realTo,
      sent_cc_emails: realCc,
      sent_internet_message_id: outcome.ids.internet_message_id,
      sent_conversation_id: outcome.ids.conversation_id,
      sent_graph_message_id: outcome.ids.graph_message_id,
      last_error: null,
      updated_at: sentAt,
    })
    .eq("id", email.id)
    .select(EMAIL_SELECT);
  if (sentError) {
    recorded = false;
    console.error("[dispatch_v2] sent record failed:", sentError);
  }
  // Lock the lines that went out.
  const lineIds = (email.order_lines || []).map((l: any) => l?.line_id).filter(
    isDispatchUuid,
  );
  if (lineIds.length > 0) {
    const { error } = await client.from("job_material_lines")
      .update({ dispatch_order_email_id: email.id, updated_at: sentAt })
      .eq("job_id", job.id)
      .in("id", lineIds)
      .is("dispatch_order_email_id", null);
    if (error) {
      recorded = false;
      console.error("[dispatch_v2] line lock failed:", error);
    }
  }
  const row = (Array.isArray(sentRows) ? sentRows[0] : sentRows) ?? {
    ...email,
    status: "sent",
    sent_at: sentAt,
  };
  return {
    success: true,
    test: false,
    // false = the email went but noting it on the order (or locking its
    // lines) failed; the screen says so and nothing is sent again.
    recorded,
    email: projectDispatchV2Email(row, nowMs),
  };
}

function sameStamp(a: unknown, b: unknown): boolean {
  const left = Date.parse(String(a ?? ""));
  const right = Date.parse(String(b ?? ""));
  return Number.isFinite(left) && left === right;
}

// ── One entry for the action switch ─────────────────────────────────────────

export async function runDispatchV2Action(
  client: any,
  action: string,
  params: { get(name: string): string | null },
  body: any,
  ctx: DispatchV2Context,
) {
  switch (action) {
    case "dispatch_v2_materials":
      return await readDispatchV2Materials(client, params, ctx);
    case "dispatch_v2_supplier_search":
      return await searchDispatchV2Suppliers(client, params, ctx);
    case "dispatch_v2_photo_url":
      return await readDispatchV2PhotoUrl(client, params, ctx);
    case "dispatch_v2_save_line":
      return await saveDispatchV2Line(client, body, ctx);
    case "dispatch_v2_move_line":
      return await moveDispatchV2Line(client, body, ctx);
    case "dispatch_v2_delete_line":
      return await deleteDispatchV2Line(client, body, ctx);
    case "dispatch_v2_suggest_draft":
      return await suggestDispatchV2Draft(client, body, ctx);
    case "dispatch_v2_add_supplier":
      return await addDispatchV2Supplier(client, body, ctx);
    case "dispatch_v2_remove_supplier":
      return await removeDispatchV2Supplier(client, body, ctx);
    case "dispatch_v2_set_main_supplier":
      return await setDispatchV2MainSupplier(client, body, ctx);
    case "dispatch_v2_upload_photo":
      return await uploadDispatchV2Photo(client, body, ctx);
    case "dispatch_v2_move_photo":
      return await moveDispatchV2Photo(client, body, ctx);
    case "dispatch_v2_delete_photo":
      return await deleteDispatchV2Photo(client, body, ctx);
    case "dispatch_v2_make_email":
      return await makeDispatchV2Email(client, body, ctx);
    case "dispatch_v2_save_email":
      return await saveDispatchV2Email(client, body, ctx);
    case "dispatch_v2_discard_email":
      return await discardDispatchV2Email(client, body, ctx);
    case "dispatch_v2_send_email":
      return await sendDispatchV2Email(client, body, ctx);
    default:
      refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
}
