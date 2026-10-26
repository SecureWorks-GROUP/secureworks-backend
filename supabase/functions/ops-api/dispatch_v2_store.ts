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
//           dispatch-material-photos
//   sends   one email per real press of Send now (or Send test), through the
//           injected sender (production: send-outlook-email, from admin@).
// Never jobs, suppliers.email, purchase_orders, Xero, business_events,
// job_events, GHL or any SMS.
//
// v2 has no purchase orders. The v1 actions (dispatch_materials_*,
// dispatch_order_*) are left as they were; the v2 screen calls these instead.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`. A failed read is never "nothing there".

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
  dispatchV2BytesToBase64,
  dispatchV2CanSuggest,
  dispatchV2CheckPhoto,
  dispatchV2DefaultCc,
  dispatchV2EmptyDetailLines,
  dispatchV2MainSupplierId,
  dispatchV2OrderableLines,
  dispatchV2PhotoFileName,
  dispatchV2SameLines,
  dispatchV2Sha256Hex,
  dispatchV2SuggestionAllowed,
  dispatchV2TeamCc,
  dispatchV2TestEmail,
  isDispatchV2Date,
} from "./dispatch_v2_emails.ts";
import { fetchAllRows } from "./makesafe_compact_reads.ts";

// ── The send seam ───────────────────────────────────────────────────────────

// What the sender is asked to send. Production posts exactly this to
// send-outlook-email (dispatch_v2_send.ts); tests pass a fake.
export type DispatchV2OutlookPayload = {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  htmlBody: string;
  // The template has no sign-off, so the mailbox's signature is left off.
  signature: "none";
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

const LINE_SELECT =
  "id, job_id, supplier_id, description, quantity, unit, detail, profile, colour, status, purchase_order_id, dispatch_order_email_id, source, position, updated_at";
const BOX_SELECT =
  "supplier_id, supplier_name, position, is_main_supplier, created_at";
const PHOTO_SELECT =
  "id, job_id, supplier_id, file_name, content_type, size_bytes, storage_path, created_at, created_by_email";
const EMAIL_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, approved_email_id, work_type, is_main_supplier, standing_lines_included, status, team_cc_email, to_emails, cc_emails, subject, body_text, built_body_text, delivery_date, order_lines, photo_ids, test_sent_at, test_sent_to, test_sent_by_email, send_claimed_at, sent_at, sent_by_email, sent_from_mailbox, sent_to_emails, sent_cc_emails, sent_internet_message_id, sent_conversation_id, sent_graph_message_id, last_error, created_at, created_by_email, updated_at, updated_by_email";
const APPROVED_SELECT = "id, name, used_for, to_emails, cc_emails, active";
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
    from: DISPATCH_V2_FROM_MAILBOX,
    to: row?.to_emails || [],
    cc: row?.cc_emails || [],
    team_cc: row?.team_cc_email ?? null,
    subject: row?.subject,
    body_text: row?.body_text,
    edited: row?.body_text !== row?.built_body_text,
    delivery_date: row?.delivery_date ?? null,
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
  const [boxes, lines, photos, emails] = await Promise.all([
    readBoxes(client, job.id),
    readJobLines(client, job.id),
    readPhotos(client, job.id),
    readJobEmails(client, job.id),
  ]);
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
    can_suggest: dispatchV2CanSuggest(job.work_type, lines.length),
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
      return {
        supplier_id: id,
        name: contact?.is_active && contact?.name ? contact.name : box.supplier_name,
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
      };
    }),
  };
}

// ── Supplier search for Add supplier ────────────────────────────────────────

