// Group work orders (owner, confirmed 21 Oct 2026).
//
// The pot is the sealed agreed_labour_ex on the job's work order. A
// participating trade who has submitted their own hours may see that total
// and their own share, and nothing about anyone else. That read is the one
// exception to "trades cannot read agreed_labour_ex". A non-participant
// still cannot.
//
// A job is paid either as a normal work-order / hours claim or as this
// split, never both. Share lines are quantity 1 at the share, with
// source_work_order_id left null.
//
// DEFAULT, owner to confirm: break minutes come off finish minus start,
// the same formula as trade invoice time entries. This module does not
// invent a second hours rule; it calls resolveTradeInvoiceTimeEntry.
//
// Nothing here sends a text, an email or a review request.

import { GOOGLE_REVIEW_URL as SEEDED_GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";
import { WORK_ORDER_LOCK_LINE_TYPES } from "./trade_invoice_assignment_lock.ts";
import {
  isTradeInvoiceTimeLineType,
  resolveTradeInvoiceTimeEntry,
} from "./trade_invoice_time_entry.ts";

export const GROUP_WORK_ORDER_CLIENT_LINK_FLAG =
  "group_work_order_client_link_send_v1";

/** Line type written on a share. Not a time type and not a work-order lock type. */
export const GROUP_SHARE_LINE_TYPE = "group share";

/**
 * Invoice statuses that hold nothing. Same set as RELEASED_INVOICE_STATUSES
 * in index.ts (draft, failed, ops-reject). A test pins the two literals.
 */
export const GROUP_FENCE_RELEASED_INVOICE_STATUSES = [
  "draft",
  "failed",
  "ops-reject",
] as const;

export const OFFICE_FEEDBACK_NOTICE =
  "These ratings go to the office. They are not viewed by the installers.";

export const FEEDBACK_DIMENSIONS = [
  "sales_process",
  "communication",
  "cleanliness",
  "punctuality",
  "crew",
] as const;

export type FeedbackDimension = typeof FEEDBACK_DIMENSIONS[number];

/** Keys a participating trade's my-share response is allowed to carry. */
export const PARTICIPANT_SHARE_KEYS = [
  "pot_total",
  "my_share",
  "needs_hours",
  "client_signed",
  "group_id",
] as const;

const STAFF_ROLES = new Set(["admin", "owner", "ops_manager"]);
const NOT_A_CLAIM = new Set([
  "travel",
  "materials",
  "equipment",
  "adjustment",
  "final_payout_deduction",
  "final payout deduction",
]);

export class GroupWorkOrderError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "GroupWorkOrderError";
    this.code = code;
    this.status = status;
  }
}

export type GroupCaller = {
  userId: string;
  orgId: string | null;
  role: string;
  isStaff: boolean;
};

type SharePerson = { userId: string; pointsMicro: bigint };