// The approved list first (each approved supplier with its Xero contacts),
// then every other active Xero supplier contact. Each row says whether it has
// an approved order email. `q` filters by name; no q lists everything
// approved and the first `limit` others.
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
  const linkedIds = activeLinks.map((l: any) => String(l.supplier_id));
  const contacts = await readContacts(client, linkedIds, ctx);

  const needle = q.toLowerCase();
  const approved: any[] = [];
  for (const entry of entries || []) {
    const entryContacts = activeLinks
      .filter((l: any) => String(l.approved_id) === String(entry.id))
      .map((l: any) => contacts.get(String(l.supplier_id)))
      .filter((c: any) => c && c.is_active === true);
    const nameHit = !needle || String(entry.name).toLowerCase().includes(needle);
    const shown = nameHit
      ? entryContacts
      : entryContacts.filter((c: any) =>
        String(c.name).toLowerCase().includes(needle)
      );
    if (!nameHit && shown.length === 0) continue;
    const base = {
      approved_id: entry.id,
      approved_name: entry.name,
      used_for: entry.used_for,
      to: entry.to_emails || [],
      cc: entry.cc_emails || [],
      has_approved_email: true,
    };
    if (shown.length === 0) {
      // Approved, but no Xero supplier contact is linked to it yet: it cannot
      // become a supplier box until one is.
      approved.push({
        ...base,
        supplier_id: null,
        name: entry.name,
        can_add: false,
        note: "No Xero supplier contact is linked to this approved supplier yet",
      });
      continue;
    }
    for (const contact of shown) {
      approved.push({
        ...base,
        supplier_id: contact.id,
        name: contact.name,
        can_add: true,
        note: null,
      });
    }
  }

  let others = client.from("suppliers")
    .select("id, name")
    .eq("org_id", ctx.orgId)
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(limit + linkedIds.length);
  if (q) others = others.ilike("name", `%${q}%`);
  const { data: rest, error: restError } = await others;
  if (restError) readFailed("supplier contacts search", restError);
  const linked = new Set(linkedIds);
  const otherRows = (rest || [])
    .filter((row: any) => !linked.has(String(row.id)))
    .slice(0, limit)
    .map((row: any) => ({
      supplier_id: row.id,
      name: row.name,
      approved_id: null,
      approved_name: null,
      used_for: null,
      to: [],
      cc: [],
      has_approved_email: false,
      can_add: true,
      note: "No approved order email: Dispatch will not send to this supplier",
    }));
  return { q, approved, others: otherRows };
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
// the same ids and the second clashes (23505 -> lines_exist), never twice.
async function suggestedLineId(jobId: string, index: number) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`dispatch-v2-draft-line:${jobId}:${index}`),
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
export async function suggestDispatchV2Draft(
  client: any,
  body: any,
  ctx: DispatchV2Context,
) {
  const job = await loadJob(client, bodyJobId(body), ctx);
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
  if ((Number(count) || 0) > 0) {
    refuse(409, "lines_exist", "This job already has lines");
  }
  // The scope only, never the pricing: with null pricing the extractor's
  // quote-lines fallback cannot run, so no price can become a line.
  const { data: scopeRow, error: scopeError } = await client.from("jobs")
    .select("id, scope_json")
    .eq("id", job.id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (scopeError) readFailed("scope read", scopeError);
  let items: any[];
  try {
    items = ctx.extractMaterialsFromScope(scopeRow?.scope_json ?? null, null);
  } catch (error) {
    console.error("[dispatch_v2] scope could not be read:", error);
    refuse(409, "scope_unreadable", "The job's scope could not be read");
  }
  const suggested = dispatchSuggestedLines(
    (items || []).filter((item) => dispatchV2SuggestionAllowed(item?.description)),
  );
  if (suggested.length === 0) return { success: true, added: 0, lines: [] };
  const now = nowIso(ctx);
  const ids = await Promise.all(
    suggested.map((_line, index) => suggestedLineId(job.id, index)),
  );
  const rows = suggested.map((line, index) => ({
    id: ids[index],
    org_id: job.org_id,
    job_id: job.id,
    supplier_id: null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    status: "not_reviewed",
    source: "scope",
    position: index + 1,
    created_at: now,
    updated_at: now,
    created_by: ctx.actor.userId,
    updated_by: ctx.actor.userId,
    created_by_email: ctx.actor.email,
    updated_by_email: ctx.actor.email,
  }));
  const { data: inserted, error: insertError } = await client
    .from("job_material_lines")
    .insert(rows)
    .select(LINE_SELECT);
  if (insertError) {
    if (errorCode(insertError) === "23505") {
      refuse(409, "lines_exist", "This job already has lines");
    }
    writeFailed("suggested lines insert", insertError);
  }
  const out: any[] = Array.isArray(inserted) ? inserted : [];
  out.sort((a, b) => Number(a.position) - Number(b.position));
  return { success: true, added: out.length, lines: out.map(projectDispatchV2Line) };
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
      name: contact.name,
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
      if (raced) return answer(raced, true);
    }
    writeFailed("supplier box insert", error);
  }
  return answer(inserted);
}

// A box goes only when it is empty (no line, no photo) and has no order email
// that is held, sending or sent.
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
  const [lineRes, photoRes, emailRes] = await Promise.all([
    client.from("job_material_lines").select("id").eq("job_id", job.id).eq(
      "supplier_id",
      supplierId,
    ).limit(1),
    client.from("dispatch_material_photos").select("id").eq("job_id", job.id)
      .eq("supplier_id", supplierId).limit(1),
    client.from("dispatch_supplier_order_emails").select("id").eq(
      "job_id",
      job.id,
    ).eq("supplier_id", supplierId).neq("status", "discarded").limit(1),
  ]);
  if (lineRes.error) readFailed("box lines read", lineRes.error);
  if (photoRes.error) readFailed("box photos read", photoRes.error);
  if (emailRes.error) readFailed("box emails read", emailRes.error);
  const hasLines = () =>
    refuse(
      409,
      "supplier_has_lines",
      "Move this supplier's lines and photos out first",
    );
  if ((lineRes.data || []).length > 0 || (photoRes.data || []).length > 0) {
    hasLines();
  }
  if ((emailRes.data || []).length > 0) {
    refuse(
      409,
      "supplier_has_emails",
      "This supplier has an order email on this job",
    );
  }
  const { error } = await client.from("job_material_suppliers")
    .delete()
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId);
  if (error) {
    if (errorCode(error) === "23503") hasLines();
    writeFailed("supplier box delete", error);
  }
  return { success: true };
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
    supplierName: contact?.name || box.supplier_name,
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
  const rebuild = body?.rebuild === true;
  const info = await boxContext(client, job, supplierId, ctx);
  if (!info.approved) noApprovedEmail();
  if (info.orderable.length === 0) {
    refuse(
      409,
      "no_lines_to_order",
      "This supplier box has no lines to order (In stock and sent lines are left out)",
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

  const built = dispatchV2BuildEmail({
    job,
    workType: job.work_type,
    isMainSupplier: info.isMain,
    lines: info.orderable,
    deliveryDate,
  });
  const to = (info.approved.to_emails || []).map((e: string) =>
    String(e).toLowerCase()
  );
  const team = dispatchV2TeamCc(job.work_type);
  const cc = dispatchV2DefaultCc(info.approved.cc_emails || [], team.email, to);
  // The box's photos go on by default (at most three).
  const { data: boxPhotos, error: photoError } = await client
    .from("dispatch_material_photos")
    .select("id")
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId)
    .order("created_at", { ascending: true })
    .limit(DISPATCH_V2_PHOTOS_PER_EMAIL_MAX);
  if (photoError) readFailed("box photos read", photoError);
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
    photo_ids: (boxPhotos || []).map((p: any) => p.id),
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
    team_cc_open_question: team.open_question,
  };
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
// Address and Contact lines filled in, and the box's lines unchanged since the
// email was made.
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
      signature: "none",
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
    signature: "none",
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