export function moneyToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToMoney(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/**
 * Floor each share to a cent, then give leftover cents to the largest
 * remainders. Equal remainders go to the smaller user id first.
 * The shares sum to potCents exactly.
 */
export function allocatePotCents(
  potCents: number,
  people: readonly SharePerson[],
): { userId: string; shareCents: number }[] {
  if (!Number.isInteger(potCents) || potCents <= 0) {
    throw new GroupWorkOrderError(
      "group_pot_missing",
      "This job's work order has no agreed labour price to split.",
    );
  }
  const eligible = people.filter((person) => person.pointsMicro > 0n);
  if (eligible.length === 0) {
    throw new GroupWorkOrderError(
      "group_share_hours_missing",
      "Nobody on this group has hours with a rate yet, so there is nothing to split.",
    );
  }
  const total = eligible.reduce((sum, person) => sum + person.pointsMicro, 0n);
  const pot = BigInt(potCents);
  const rows = eligible.map((person) => {
    const raw = pot * person.pointsMicro;
    return {
      userId: person.userId,
      floor: raw / total,
      remainder: raw % total,
    };
  });
  const floored = rows.reduce((sum, row) => sum + Number(row.floor), 0);
  const leftover = potCents - floored;
  if (leftover < 0 || leftover >= rows.length) {
    throw new GroupWorkOrderError(
      "group_share_rounding_failed",
      "The share split could not be rounded to the pot.",
      500,
    );
  }
  rows.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const extra = new Map<string, number>();
  for (let i = 0; i < leftover; i++) {
    extra.set(rows[i].userId, (extra.get(rows[i].userId) || 0) + 1);
  }
  return rows
    .map((row) => ({
      userId: row.userId,
      shareCents: Number(row.floor) + (extra.get(row.userId) || 0),
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : 1));
}

export function entryPointsMicro(rateEx: number, hours: number): bigint {
  const rateCents = BigInt(Math.round(rateEx * 100));
  const hourHundredths = BigInt(Math.round(hours * 100));
  if (rateCents <= 0n || hourHundredths <= 0n) return 0n;
  return rateCents * hourHundredths;
}

export function pointsDollars(pointsMicro: bigint): number {
  return Number((Number(pointsMicro) / 10000).toFixed(4));
}

/** Rate in force on a calendar day. Latest effective_from wins. */
export function rateOnDay(
  rates: readonly {
    hourly_rate: unknown;
    effective_from?: string | null;
    effective_to?: string | null;
  }[],
  workDate: string,
): number | null {
  const matching = rates.filter((rate) => {
    const from = String(rate.effective_from || "");
    const to = rate.effective_to ? String(rate.effective_to) : null;
    if (from && from > workDate) return false;
    if (to && to < workDate) return false;
    return Number(rate.hourly_rate) > 0;
  });
  matching.sort((a, b) =>
    String(a.effective_from || "") < String(b.effective_from || "") ? 1 : -1
  );
  if (matching.length === 0) return null;
  return Number(matching[0].hourly_rate);
}

export function callerIsStaff(role: unknown): boolean {
  return STAFF_ROLES.has(String(role || "").toLowerCase());
}

export function participantShareResponse(input: {
  groupId: string;
  clientSigned: boolean;
  ownHours: number;
  potEx: number | null;
  myShareEx: number | null;
}): Record<string, unknown> {
  const submitted = input.ownHours > 0;
  const response: Record<string, unknown> = {
    pot_total: submitted ? input.potEx : null,
    my_share: submitted ? input.myShareEx : null,
    needs_hours: !submitted,
    client_signed: input.clientSigned,
    group_id: input.groupId,
  };
  return response;
}

export function participantShareResponseIsClosed(
  response: Record<string, unknown>,
): boolean {
  const keys = Object.keys(response).sort();
  const allowed = [...PARTICIPANT_SHARE_KEYS].sort();
  return keys.length === allowed.length &&
    keys.every((key, index) => key === allowed[index]);
}

/**
 * Rows a trade may see. Staff see every row. A trade sees only their own,
 * so another job's pot and another person's share never leave the server.
 */
export function visibleShareRows<T extends { user_id: string }>(
  callerId: string,
  isStaff: boolean,
  rows: readonly T[],
): T[] {
  if (isStaff) return [...rows];
  return rows.filter((row) => row.user_id === callerId);
}

export type FenceLine = {
  job_id?: string | null;
  line_type?: string | null;
  type?: string | null;
  source_work_order_id?: string | null;
  group_share_id?: string | null;
  total_hours?: number | null;
  hourly_rate?: number | null;
  user_id?: string | null;
};

export function fenceLineType(line: FenceLine): string {
  const named = line.line_type || line.type;
  if (named) {
    return String(named).toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ")
      .trim();
  }
  if (line.hourly_rate != null && line.total_hours != null) return "labour";
  return "";
}

export function isGroupShareLine(line: FenceLine): boolean {
  if (line.group_share_id) return true;
  return fenceLineType(line) === GROUP_SHARE_LINE_TYPE;
}

export function isGroupShareInvoiceItem(
  item: {
    type?: unknown;
    line_type?: unknown;
  } | null,
): boolean {
  if (!item) return false;
  const raw = String(item.type || item.line_type || "").toLowerCase().replace(
    /_/g,
    " ",
  ).replace(/\s+/g, " ").trim();
  return raw === GROUP_SHARE_LINE_TYPE;
}

export function isNormalWorkOrderPayLine(line: FenceLine): boolean {
  if (isGroupShareLine(line)) return false;
  const type = fenceLineType(line);
  if (NOT_A_CLAIM.has(type)) return false;
  if (WORK_ORDER_LOCK_LINE_TYPES.includes(type)) return true;
  if (isTradeInvoiceTimeLineType(type)) return true;
  return Boolean(line.source_work_order_id);
}

export function findFenceProblem(
  submittingUserId: string,
  submitting: readonly FenceLine[],
  live: readonly FenceLine[],
): { code: string; message: string } | null {
  const jobIds = new Set<string>();
  for (const line of [...submitting, ...live]) {
    if (line.job_id) jobIds.add(String(line.job_id));
  }
  for (const jobId of jobIds) {
    const sub = submitting.filter((line) =>
      String(line.job_id || "") === jobId
    );
    const prior = live.filter((line) => String(line.job_id || "") === jobId);
    const subShare = sub.filter(isGroupShareLine);
    const subPay = sub.filter(isNormalWorkOrderPayLine);
    const priorShare = prior.filter(isGroupShareLine);
    const priorPay = prior.filter(isNormalWorkOrderPayLine);
    const priorMine = priorShare.filter((line) =>
      String(line.user_id || "") === submittingUserId
    );
    if (subShare.length > 1) {
      return {
        code: "group_share_duplicate_line",
        message:
          "This invoice has two group shares for the same job. Keep one.",
      };
    }
    if (subShare.length > 0 && subPay.length > 0) {
      return {
        code: "group_share_mixed_with_hours",
        message:
          "This job is on a group work order, so it cannot also be billed as hours or a normal work order on the same invoice.",
      };
    }
    if (subShare.length > 0 && priorPay.length > 0) {
      return {
        code: "group_share_blocked_by_work_order_claim",
        message:
          "This job already has a live work-order or hours claim, so a group share cannot be invoiced.",
      };
    }
    if (subPay.length > 0 && priorShare.length > 0) {
      return {
        code: "work_order_claim_blocked_by_group_share",
        message:
          "This job already has a live group share, so it cannot also be billed as hours or a normal work order.",
      };
    }
    if (subShare.length > 0 && priorMine.length > 0) {
      return {
        code: "group_share_already_invoiced",
        message: "Your share of this job is already on a live invoice.",
      };
    }
  }
  return null;
}

export function feedbackRatings(body: Record<string, unknown>): {
  ratings: Record<FeedbackDimension, number>;
  comments: Record<FeedbackDimension, string | null>;
} {
  const ratings = {} as Record<FeedbackDimension, number>;
  const comments = {} as Record<FeedbackDimension, string | null>;
  for (const dimension of FEEDBACK_DIMENSIONS) {
    const raw = body[dimension];
    const record = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : { rating: raw };
    const rating = Number(record.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new GroupWorkOrderError(
        "group_feedback_rating_invalid",
        `Rate ${dimension.replace(/_/g, " ")} from 1 to 5.`,
      );
    }
    ratings[dimension] = rating;
    const comment = record.comment == null ? "" : String(record.comment).trim();
    comments[dimension] = comment ? comment.slice(0, 2000) : null;
  }
  return { ratings, comments };
}

export function promptGoogleReview(
  ratings: readonly number[],
  minimum: number,
): boolean {
  return ratings.length === FEEDBACK_DIMENSIONS.length &&
    ratings.every((rating) => rating >= minimum);
}

/**
 * DEFAULT, owner to confirm: break is subtracted, via the time-entry rule.
 * Start and finish stay required. The server computes the hours.
 */
export function groupHoursFromBody(
  body: Record<string, unknown>,
  today?: string,
) {
  const entry = resolveTradeInvoiceTimeEntry(body, {
    required: true,
    clientHours: body.hours,
    label: "group work order",
    today,
  });
  if (!entry) {
    throw new GroupWorkOrderError(
      "time_entry_required",
      "Enter the date you worked and your start and finish time.",
    );
  }
  return entry;
}

export function draftClientLinkMessage(input: {
  firstName?: string | null;
  site?: string | null;
  link?: string | null;
}): string {
  const first = String(input.firstName || "").trim() || "there";
  const site = String(input.site || "").trim() || "your job";
  const link = String(input.link || "").trim() || "{link}";
  return `Hi ${first}, your work at ${site} is finished. Please open this link to sign the job off and tell the office how it went. The installers do not see what you write. ${link} Thanks, Shaun`;
}

export function refuseClientLinkSend(body: { send?: unknown } | null): void {
  if (body?.send === true || body?.send === "true") {
    throw new GroupWorkOrderError(
      "client_message_disabled",
      "Sending the client sign-off link is switched off. Nothing was sent.",
      409,
    );
  }
}

export function newShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function throwQuery(error: { message?: string } | null, what: string): void {
  if (error) {
    throw new GroupWorkOrderError(
      "group_work_order_unreadable",
      `Could not ${what}.`,
      503,
    );
  }
}

async function rowsOf(
  query: PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  what: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  throwQuery(error, what);
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

function liveAssignment(row: Record<string, unknown>): boolean {
  if (row.is_ghost === true) return false;
  return String(row.status || "").toLowerCase() !== "cancelled";
}

async function callerAssigned(
  client: any,
  jobId: string,
  userId: string,
): Promise<boolean> {
  const rows = await rowsOf(
    client.from("job_assignments").select("id, status, is_ghost").eq(
      "job_id",
      jobId,
    ).eq("user_id", userId),
    "check the crew assignment",
  );
  return rows.some(liveAssignment);
}

async function loadJob(client: any, jobId: string) {
  const { data, error } = await client.from("jobs").select(
    "id, org_id, job_number, client_name, site_address, site_suburb, type, work_order_id, status",
  ).eq("id", jobId).maybeSingle();
  throwQuery(error, "load the job");
  return data as Record<string, unknown> | null;
}

async function loadWorkOrder(client: any, workOrderId: string) {
  const { data, error } = await client.from("work_orders").select(
    "id, org_id, job_id, kind, status, agreed_labour_ex, sealed_content_hash",
  ).eq("id", workOrderId).maybeSingle();
  throwQuery(error, "load the job work order");
  return data as Record<string, unknown> | null;
}

function potFromWorkOrder(workOrder: Record<string, unknown> | null): number {
  if (
    !workOrder || workOrder.kind !== "job" || workOrder.status !== "approved" ||
    !workOrder.sealed_content_hash
  ) {
    throw new GroupWorkOrderError(
      "group_pot_missing",
      "This job's work order is not an approved sealed labour price yet.",
    );
  }
  const cents = moneyToCents(workOrder.agreed_labour_ex);
  if (cents == null || cents <= 0) {
    throw new GroupWorkOrderError(
      "group_pot_missing",
      "This job's work order has no agreed labour price to split.",
    );
  }
  return centsToMoney(cents);
}

async function loadGroupById(client: any, groupId: string) {
  const { data, error } = await client.from("group_work_orders").select(
    "id, org_id, job_id, work_order_id, status, share_token, client_signed_at, created_by",
  ).eq("id", groupId).maybeSingle();
  throwQuery(error, "load the group");
  return data as Record<string, unknown> | null;
}

async function loadGroupByJob(client: any, jobId: string) {
  const rows = await rowsOf(
    client.from("group_work_orders").select(
      "id, org_id, job_id, work_order_id, status, share_token, client_signed_at, created_by",
    ).eq("job_id", jobId),
    "load the group",
  );
  return rows[0] || null;
}

async function loadGroupByToken(client: any, token: string) {
  const { data, error } = await client.from("group_work_orders").select(
    "id, org_id, job_id, work_order_id, status, share_token, client_signed_at",
  ).eq("share_token", token).maybeSingle();
  throwQuery(error, "load the sign-off link");
  return data as Record<string, unknown> | null;
}

async function loadParticipants(client: any, groupId: string) {
  return await rowsOf(
    client.from("group_work_order_participants").select(
      "id, group_id, user_id, joined_at, crew_signed_at, signature_name",
    ).eq("group_id", groupId),
    "load the crew",
  );
}

function requireParticipant(
  participants: readonly Record<string, unknown>[],
  userId: string,
): void {
  if (!participants.some((row) => String(row.user_id) === userId)) {
    throw new GroupWorkOrderError(
      "group_work_order_not_participant",
      "You are not on this group work order.",
      403,
    );
  }
}

async function resolveGroup(
  client: any,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const groupId = String(body.group_id || "").trim();
  const jobId = String(body.job_id || body.jobId || "").trim();
  const group = groupId
    ? await loadGroupById(client, groupId)
    : jobId
    ? await loadGroupByJob(client, jobId)
    : null;
  if (!group) {
    throw new GroupWorkOrderError(
      "group_work_order_not_found",
      "There is no group work order for that job.",
      404,
    );
  }
  if (group.status === "void") {
    throw new GroupWorkOrderError(
      "group_work_order_void",
      "This group work order has been voided.",
      409,
    );
  }
  return group;
}

function groupIsSigned(group: Record<string, unknown>): boolean {
  return group.status === "client_signed" || Boolean(group.client_signed_at);
}

export async function createGroupWorkOrder(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  const jobId = String(body.job_id || body.jobId || "").trim();
  if (!jobId) {
    throw new GroupWorkOrderError("group_job_required", "Name the job.", 400);
  }
  const job = await loadJob(client, jobId);
  if (!job) {
    throw new GroupWorkOrderError(
      "group_job_not_found",
      "That job was not found.",
      404,
    );
  }
  const assigned = await callerAssigned(client, jobId, caller.userId);
  if (!assigned && !caller.isStaff) {
    throw new GroupWorkOrderError(
      "group_work_order_not_assigned",
      "You are not allocated to this job.",
      403,
    );
  }
  const workOrderId = String(job.work_order_id || "");
  if (!workOrderId) {
    throw new GroupWorkOrderError(
      "group_pot_missing",
      "This job has no job work order to split.",
    );
  }
  const existing = await loadGroupByJob(client, jobId);
  if (existing) {
    if (String(existing.work_order_id) !== workOrderId) {
      throw new GroupWorkOrderError(
        "group_work_order_exists",
        "This job already has a group on a different work order.",
        409,
      );
    }
    const participants = await loadParticipants(client, String(existing.id));
    if (!participants.some((row) => String(row.user_id) === caller.userId)) {
      if (!assigned && !caller.isStaff) {
        throw new GroupWorkOrderError(
          "group_work_order_not_participant",
          "You are not on this group work order.",
          403,
        );
      }
      await insertParticipant(client, String(existing.id), caller.userId);
    }
    return publicGroupCard(existing);
  }
  // Read the pot only to refuse a group that can never be invoiced.
  // The amount is not returned.
  potFromWorkOrder(await loadWorkOrder(client, workOrderId));
  const token = newShareToken();
  const { data, error } = await client.from("group_work_orders").insert({
    org_id: job.org_id || caller.orgId,
    job_id: jobId,
    work_order_id: workOrderId,
    status: "open",
    share_token: token,
    created_by: caller.userId,
  }).select(
    "id, org_id, job_id, work_order_id, status, share_token, client_signed_at",
  ).single();
  throwQuery(error, "open the group");
  await insertParticipant(client, String(data.id), caller.userId);
  return publicGroupCard(data);
}

async function insertParticipant(client: any, groupId: string, userId: string) {
  const { error } = await client.from("group_work_order_participants").insert({
    group_id: groupId,
    user_id: userId,
  });
  throwQuery(error, "join the group");
}

function publicGroupCard(group: Record<string, unknown>) {
  return {
    ok: true,
    group_id: group.id,
    job_id: group.job_id,
    share_token: group.share_token,
    status: group.status,
    client_signed: groupIsSigned(group),
  };
}

export async function joinGroupWorkOrder(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  const group = await resolveGroup(client, body);
  const jobId = String(group.job_id);
  const assigned = await callerAssigned(client, jobId, caller.userId);
  if (!assigned && !caller.isStaff) {
    throw new GroupWorkOrderError(
      "group_work_order_not_assigned",
      "You are not allocated to this job.",
      403,
    );
  }
  const participants = await loadParticipants(client, String(group.id));
  if (!participants.some((row) => String(row.user_id) === caller.userId)) {
    await insertParticipant(client, String(group.id), caller.userId);
  }
  return publicGroupCard(group);
}

export async function signGroupWorkOrderCrew(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  const group = await resolveGroup(client, body);
  const participants = await loadParticipants(client, String(group.id));
  requireParticipant(participants, caller.userId);
  const name = String(body.signer_name || body.signature_name || "").trim();
  if (!name) {
    throw new GroupWorkOrderError(
      "group_signature_name_required",
      "Enter your name with your signature.",
      400,
    );
  }
  const png = signaturePng(body.signature_png);
  const signedAt = new Date().toISOString();
  const { error: sigError } = await client.from("group_work_order_signatures")
    .insert({
      group_id: group.id,
      signer_kind: "crew",
      user_id: caller.userId,
      signer_name: name,
      signature_png: png,
      signed_via: "on_site",
      captured_by_user_id: caller.userId,
      signed_at: signedAt,
    });
  throwQuery(sigError, "store the signature");
  const { error } = await client.from("group_work_order_participants").update({
    crew_signed_at: signedAt,
    signature_name: name,
  }).eq("group_id", group.id).eq("user_id", caller.userId);
  throwQuery(error, "record that you signed");
  return { ok: true, crew_signed: true, client_signed: groupIsSigned(group) };
}

function signaturePng(value: unknown): string | null {
  if (value == null || value === "") return null;
  const png = String(value);
  if (png.length > 200000) {
    throw new GroupWorkOrderError(
      "group_signature_too_large",
      "That signature image is too large.",
    );
  }
  return png;
}

export async function submitGroupWorkOrderHours(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  const group = await resolveGroup(client, body);
  const participants = await loadParticipants(client, String(group.id));
  requireParticipant(participants, caller.userId);
  const entry = groupHoursFromBody(body);
  const { error } = await client.from("group_work_order_time_entries").upsert({
    group_id: group.id,
    user_id: caller.userId,
    work_date: entry.work_date,
    start_time: entry.start_time,
    finish_time: entry.finish_time,
    break_minutes: entry.break_minutes,
    hours: entry.hours,
  }, { onConflict: "group_id,user_id,work_date" });
  throwQuery(error, "save your hours");
  return await readGroupWorkOrderMyShare(client, caller, {
    group_id: group.id,
  });
}

export async function readGroupWorkOrderMyShare(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  const group = await resolveGroup(client, body);
  const participants = await loadParticipants(client, String(group.id));
  // Before any price is read. A non-participant gets no number.
  requireParticipant(participants, caller.userId);
  const entries = await rowsOf(
    client.from("group_work_order_time_entries").select(
      "user_id, work_date, hours",
    ).eq("group_id", group.id),
    "load hours",
  );
  const ownHours = entries
    .filter((row) => String(row.user_id) === caller.userId)
    .reduce((sum, row) => sum + Number(row.hours || 0), 0);
  if (ownHours <= 0) {
    return participantShareResponse({
      groupId: String(group.id),
      clientSigned: groupIsSigned(group),
      ownHours: 0,
      potEx: null,
      myShareEx: null,
    });
  }
  const split = await computeShares(client, group, entries);
  const mine = split.find((row) => row.user_id === caller.userId);
  return participantShareResponse({
    groupId: String(group.id),
    clientSigned: groupIsSigned(group),
    ownHours,
    potEx: mine ? Number(mine.pot_ex) : null,
    myShareEx: mine ? Number(mine.share_ex) : null,
  });
}

async function computeShares(
  client: any,
  group: Record<string, unknown>,
  entries: readonly Record<string, unknown>[],
) {
  const existing = await rowsOf(
    client.from("group_work_order_shares").select(
      "id, group_id, user_id, hours, points, share_ex, pot_ex",
    ).eq("group_id", group.id),
    "load shares",
  );
  if (await sharesAreFrozen(client, existing)) return existing;
  const potEx = potFromWorkOrder(
    await loadWorkOrder(client, String(group.work_order_id)),
  );
  const userIds = [...new Set(entries.map((row) => String(row.user_id)))];
  const rates = userIds.length === 0 ? [] : await rowsOf(
    client.from("trade_rates").select(
      "user_id, hourly_rate, effective_from, effective_to",
    ).eq("org_id", group.org_id).in("user_id", userIds),
    "load rates",
  );
  const pointsByUser = new Map<string, bigint>();
  const hoursByUser = new Map<string, number>();
  for (const entry of entries) {
    const userId = String(entry.user_id);
    const hours = Number(entry.hours || 0);
    const mine = rates.filter((rate) => String(rate.user_id) === userId);
    const rate = rateOnDay(
      mine.map((row) => ({
        hourly_rate: row.hourly_rate,
        effective_from: row.effective_from == null
          ? null
          : String(row.effective_from),
        effective_to: row.effective_to == null
          ? null
          : String(row.effective_to),
      })),
      String(entry.work_date),
    );
    if (rate == null || hours <= 0) continue;
    pointsByUser.set(
      userId,
      (pointsByUser.get(userId) || 0n) + entryPointsMicro(rate, hours),
    );
    hoursByUser.set(userId, (hoursByUser.get(userId) || 0) + hours);
  }
  const people = [...pointsByUser.entries()].map(([userId, pointsMicro]) => ({
    userId,
    pointsMicro,
  }));
  const potCents = moneyToCents(potEx) || 0;
  const allocated = allocatePotCents(potCents, people);
  const now = new Date().toISOString();
  const nextIds = new Set(allocated.map((row) => row.userId));
  for (const old of existing) {
    if (!nextIds.has(String(old.user_id))) {
      const { error } = await client.from("group_work_order_shares").delete()
        .eq("id", old.id);
      throwQuery(error, "update the split");
    }
  }
  if (allocated.length > 0) {
    const { error } = await client.from("group_work_order_shares").upsert(
      allocated.map((row) => ({
        group_id: group.id,
        user_id: row.userId,
        hours: Number((hoursByUser.get(row.userId) || 0).toFixed(2)),
        points: pointsDollars(
          pointsByUser.get(row.userId) || 0n,
        ),
        share_ex: centsToMoney(row.shareCents),
        pot_ex: potEx,
        computed_at: now,
      })),
      { onConflict: "group_id,user_id" },
    );
    throwQuery(error, "save the split");
  }
  return await rowsOf(
    client.from("group_work_order_shares").select(
      "id, group_id, user_id, hours, points, share_ex, pot_ex",
    ).eq("group_id", group.id),
    "load shares",
  );
}

async function sharesAreFrozen(
  client: any,
  shares: readonly Record<string, unknown>[],
): Promise<boolean> {
  const ids = shares.map((row) => String(row.id)).filter(Boolean);
  if (ids.length === 0) return false;
  const lines = await rowsOf(
    client.from("trade_invoice_lines").select(
      "group_share_id, trade_invoice_id",
    ).in("group_share_id", ids),
    "check invoiced shares",
  );
  const invoiceIds = [
    ...new Set(lines.map((row) => String(row.trade_invoice_id || ""))),
  ]
    .filter(Boolean);
  if (invoiceIds.length === 0) return false;
  const invoices = await rowsOf(
    client.from("trade_invoices").select("id, status").in("id", invoiceIds),
    "check invoiced shares",
  );
  const live = new Set(
    invoices.filter((row) => !releasedStatus(row.status)).map((row) =>
      String(row.id)
    ),
  );
  return lines.some((row) => live.has(String(row.trade_invoice_id || "")));
}

function releasedStatus(status: unknown): boolean {
  return GROUP_FENCE_RELEASED_INVOICE_STATUSES.includes(
    String(
      status || "",
    ) as typeof GROUP_FENCE_RELEASED_INVOICE_STATUSES[number],
  );
}

export async function previewGroupClientLink(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  refuseClientLinkSend(body);
  const group = await resolveGroup(client, body);
  const participants = await loadParticipants(client, String(group.id));
  requireParticipant(participants, caller.userId);
  const job = await loadJob(client, String(group.job_id));
  const { data: flag } = await client.from("feature_flags").select("enabled")
    .eq("flag_name", GROUP_WORK_ORDER_CLIENT_LINK_FLAG).maybeSingle();
  const sendingEnabled = flag?.enabled === true;
  return {
    ok: true,
    sent: false,
    sending_enabled: sendingEnabled,
    send_implemented: false,
    share_token: group.share_token,
    draft_message: draftClientLinkMessage({
      firstName: body.first_name as string | undefined,
      site: String(job?.site_suburb || job?.site_address || ""),
      link: body.link as string | undefined,
    }),
  };
}

export async function readGroupWorkOrderPublic(client: any, token: string) {
  const group = await requireTokenGroup(client, token);
  const job = await loadJob(client, String(group.job_id));
  const feedback = await rowsOf(
    client.from("group_work_order_feedback").select("id").eq(
      "group_id",
      group.id,
    ),
    "load feedback",
  );
  return {
    ok: true,
    job_number: job?.job_number || null,
    site_suburb: job?.site_suburb || null,
    job_type: job?.type || null,
    client_signed: groupIsSigned(group),
    feedback_submitted: feedback.length > 0,
    office_only_notice: OFFICE_FEEDBACK_NOTICE,
  };
}

async function requireTokenGroup(client: any, token: string) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    throw new GroupWorkOrderError(
      "group_share_token_required",
      "This sign-off link is missing its code.",
      400,
    );
  }
  const group = await loadGroupByToken(client, trimmed);
  if (!group || group.status === "void") {
    throw new GroupWorkOrderError(
      "group_share_token_invalid",
      "This sign-off link is not valid.",
      404,
    );
  }
  return group;
}

export async function clientSignGroupWorkOrder(
  client: any,
  body: Record<string, unknown>,
) {
  const group = await requireTokenGroup(client, String(body.share_token || ""));
  const name = String(body.signer_name || body.signature_name || "").trim();
  if (!name) {
    throw new GroupWorkOrderError(
      "group_signature_name_required",
      "Enter the client's name with their signature.",
      400,
    );
  }
  if (groupIsSigned(group)) {
    return { ok: true, client_signed: true, already_signed: true };
  }
  const png = signaturePng(body.signature_png);
  const via = body.signed_via === "on_site" ? "on_site" : "share_link";
  const signedAt = new Date().toISOString();
  const { error: sigError } = await client.from("group_work_order_signatures")
    .insert({
      group_id: group.id,
      signer_kind: "client",
      user_id: null,
      signer_name: name,
      signature_png: png,
      signed_via: via,
      captured_by_user_id: null,
      signed_at: signedAt,
    });
  throwQuery(sigError, "store the client's signature");
  const { error } = await client.from("group_work_orders").update({
    status: "client_signed",
    client_signed_at: signedAt,
    updated_at: signedAt,
  }).eq("id", group.id).eq("status", "open");
  throwQuery(error, "record the client's signature");
  return { ok: true, client_signed: true, already_signed: false };
}

export async function submitGroupWorkOrderFeedback(
  client: any,
  body: Record<string, unknown>,
) {
  const group = await requireTokenGroup(client, String(body.share_token || ""));
  if (!groupIsSigned(group)) {
    throw new GroupWorkOrderError(
      "group_client_signoff_required",
      "The client signs the job before leaving feedback.",
      409,
    );
  }
  const parsed = feedbackRatings(body);
  const freeText = String(body.free_text || "").trim().slice(0, 4000) || null;
  const via = body.submitted_via === "on_site" ? "on_site" : "share_link";
  const existing = await rowsOf(
    client.from("group_work_order_feedback").select("id").eq(
      "group_id",
      group.id,
    ),
    "load feedback",
  );
  if (existing.length === 0) {
    const { error } = await client.from("group_work_order_feedback").insert({
      group_id: group.id,
      sales_process_rating: parsed.ratings.sales_process,
      sales_process_comment: parsed.comments.sales_process,
      communication_rating: parsed.ratings.communication,
      communication_comment: parsed.comments.communication,
      cleanliness_rating: parsed.ratings.cleanliness,
      cleanliness_comment: parsed.comments.cleanliness,
      punctuality_rating: parsed.ratings.punctuality,
      punctuality_comment: parsed.comments.punctuality,
      crew_rating: parsed.ratings.crew,
      crew_comment: parsed.comments.crew,
      free_text: freeText,
      submitted_via: via,
    });
    throwQuery(error, "save the feedback");
  }
  const settings = await loadSettings(client);
  const ratings = FEEDBACK_DIMENSIONS.map((dimension) =>
    parsed.ratings[dimension]
  );
  const prompt = promptGoogleReview(ratings, settings.minimum);
  return {
    ok: true,
    office_only_notice: OFFICE_FEEDBACK_NOTICE,
    prompt_google_review: prompt,
    ...(prompt && settings.url ? { google_review_url: settings.url } : {}),
  };
}

async function loadSettings(
  client: any,
): Promise<{ url: string | null; minimum: number }> {
  const { data, error } = await client.from("group_work_order_settings").select(
    "google_review_url, review_prompt_min_rating",
  ).eq("id", 1).maybeSingle();
  throwQuery(error, "load review settings");
  const minimum = Number(data?.review_prompt_min_rating);
  return {
    url: data?.google_review_url ? String(data.google_review_url) : null,
    minimum: Number.isInteger(minimum) ? minimum : 4,
  };
}

export async function readGroupWorkOrderFeedback(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  assertOffice(caller);
  const group = await resolveGroup(client, body);
  const rows = await rowsOf(
    client.from("group_work_order_feedback").select(
      "sales_process_rating, sales_process_comment, communication_rating, communication_comment, cleanliness_rating, cleanliness_comment, punctuality_rating, punctuality_comment, crew_rating, crew_comment, free_text, submitted_at, submitted_via",
    ).eq("group_id", group.id),
    "load feedback",
  );
  return {
    ok: true,
    group_id: group.id,
    job_id: group.job_id,
    feedback: rows[0] || null,
  };
}

export async function readGroupWorkOrderOffice(
  client: any,
  caller: GroupCaller,
  body: Record<string, unknown>,
) {
  assertOffice(caller);
  const group = await resolveGroup(client, body);
  const [participants, entries, shares, feedback] = await Promise.all([
    loadParticipants(client, String(group.id)),
    rowsOf(
      client.from("group_work_order_time_entries").select(
        "user_id, work_date, hours, start_time, finish_time, break_minutes",
      ).eq("group_id", group.id),
      "load hours",
    ),
    rowsOf(
      client.from("group_work_order_shares").select(
        "user_id, hours, points, share_ex, pot_ex",
      ).eq("group_id", group.id),
      "load shares",
    ),
    rowsOf(
      client.from("group_work_order_feedback").select(
        "sales_process_rating, communication_rating, cleanliness_rating, punctuality_rating, crew_rating, free_text, submitted_at",
      ).eq("group_id", group.id),
      "load feedback",
    ),
  ]);
  const workOrder = await loadWorkOrder(client, String(group.work_order_id));
  return {
    ok: true,
    group_id: group.id,
    job_id: group.job_id,
    status: group.status,
    client_signed: groupIsSigned(group),
    pot_total: workOrder
      ? moneyToCents(workOrder.agreed_labour_ex) == null
        ? null
        : centsToMoney(moneyToCents(workOrder.agreed_labour_ex) || 0)
      : null,
    participants: participants.map((row) => ({
      user_id: row.user_id,
      signature_name: row.signature_name || null,
      crew_signed: Boolean(row.crew_signed_at),
    })),
    hours: entries,
    shares,
    feedback: feedback[0] || null,
  };
}

function assertOffice(caller: GroupCaller): void {
  if (caller.isStaff || callerIsStaff(caller.role)) return;
  throw new GroupWorkOrderError(
    "operator_access_required",
    "Feedback and the full split are for the office.",
    403,
  );
}

function clientMoney(item: Record<string, unknown>): number | null {
  const quantity = item.quantity == null ? null : Number(item.quantity);
  const rate = item.rate == null && item.unit_rate == null
    ? null
    : Number(item.rate ?? item.unit_rate);
  if (
    quantity != null && rate != null && Number.isFinite(quantity) &&
    Number.isFinite(rate)
  ) {
    return Number((quantity * rate).toFixed(2));
  }
  for (const key of ["line_total_ex", "amount", "total", "rate", "unit_rate"]) {
    if (item[key] === undefined || item[key] === null || item[key] === "") {
      continue;
    }
    const n = Number(item[key]);
    if (Number.isFinite(n)) return Number(n.toFixed(2));
  }
  return null;
}

export async function resolveGroupShareInvoiceExtra(
  client: any,
  input: { userId: string; item: Record<string, unknown> },
) {
  if (input.item.group_share_id && !isGroupShareInvoiceItem(input.item)) {
    throw new GroupWorkOrderError(
      "group_share_line_type_required",
      "A group share has to be submitted as its own line.",
    );
  }
  if (!isGroupShareInvoiceItem(input.item)) return null;
  const group = await resolveGroup(client, input.item);
  const participants = await loadParticipants(client, String(group.id));
  requireParticipant(participants, input.userId);
  if (!groupIsSigned(group)) {
    throw new GroupWorkOrderError(
      "group_client_signoff_required",
      "The client has to sign this job before a group share can be invoiced.",
      409,
    );
  }
  const entries = await rowsOf(
    client.from("group_work_order_time_entries").select(
      "user_id, work_date, hours",
    ).eq("group_id", group.id),
    "load hours",
  );
  const ownHours = entries
    .filter((row) => String(row.user_id) === input.userId)
    .reduce((sum, row) => sum + Number(row.hours || 0), 0);
  if (ownHours <= 0) {
    throw new GroupWorkOrderError(
      "group_share_hours_missing",
      "Submit your hours on this group before invoicing your share.",
    );
  }
  const shares = await computeShares(client, group, entries);
  const mine = shares.find((row) => String(row.user_id) === input.userId);
  if (!mine) {
    throw new GroupWorkOrderError(
      "group_share_not_in_split",
      "You have no share of this group. Check that your rate and hours are on the job.",
    );
  }
  const shareEx = Number(mine.share_ex);
  if (!(shareEx > 0)) {
    throw new GroupWorkOrderError(
      "group_share_zero",
      "Your share of this job rounds to zero, so there is nothing to invoice.",
    );
  }
  const claimed = clientMoney(input.item);
  if (claimed != null && Math.abs(claimed - shareEx) > 0.01) {
    throw new GroupWorkOrderError(
      "group_share_amount_mismatch",
      "The amount on the group share does not match your share. Reload and submit again.",
      409,
    );
  }
  const job = await loadJob(client, String(group.job_id));
  const jobNumber = String(job?.job_number || input.item.job_number || "");
  return {
    line_type: GROUP_SHARE_LINE_TYPE,
    description: `Group work order share for ${jobNumber || "this job"}`,
    quantity: 1,
    total_hours: 0,
    unit: "ea",
    unit_rate: shareEx,
    line_total_ex: shareEx,
    hourly_rate: null,
    line_date: null,
    work_date: null,
    start_time: null,
    finish_time: null,
    break_minutes: null,
    division: job?.type || null,
    job_id: group.job_id,
    job_number: jobNumber || null,
    client_name: job?.client_name || null,
    site_address:
      [job?.site_address, job?.site_suburb].filter(Boolean).join(", ") ||
      null,
    query_note:
      "Group work order share. Server-priced from the sealed job work order. Not hours times rate.",
    source_work_order_id: null,
    source_trade_invoice_line_id: null,
    deduction_user_id: null,
    deduction_assignment_id: null,
    deduction_trade_rate_id: null,
    line_position: null,
    wo_allocated: null,
    wo_labour_deduction: null,
    wo_labour_lines: null,
    group_share_id: mine.id,
    _hoursFlag: null,
    _woProblems: null,
  };
}

export async function assertGroupWorkOrderInvoiceFence(
  client: any,
  input: { userId: string; lines: readonly FenceLine[] },
): Promise<void> {
  const submitting = input.lines.map((line) => ({
    ...line,
    user_id: input.userId,
  }));
  const jobIds = [
    ...new Set(
      submitting.map((line) => String(line.job_id || "")).filter(Boolean),
    ),
  ];
  if (jobIds.length === 0) return;
  const lines = await rowsOf(
    client.from("trade_invoice_lines").select(
      "job_id, line_type, source_work_order_id, group_share_id, trade_invoice_id",
    ).in("job_id", jobIds),
    "check existing claims",
  );
  const invoiceIds = [
    ...new Set(lines.map((row) => String(row.trade_invoice_id || ""))),
  ]
    .filter(Boolean);
  const invoices = invoiceIds.length === 0 ? [] : await rowsOf(
    client.from("trade_invoices").select("id, status, user_id").in(
      "id",
      invoiceIds,
    ),
    "check existing claims",
  );
  const byId = new Map(invoices.map((row) => [String(row.id), row]));
  const live: FenceLine[] = lines.filter((row) => {
    const invoice = byId.get(String(row.trade_invoice_id || ""));
    return invoice && !releasedStatus(invoice.status);
  }).map((row) => {
    const owner = byId.get(String(row.trade_invoice_id || ""))?.user_id;
    return {
      job_id: row.job_id == null ? null : String(row.job_id),
      line_type: row.line_type == null ? null : String(row.line_type),
      source_work_order_id: row.source_work_order_id == null
        ? null
        : String(row.source_work_order_id),
      group_share_id: row.group_share_id == null
        ? null
        : String(row.group_share_id),
      user_id: owner == null ? null : String(owner),
    };
  });
  const problem = findFenceProblem(input.userId, submitting, live);
  if (problem) {
    throw new GroupWorkOrderError(problem.code, problem.message, 409);
  }
}

/** The seed URL. Responses read group_work_order_settings, never this constant. */
export const GROUP_REVIEW_URL_SEED = SEEDED_GOOGLE_REVIEW_URL;

export function groupBody(value: unknown): Record<string, unknown> {
  return asRecord(value);
}
