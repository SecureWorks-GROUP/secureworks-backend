/**
 * Group work orders (owner, confirmed 21 Oct 2026).
 *
 * The pot is the sealed agreed labour on the job work order. A participant
 * who has submitted their own hours sees that total and their own share, and
 * no other person's hours, points or share. A non-participant never reads
 * the sealed price. A job is either a normal work-order claim or this split.
 *
 * DEFAULT, owner to confirm: break minutes come off finish minus start.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";
import {
  signatureDataUrl,
  signatureImageTag,
} from "../_shared/signature_image.ts";
import {
  allocatePotCents,
  assertGroupJobDraftUsesShare,
  assertGroupWorkOrderInvoiceFence,
  centsToMoney,
  clientSignGroupWorkOrder,
  createGroupWorkOrder,
  deleteGroupWorkOrderHours,
  draftClientLinkMessage,
  officeApproveGroupHours,
  readyUnreleasedGroupInvoiceIds,
  agentCreateGroupWorkOrder,
  entryPointsMicro,
  findFenceProblem,
  freezeGroupWorkOrder,
  GROUP_FENCE_RELEASED_INVOICE_STATUSES,
  GROUP_REVIEW_URL_SEED,
  type GroupCaller,
  groupHoursFromBody,
  GroupWorkOrderError,
  isGroupShareLine,
  isNormalWorkOrderPayLine,
  isBilledHoursInvoice,
  isPaidHoursLine,
  joinGroupWorkOrder,
  moneyToCents,
  PARTICIPANT_SHARE_KEYS,
  participantShareResponse,
  participantShareResponseIsClosed,
  pointsDollars,
  promptGoogleReview,
  rateOnDay,
  readGroupWorkOrderFeedback,
  readGroupWorkOrderMyShare,
  readHoursPaidUserIds,
  readTradeGroupWorkOrder,
  readMyGroupWorkOrders,
  readInvoicePayableRoutes,
  readPatioLegacyHoursJobIds,
  readGroupWorkOrderCrew,
  PATIO_PAY_GROUP_ONLY_FLAG,
  assertPatioPaysThroughGroup,
  assertAllInGroupInvoiceStandalone,
  captureGroupClientSignoff,
  invoiceCardRoute,
  weekStartWords,
  assertGroupClientConfirmationBeforeCompletion,
  readGroupWorkOrderOffice,
  refuseClientLinkSend,
  removeGroupWorkOrderParticipant,
  restoreGroupWorkOrderParticipant,
  resolveGroupShareInvoiceExtra,
  submitGroupWorkOrderFeedback,
  submitGroupWorkOrderHours,
  unfreezeGroupWorkOrder,
  visibleShareRows,
  withoutGroupJobAssignments,
} from "./group_work_order.ts";
import { TRADE_INVOICE_TIME_LINE_TYPES } from "./trade_invoice_time_entry.ts";

import { recordOfficeClientConfirmation, readOfficeClientSignedCopy, ClientSignoffFormError, decodeClientSignedCopy } from "./client_signoff_form.ts";
import { hasOfficeClientConfirmation } from "./client_signoff_form_data.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "10000000-0000-4000-8000-000000000001";
const OTHER_JOB = "10000000-0000-4000-8000-000000000002";
const WO = "20000000-0000-4000-8000-000000000001";
const OTHER_WO = "20000000-0000-4000-8000-000000000002";
const GROUP = "30000000-0000-4000-8000-000000000001";
const USER_A = "40000000-0000-4000-8000-00000000000a";
const USER_B = "40000000-0000-4000-8000-00000000000b";
const USER_C = "40000000-0000-4000-8000-00000000000c";
const SHARE_A = "50000000-0000-4000-8000-00000000000a";
const INV = "60000000-0000-4000-8000-000000000001";

type Row = Record<string, unknown>;

class Memory {
  tables = new Map<string, Row[]>();
  calls: { table: string; op: string }[] = [];
  hoursClock = Date.parse("2026-11-01T00:00:00.000Z");
  weeklyLockHeld = false;
  /** A table whose next insert the database refuses (a trigger), by message. */
  insertFault = new Map<string, string>();

  touchHours(groupId: string): string {
    const stamp = new Date(this.hoursClock).toISOString();
    this.hoursClock += 1000;
    const group = this.rows("group_work_orders").find((row) => row.id === groupId);
    if (group) group.hours_changed_at = stamp;
    return stamp;
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  client() {
    const memory = this;
    return {
      from(table: string) {
        return new Query(memory, table);
      },
      rpc(fn: string, args: Record<string, unknown> = {}) {
        memory.calls.push({ table: fn, op: "rpc" });
        if (fn === "group_work_order_crew") {
          let bounds: [number, number] | null = null;
          const q: any = {order: () => q, range: (a: number, b: number) => {bounds=[a,b];return q;},
            then: (resolve: any) => {
              const rows = (memory.runRpc(fn,args) as Row[]).toSorted((a,b) => String(a.user_id).localeCompare(String(b.user_id)));
              return Promise.resolve({data:bounds?rows.slice(bounds[0],bounds[1]+1):rows,error:null}).then(resolve);
            }};
          return q;
        }
        try {
          return Promise.resolve({
            data: memory.runRpc(fn, args || {}),
            error: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Promise.resolve({ data: null, error: { message } });
        }
      },
    };
  }

  /** An office removal on the job's live group beats a booking (20261106170000). */
  standingRemoval(jobId: string, userId: string): boolean {
    return this.rows("group_work_order_crew_removals").some((r) => {
      const group = this.rows("group_work_orders").find((g) => g.id === r.group_id);
      return String(r.job_id) === jobId && String(r.user_id) === userId && r.restored_at == null &&
        group?.status !== "void";
    });
  }

  /** Twin of public.group_work_order_hours_paid (20261106160000). */
  hoursPaid(jobId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const line of this.rows("trade_invoice_lines")) {
      if (String(line.job_id) !== jobId || !isPaidHoursLine(line as any)) continue;
      const invoice = this.rows("trade_invoices").find((row) => row.id === line.trade_invoice_id);
      // Only hours billed in Xero count as paid (20261106160000).
      if (!invoice?.user_id || !isBilledHoursInvoice(invoice)) continue;
      const userId = String(invoice.user_id);
      out.set(userId, (out.get(userId) || 0) + Number(line.line_total_ex || 0));
    }
    return out;
  }

  runRpc(fn: string, args: Record<string, unknown>) {
    if (fn === "group_work_order_crew") {
      const jobs = args.p_job_ids as string[];
      const out = new Map<string, Row>();
      for (const row of this.rows("job_assignments")) {
        const user = this.rows("users").find((u) => u.id === row.user_id);
        if (!jobs.includes(String(row.job_id)) || row.is_ghost === true ||
          String(row.status || "").toLowerCase() === "cancelled" ||
          String(row.role || "").toLowerCase() === "observer" || user?.role === "admin") continue;
        if (this.hoursPaid(String(row.job_id)).has(String(row.user_id))) continue;
        if (this.standingRemoval(String(row.job_id), String(row.user_id))) continue;
        out.set(`${row.job_id}:${row.user_id}`, {job_id:row.job_id,user_id:row.user_id});
      }
      for (const member of this.rows("group_work_order_participants")) {
        const group = this.rows("group_work_orders").find((g) => g.id === member.group_id);
        if (group && group.status !== "void" && jobs.includes(String(group.job_id)) &&
          !this.hoursPaid(String(group.job_id)).has(String(member.user_id))) {
          out.set(`${group.job_id}:${member.user_id}`,{job_id:group.job_id,user_id:member.user_id});
        }
      }
      return [...out.values()];
    }
    if (fn === "record_on_site_client_signoff") {
      // Twin of 20261106193000: one call is one transaction under the key's
      // lock, so a second copy of the key sees the first row and writes nothing.
      const key = String(args.p_capture_request_id || "");
      const stored = this.rows("job_client_signoffs").find((row) => row.capture_request_id === key);
      if (stored) {
        return {signoff_id: stored.id, claimed: false, same_capture: stored.capture_payload_hash === args.p_capture_payload_hash};
      }
      const media = {id: crypto.randomUUID(), job_id: args.p_job_id, type: "photo", storage_url: args.p_signature_png,
        label: "Client signature", phase: "signature", uploaded_by: args.p_captured_by};
      this.rows("job_media").push(media);
      const signoff = {id: crypto.randomUUID(), org_id: args.p_org_id, job_id: args.p_job_id, method: "on_site",
        signed_name: args.p_signed_name, happy: args.p_happy, satisfaction_rating: args.p_satisfaction_rating,
        signature_media_id: media.id, captured_by: args.p_captured_by, captured_by_actor: args.p_captured_by_actor,
        captured_device: args.p_captured_device, outstanding_items: args.p_outstanding_items,
        capture_request_id: key, capture_payload_hash: args.p_capture_payload_hash};
      this.rows("job_client_signoffs").push(signoff);
      return {signoff_id: signoff.id, claimed: true, same_capture: true};
    }
    const groupId = String(args.p_group_id || "");
    const group = this.rows("group_work_orders").find((row) =>
      row.id === groupId
    );
    if (!group) throw new Error("group_work_order_not_found");
    if (fn === "unfreeze_group_work_order_split") {
      return this.unfreeze(group);
    }
    if (fn === "group_work_order_release_state") {
      return { ready: group.__ready === true, released: false };
    }
    if (fn === "office_approve_group_hours") {
      // Stand-in for the SQL function; the migration contract proves the real one.
      const actor = String(args.p_actor_user_id || "");
      if (String(args.p_reason || "").trim().length < 3) throw new Error("group_office_approval_reason_required");
      if (group.split_frozen_at) throw new Error("group_split_frozen");
      if (this.rows("group_work_order_participants").some((row) => row.group_id === groupId && row.user_id === actor)) {
        throw new Error("group_office_approver_on_crew");
      }
      group.hours_office_approved_at = "2099-01-01T00:00:00Z";
      group.hours_office_approved_by = actor;
      return { group_id: groupId, approved_at: group.hours_office_approved_at };
    }
    if (fn === "restore_group_work_order_participant") {
      return this.restoreParticipant(group, String(args.p_user || ""), String(args.p_actor || ""));
    }
    if (fn === "remove_group_work_order_participant") {
      return this.removeParticipant(
        group,
        String(args.p_user || ""),
        String(args.p_actor || ""),
      );
    }
    if (
      fn !== "freeze_group_work_order_split" &&
      fn !== "project_group_work_order_split"
    ) {
      throw new Error(`unknown rpc ${fn}`);
    }
    return this.writeSplit(group, fn === "freeze_group_work_order_split");
  }

  round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  unfreeze(group: Row) {
    if (this.weeklyLockHeld) {
      throw new Error("group_split_busy: busy, try again");
    }
    const blocking = new Set([
      "pending_acknowledgment",
      "acknowledged",
      "pending_ops_review",
      "approved",
      "pushed_to_xero",
      "paid",
    ]);
    const shareIds = new Set(
      this.rows("group_work_order_shares").filter((row) =>
        row.group_id === group.id
      ).map((row) => String(row.id)),
    );
    const invoiceIds = [
      ...new Set(
        this.rows("trade_invoice_lines").filter((line) =>
          shareIds.has(String(line.group_share_id || ""))
        ).map((line) => String(line.trade_invoice_id)),
      ),
    ];
    const invoices = this.rows("trade_invoices").filter((row) =>
      invoiceIds.includes(String(row.id))
    );
    const blocked = (row: Row) =>
      blocking.has(String(row.status || "")) ||
      String(row.xero_bill_id || "").trim() !== "" ||
      Boolean(row.xero_pushed_at);
    if (invoices.some(blocked)) {
      throw new Error("group_split_has_live_invoice");
    }
    const lineRows = this.rows("trade_invoice_lines");
    const keptLines = lineRows.filter((line) =>
      !shareIds.has(String(line.group_share_id || ""))
    );
    lineRows.splice(0, lineRows.length, ...keptLines);
    const stripped: string[] = [];
    for (const invoice of invoices) {
      stripped.push(String(invoice.id));
      if (invoice.gst_on == null) continue;
      const remaining = lineRows.filter((line) =>
        String(line.trade_invoice_id) === String(invoice.id)
      );
      const gross = this.round2(
        remaining.reduce((sum, line) => sum + Number(line.line_total_ex || 0), 0),
      );
      const gstOn = invoice.gst_on === true || invoice.gst_on === "true";
      const superAmount = this.round2(gross * 0.12);
      const withhold = this.round2(gross * 0.06);
      invoice.subtotal_ex = gross;
      invoice.gross_earned = gross;
      invoice.super_rate = 0.12;
      invoice.super_amount = superAmount;
      invoice.net_pay = this.round2(gross - withhold);
      invoice.gst = gstOn ? this.round2(gross * 0.1) : 0;
      invoice.total_inc = this.round2(gross + Number(invoice.gst));
      if (String(invoice.invoice_source || "") === "weekly_work_order") {
        const deductions = this.round2(
          -remaining.filter((line) =>
            String(line.line_type || "").toLowerCase().replace(/_/g, " ")
              .replace(/\s+/g, "") === "finalpayoutdeduction"
          ).reduce((sum, line) => sum + Number(line.line_total_ex || 0), 0),
        );
        invoice.final_deductions_total_ex = deductions;
        invoice.to_be_paid_ex = gross;
        invoice.job_grand_total_ex = this.round2(gross + deductions);
      }
      const payable = this.round2(Number(invoice.net_pay) + Number(invoice.gst));
      const rawAmount = invoice.recurring_deduction_amount;
      if (rawAmount != null && rawAmount !== "") {
        const amount = Number(rawAmount);
        if (amount > payable) {
          const label = String(invoice.recurring_deduction_label || "");
          const week = String(invoice.week_start || "");
          invoice.recurring_deduction_note = payable === 0
            ? null
            : `${label} $${amount.toFixed(2)} NOT taken for the week starting ${week}: the amount payable on this invoice ($${payable.toFixed(2)}) is less than the deduction. Nothing was taken off. The office to recover it another way.`;
          invoice.recurring_deduction_id = null;
          invoice.recurring_deduction_label = null;
          invoice.recurring_deduction_amount = null;
        }
      }
    }
    const shareRows = this.rows("group_work_order_shares");
    const keptShares = shareRows.filter((row) => row.group_id !== group.id);
    shareRows.splice(0, shareRows.length, ...keptShares);
    group.split_frozen_at = null;
    return { frozen: false, shares: [], stripped_invoice_ids: stripped };
  }

  removeParticipant(group: Row, userId: string, actor: string) {
    if (!userId || !actor) throw new Error("group_actor_required");
    if (group.status === "void") throw new Error("group_work_order_void");
    if (group.split_frozen_at) throw new Error("group_split_frozen");
    const hours = this.rows("group_work_order_time_entries");
    hours.splice(
      0,
      hours.length,
      ...hours.filter((row) =>
        !(row.group_id === group.id && String(row.user_id) === userId)
      ),
    );
    const people = this.rows("group_work_order_participants");
    people.splice(
      0,
      people.length,
      ...people.filter((row) =>
        !(row.group_id === group.id && String(row.user_id) === userId)
      ),
    );
    this.rows("group_work_order_events").push({
      group_id: group.id,
      action: "remove_participant",
      actor,
      user_id: userId,
    });
    if (!this.standingRemoval(String(group.job_id), userId)) {
      this.rows("group_work_order_crew_removals").push({
        group_id: group.id, job_id: group.job_id, user_id: userId,
        removed_by: actor, removed_at: "2026-11-06T00:00:00.000Z", restored_by: null, restored_at: null,
      });
    }
    this.touchHours(String(group.id));
    return { ok: true };
  }

  restoreParticipant(group: Row, userId: string, actor: string) {
    if (!userId || !actor) throw new Error("group_actor_required");
    if (group.status === "void") throw new Error("group_work_order_void");
    if (group.split_frozen_at) throw new Error("group_split_frozen");
    const removal = this.rows("group_work_order_crew_removals").find((r) =>
      r.group_id === group.id && String(r.user_id) === userId && r.restored_at == null
    );
    if (!removal) throw new Error("group_removal_not_found");
    removal.restored_by = actor;
    removal.restored_at = "2026-11-06T01:00:00.000Z";
    const people = this.rows("group_work_order_participants");
    if (!people.some((r) => r.group_id === group.id && String(r.user_id) === userId)) {
      people.push({ id: crypto.randomUUID(), group_id: group.id, user_id: userId });
    }
    this.rows("group_work_order_events").push({ group_id: group.id, action: "restore_participant", actor, user_id: userId });
    this.touchHours(String(group.id));
    return { restored: true };
  }

  latestHoursAt(jobId: string): string | null {
    const live = this.rows("group_work_orders").filter((row) =>
      row.job_id === jobId && row.status !== "void"
    );
    const liveIds = new Set(live.map((row) => String(row.id)));
    let latest: number | null = null;
    let text: string | null = null;
    const consider = (instant: string | null) => {
      if (!instant) return;
      const at = Date.parse(instant);
      if (!Number.isFinite(at)) return;
      if (latest == null || at > latest) {
        latest = at;
        text = instant;
      }
    };
    for (const entry of this.rows("group_work_order_time_entries")) {
      if (!liveIds.has(String(entry.group_id))) continue;
      const created = entry.created_at == null || entry.created_at === ""
        ? null
        : String(entry.created_at);
      const updated = entry.updated_at == null || entry.updated_at === ""
        ? null
        : String(entry.updated_at);
      const instant = !created
        ? updated
        : !updated
        ? created
        : Date.parse(updated) > Date.parse(created)
        ? updated
        : created;
      consider(instant);
    }
    for (const group of live) {
      const changed = group.hours_changed_at == null || group.hours_changed_at === ""
        ? null
        : String(group.hours_changed_at);
      consider(changed);
    }
    return text;
  }

  countingSignoff(jobId: string): boolean {
    const rows = this.rows("job_client_signoffs").filter((row) =>
      row.job_id === jobId
    );
    const newest = [...rows].sort((a, b) => {
      const at = String(a.created_at || "");
      const bt = String(b.created_at || "");
      if (at !== bt) return at < bt ? 1 : -1;
      return String(a.id || "") < String(b.id || "") ? 1 : -1;
    })[0];
    if (!newest) return false;
    const method = String(newest.method || "");
    if (method === "revoked") return false;
    if (method === "office_waiver") {
      const latest = this.latestHoursAt(jobId);
      return String(newest.waiver_reason || "").trim().length >= 3 && Boolean(String(newest.captured_by_actor || "").trim()) && (!latest || Date.parse(String(newest.created_at)) > Date.parse(latest));
    }
    if (method !== "on_site" && method !== "share_link") return false;
    if (!newest.signature_media_id) return false;
    if (newest.happy === false) return false;
    if (
      newest.satisfaction_rating != null &&
      Number(newest.satisfaction_rating) < 4
    ) {
      return false;
    }
    const latest = this.latestHoursAt(jobId);
    if (!latest) return true;
    const signed = Date.parse(String(newest.created_at || ""));
    const at = Date.parse(latest);
    if (!Number.isFinite(signed) || !Number.isFinite(at)) return false;
    return signed > at;
  }

  assignmentCovers(userId: string, jobId: string, workDate: string): boolean {
    return this.rows("job_assignments").some((row) =>
      String(row.user_id) === userId &&
      String(row.job_id) === jobId &&
      String(row.scheduled_date || "") === workDate &&
      row.is_ghost !== true &&
      String(row.role || "").toLowerCase() !== "observer" &&
      String(row.status || "").toLowerCase() !== "cancelled"
    );
  }

  sharePayload(groupId: string): Row[] {
    return this.rows("group_work_order_shares").filter((row) =>
      row.group_id === groupId
    ).map((row) => ({
      id: row.id,
      user_id: row.user_id,
      hours: row.hours,
      points: row.points,
      share_ex: row.share_ex,
      pot_ex: row.pot_ex,
    })).sort((a, b) => String(a.user_id) < String(b.user_id) ? -1 : 1);
  }

  writeSplit(group: Row, freeze: boolean) {
    if (group.split_frozen_at) {
      return { frozen: true, shares: this.sharePayload(String(group.id)) };
    }
    const workOrder = this.rows("work_orders").find((row) =>
      row.id === group.work_order_id
    );
    let potCents = workOrder && workOrder.kind === "job" &&
        workOrder.status === "approved" && workOrder.sealed_content_hash
      ? moneyToCents(workOrder.agreed_labour_ex)
      : null;
    if (potCents == null || potCents <= 0) throw new Error("group_pot_missing");
    // Crew paid by the hour: out of the split, their pay off the pot
    // (all_in_12_v2 uses gross plus 12%; gross_v1 uses gross).
    const paid = this.hoursPaid(String(group.job_id));
    for (const gross of paid.values()) {
      const g = Math.round(gross * 100);
      potCents -= group.pay_basis === "all_in_12_v2" ? g + Math.round(g * 0.12) : g;
    }
    if (potCents <= 0) throw new Error("group_pot_used_by_hours_pay");
    const points = new Map<string, bigint>();
    const hours = new Map<string, number>();
    const missingRate: string[] = [];
    const badRate: string[] = [];
    for (
      const entry of this.rows("group_work_order_time_entries").filter((row) =>
        row.group_id === group.id
      )
    ) {
      const userId = String(entry.user_id);
      const worked = Number(entry.hours || 0);
      const workDate = String(entry.work_date);
      // A member's logged hours count, booked day or not (6 Nov 2026).
      if (worked <= 0) continue;
      if (!this.rows("group_work_order_participants").some((row) =>
        row.group_id === group.id && String(row.user_id) === userId
      )) continue;
      if (paid.has(userId)) continue;
      hours.set(userId, (hours.get(userId) || 0) + worked);
      const raw = this.rows("trade_rates").filter((row) => {
        if (row.user_id !== userId || row.org_id !== group.org_id) return false;
        const from = String(row.effective_from || "");
        const to = row.effective_to ? String(row.effective_to) : null;
        if (from && from > workDate) return false;
        if (to && to < workDate) return false;
        return true;
      });
      if (raw.length === 0) {
        if (!missingRate.includes(userId)) missingRate.push(userId);
        continue;
      }
      const rate = rateOnDay(
        raw.map((row) => ({
          hourly_rate: row.hourly_rate,
          effective_from: row.effective_from == null
            ? null
            : String(row.effective_from),
          effective_to: row.effective_to == null
            ? null
            : String(row.effective_to),
        })),
        workDate,
      );
      if (rate == null || Math.round(rate * 100) <= 0) {
        if (!badRate.includes(userId)) badRate.push(userId);
        continue;
      }
      points.set(
        userId,
        (points.get(userId) || 0n) + entryPointsMicro(rate, worked),
      );
    }
    const required = this.runRpc("group_work_order_crew", {p_job_ids:[String(group.job_id)]}) as Row[];
    const needsHours = required.map((row) => String(row.user_id))
      .filter((userId) => (hours.get(userId) || 0) <= 0).sort();
    if (needsHours.length > 0) {
      throw new Error(`group_split_needs_hours: ${needsHours.join(",")}`);
    }
    if (missingRate.length > 0) {
      throw new Error(
        `group_share_rate_missing: ${missingRate.sort().join(",")}`,
      );
    }
    if (badRate.length > 0) {
      throw new Error(
        `group_participant_needs_rate: ${badRate.sort().join(",")}`,
      );
    }
    if (!this.countingSignoff(String(group.job_id))) {
      throw new Error("group_client_signoff_required");
    }
    let allocated: { userId: string; shareCents: number }[];
    try {
      allocated = allocatePotCents(
        potCents,
        [...points.entries()].map(([userId, pointsMicro]) => ({
          userId,
          pointsMicro,
        })),
      );
    } catch (err) {
      if (err instanceof GroupWorkOrderError) throw new Error(err.code);
      throw err;
    }
    const potEx = centsToMoney(potCents);
    if (!freeze) {
      return {
        frozen: false,
        shares: allocated.map((row) => ({
          id: null,
          user_id: row.userId,
          hours: Number((hours.get(row.userId) || 0).toFixed(2)),
          points: pointsDollars(points.get(row.userId) || 0n),
          share_ex: centsToMoney(row.shareCents),
          pot_ex: potEx,
        })),
      };
    }
    const shareRows = this.rows("group_work_order_shares");
    const keep = new Set(allocated.map((row) => row.userId));
    const kept = shareRows.filter((row) =>
      row.group_id !== group.id || keep.has(String(row.user_id))
    );
    shareRows.splice(0, shareRows.length, ...kept);
    const now = new Date().toISOString();
    for (const row of allocated) {
      const existing = shareRows.find((share) =>
        share.group_id === group.id && share.user_id === row.userId
      );
      const next = {
        hours: Number((hours.get(row.userId) || 0).toFixed(2)),
        points: pointsDollars(points.get(row.userId) || 0n),
        share_ex: centsToMoney(row.shareCents),
        pot_ex: potEx,
        computed_at: now,
      };
      if (existing) Object.assign(existing, next);
      else {
        shareRows.push({
          id: crypto.randomUUID(),
          group_id: group.id,
          user_id: row.userId,
          ...next,
        });
      }
    }
    if (freeze) group.split_frozen_at = now;
    return {
      frozen: Boolean(group.split_frozen_at),
      shares: this.sharePayload(String(group.id)),
    };
  }
}

class Query {
  private filters: { op: "eq" | "in" | "neq" | "is"; col: string; value: unknown }[] = [];
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: unknown = null;
  private one: "none" | "maybe" | "single" = "none";
  private bounds: [number,number] | null = null;
  private sorts: {col:string;ascending:boolean}[] = [];

  constructor(private memory: Memory, private table: string) {}

  select(): this {
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push({ op: "eq", col, value });
    return this;
  }
  in(col: string, value: unknown): this {
    this.filters.push({ op: "in", col, value });
    return this;
  }
  neq(col: string,value:unknown): this { this.filters.push({op:"neq",col,value}); return this; }
  is(col: string,value:unknown): this { this.filters.push({op:"is",col,value}); return this; }
  order(col:string, options:{ascending?:boolean}={}): this { this.sorts.push({col,ascending:options.ascending!==false});return this; }
  range(start:number,end:number): this { this.bounds=[start,end]; return this; }
  insert(row: unknown): this {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  upsert(rows: unknown): this {
    this.op = "upsert";
    this.payload = rows;
    return this;
  }
  update(row: unknown): this {
    this.op = "update";
    this.payload = row;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  maybeSingle(): this {
    this.one = "maybe";
    return this;
  }
  single(): this {
    this.one = "single";
    return this;
  }
  then(
    resolve: (
      value: { data: unknown; error: { message?: string } | null },
    ) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      if (filter.op === "eq") {
        if (filter.col === "jobs.type") return this.memory.rows("jobs").find((job) => job.id === row.job_id)?.type === filter.value;
        return row[filter.col] === filter.value;
      }
      if (filter.op === "neq") return row[filter.col] !== filter.value;
      if (filter.op === "is") return (row[filter.col] ?? null) === filter.value;
      return (filter.value as unknown[]).includes(row[filter.col]);
    });
  }

  private run(): { data: unknown; error: { message?: string } | null } {
    this.memory.calls.push({ table: this.table, op: this.op });
    const rows = this.memory.rows(this.table);
    const fault = this.op === "insert" ? this.memory.insertFault.get(this.table) : undefined;
    if (fault) return { data: null, error: { message: fault } };
    if (this.op === "insert") {
      const created: Row = {
        id: crypto.randomUUID(),
        ...(this.payload as Row),
      };
      if (this.table === "group_work_order_time_entries") {
        this.memory.touchHours(String(created.group_id || ""));
      }
      rows.push(created);
      return { data: this.one === "none" ? [created] : created, error: null };
    }
    if (this.op === "upsert") {
      const incomingRows = Array.isArray(this.payload)
        ? this.payload as Row[]
        : [this.payload as Row];
      const same = (left: unknown, right: unknown) => {
        if (left == null && right == null) return true;
        if (left == null || right == null) return false;
        if (typeof left === "number" || typeof right === "number") {
          return Number(left) === Number(right);
        }
        return String(left) === String(right);
      };
      for (const incoming of incomingRows) {
        const at = rows.findIndex((row) =>
          row.group_id === incoming.group_id &&
          row.user_id === incoming.user_id &&
          String(row.work_date ?? "") === String(incoming.work_date ?? "")
        );
        if (this.table !== "group_work_order_time_entries") {
          if (at >= 0) rows[at] = { ...rows[at], ...incoming };
          else rows.push({ id: crypto.randomUUID(), ...incoming });
          continue;
        }
        if (at >= 0) {
          const old = rows[at];
          const identical = same(old.work_date, incoming.work_date) &&
            same(old.start_time, incoming.start_time) &&
            same(old.finish_time, incoming.finish_time) &&
            same(old.break_minutes, incoming.break_minutes) &&
            same(old.hours, incoming.hours) &&
            same(old.user_id, incoming.user_id) &&
            same(old.group_id, incoming.group_id);
          if (identical) continue;
          const stamp = this.memory.touchHours(String(incoming.group_id || ""));
          const createdAt = old.created_at;
          rows[at] = { ...old, ...incoming, updated_at: stamp };
          if (createdAt != null) rows[at].created_at = createdAt;
          continue;
        }
        const stamp = this.memory.touchHours(String(incoming.group_id || ""));
        rows.push({
          id: crypto.randomUUID(),
          ...incoming,
          created_at: stamp,
          updated_at: stamp,
        });
      }
      return { data: null, error: null };
    }
    if (this.op === "update") {
      for (const row of rows) {
        if (this.matches(row)) Object.assign(row, this.payload as Row);
      }
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      const removed = rows.filter((row) => this.matches(row));
      const kept = rows.filter((row) => !this.matches(row));
      rows.splice(0, rows.length, ...kept);
      if (this.table === "group_work_order_time_entries") {
        for (const groupId of new Set(removed.map((row) => String(row.group_id || "")))) {
          if (groupId) this.memory.touchHours(groupId);
        }
      }
      return { data: null, error: null };
    }
    let found = rows.filter((row) => this.matches(row));
    if(this.sorts.length) found=found.toSorted((a,b)=>{
      for(const {col,ascending} of this.sorts){const left=String(a[col]??""),right=String(b[col]??"");if(left!==right)return (left<right?-1:1)*(ascending?1:-1);}
      return 0;
    });
    if(this.bounds) found=found.slice(this.bounds[0],this.bounds[1]+1);
    if (this.one === "maybe") return { data: found[0] || null, error: null };
    if (this.one === "single") {
      return found[0]
        ? { data: found[0], error: null }
        : { data: null, error: { message: "none" } };
    }
    return { data: found, error: null };
  }
}

function trade(userId: string, staff = false): GroupCaller {
  return {
    userId,
    orgId: ORG,
    role: staff ? "ops_manager" : "crew",
    isStaff: staff,
  };
}

function seedSplit(memory: Memory, status = "client_signed") {
  memory.rows("group_work_orders").push({
    id: GROUP,
    org_id: ORG,
    job_id: JOB,
    work_order_id: WO,
    status,
    share_token: "tok-secret",
    client_signed_at: status === "client_signed"
      ? "2026-10-21T01:00:00Z"
      : null,
  });
  memory.rows("group_work_order_participants").push(
    { id: "p-a", group_id: GROUP, user_id: USER_A },
    { id: "p-b", group_id: GROUP, user_id: USER_B },
  );
  memory.rows("jobs").push({
    id: JOB,
    org_id: ORG,
    job_number: "SWF-1",
    client_name: "Client",
    site_address: "1 Example St",
    site_suburb: "Subiaco",
    type: "fencing",
    work_order_id: WO,
    status: "scheduled",
  });
  memory.rows("work_orders").push(
    {
      id: WO,
      org_id: ORG,
      job_id: JOB,
      kind: "job",
      status: "approved",
      agreed_labour_ex: 482.15,
      sealed_content_hash: "sealed",
    },
    {
      id: OTHER_WO,
      org_id: ORG,
      job_id: OTHER_JOB,
      kind: "job",
      status: "approved",
      agreed_labour_ex: 9999.99,
      sealed_content_hash: "other",
    },
  );
  memory.rows("feature_flags").push({
    flag_name: "group_work_order_v1",
    enabled: true,
  });
  memory.rows("job_assignments").push(
    {
      job_id: JOB,
      user_id: USER_A,
      scheduled_date: "2026-10-20",
      status: "scheduled",
      role: "lead_installer",
    },
    {
      job_id: JOB,
      user_id: USER_B,
      scheduled_date: "2026-10-20",
      status: "scheduled",
      role: "lead_installer",
    },
  );
  if (status === "client_signed") {
    memory.rows("job_client_signoffs").push({
      id: "sign-1",
      job_id: JOB,
      method: "share_link",
      signed_name: "Alex Client",
      happy: true,
      satisfaction_rating: 5,
      captured_by_actor: "client link",
      signature_media_id: "media-1",
      created_at: "2026-10-21T01:00:00Z",
    });
  }
  memory.rows("trade_rates").push(
    {
      user_id: USER_A,
      org_id: ORG,
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: null,
    },
    {
      user_id: USER_B,
      org_id: ORG,
      hourly_rate: 20,
      effective_from: "2026-01-01",
      effective_to: null,
    },
  );
}

Deno.test("shares: unequal rates floor to cents and the larger remainder takes the leftover", () => {
  const split = allocatePotCents(10000, [
    { userId: USER_A, pointsMicro: 2n },
    { userId: USER_B, pointsMicro: 1n },
  ]);
  assertEquals(split, [
    { userId: USER_A, shareCents: 6667 },
    { userId: USER_B, shareCents: 3333 },
  ]);
  assertEquals(split.reduce((sum, row) => sum + row.shareCents, 0), 10000);
});

Deno.test("shares: equal points split evenly and a three-way tie pays the smallest user id", () => {
  assertEquals(
    allocatePotCents(10000, [
      { userId: USER_B, pointsMicro: 50n },
      { userId: USER_A, pointsMicro: 50n },
    ]),
    [
      { userId: USER_A, shareCents: 5000 },
      { userId: USER_B, shareCents: 5000 },
    ],
  );
  const three = allocatePotCents(100, [
    { userId: "c", pointsMicro: 1n },
    { userId: "a", pointsMicro: 1n },
    { userId: "b", pointsMicro: 1n },
  ]);
  assertEquals(three, [
    { userId: "a", shareCents: 34 },
    { userId: "b", shareCents: 33 },
    { userId: "c", shareCents: 33 },
  ]);
  assertEquals(three.reduce((sum, row) => sum + row.shareCents, 0), 100);
});

Deno.test("shares: a missing pot and a person with no points are refused", () => {
  const missingPot = assertThrows(
    () => allocatePotCents(0, [{ userId: USER_A, pointsMicro: 1n }]),
    GroupWorkOrderError,
  );
  assertEquals(missingPot.message.includes("agreed labour"), true);
  const error = assertThrows(
    () => allocatePotCents(100, [{ userId: USER_A, pointsMicro: 0n }]),
    GroupWorkOrderError,
  );
  assertEquals(error.code, "group_share_hours_missing");
  const only = allocatePotCents(100, [
    { userId: USER_A, pointsMicro: 0n },
    { userId: USER_B, pointsMicro: 4n },
  ]);
  assertEquals(only, [{ userId: USER_B, shareCents: 100 }]);
});

Deno.test("points follow rate times hours, in proportion", () => {
  assertEquals(entryPointsMicro(40, 2), 800_000n);
  assertEquals(entryPointsMicro(20, 2), 400_000n);
  assertEquals(entryPointsMicro(0, 2), 0n);
});

Deno.test("my-share response is the closed key set, and the pot is hidden until hours are in", () => {
  const before = participantShareResponse({
    groupId: GROUP,
    clientSigned: false,
    ownHours: 0,
    potEx: 482.15,
    myShareEx: 321.43,
    awaiting: "needs_hours",
  });
  assert(participantShareResponseIsClosed(before));
  assertEquals(before.pot_total, null);
  assertEquals(before.my_share, null);
  assertEquals(before.needs_hours, true);
  assertEquals(Object.keys(before).sort(), [...PARTICIPANT_SHARE_KEYS].sort());
  const after = participantShareResponse({
    groupId: GROUP,
    clientSigned: true,
    ownHours: 2,
    potEx: 482.15,
    myShareEx: 321.43,
    awaiting: "frozen",
  });
  assertEquals(after.pot_total, 482.15);
  assertEquals(after.my_share, 321.43);
  assertEquals(
    { ...after, points: 1 }.points !== undefined &&
      !participantShareResponseIsClosed({ ...after, points: 1 }),
    true,
  );
});

Deno.test("a trade sees only their own share row; staff see the split", () => {
  const rows = [
    { user_id: USER_A, job_id: JOB, share_ex: 321.43, pot_ex: 482.15 },
    { user_id: USER_B, job_id: JOB, share_ex: 160.72, pot_ex: 482.15 },
    { user_id: USER_C, job_id: OTHER_JOB, share_ex: 9999.99, pot_ex: 9999.99 },
  ];
  assertEquals(
    visibleShareRows(USER_A, false, rows).map((row) => row.user_id),
    [USER_A],
  );
  assertEquals(visibleShareRows(USER_A, true, rows).length, 3);
});

Deno.test("non-participant cannot read the sealed price, and a participant sees only their own share", async () => {
  const hidden = new Memory();
  seedSplit(hidden);
  hidden.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const refused = await assertRejects(
    () =>
      readGroupWorkOrderMyShare(hidden.client(), trade(USER_C), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(refused.status, 403);
  assertEquals(refused.message.includes("482"), false);
  assertEquals(
    hidden.calls.some((call) => call.table === "work_orders"),
    false,
  );
  assertEquals(hidden.calls.some((call) => call.op === "rpc"), false);

  const waiting = new Memory();
  seedSplit(waiting);
  const before = await readGroupWorkOrderMyShare(
    waiting.client(),
    trade(USER_A),
    { group_id: GROUP },
  );
  assert(participantShareResponseIsClosed(before));
  assertEquals(before.pot_total, null);
  assertEquals(before.my_share, null);
  assertEquals(
    waiting.calls.some((call) => call.table === "work_orders"),
    false,
  );
  assertEquals(waiting.calls.some((call) => call.op === "rpc" && call.table !== "group_work_order_crew"), false);

  const shown = new Memory();
  seedSplit(shown);
  shown.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const mine = await readGroupWorkOrderMyShare(shown.client(), trade(USER_A), {
    group_id: GROUP,
  });
  assert(participantShareResponseIsClosed(mine));
  assertEquals(mine.pot_total, 482.15);
  assertEquals(mine.my_share, null);
  assertEquals(mine.awaiting, "ready");
  const text = JSON.stringify(mine);
  assertEquals(text.includes(USER_B), false);
  assertEquals(text.includes("160.72"), false);
  assertEquals(text.includes("9999.99"), false);
  assertEquals(text.includes("points"), false);
  const priced = shown.calls.filter((call) =>
    call.op === "rpc" && call.table === "project_group_work_order_split"
  );
  assertEquals(priced.length, 0);
  assertEquals(
    shown.calls.filter((call) => call.table === "work_orders").length,
    1,
  );
  assertEquals(shown.rows("group_work_orders")[0].split_frozen_at ?? null, null);
});

Deno.test("client sign-off gates the share, and the line is quantity 1 at the server share", async () => {
  const closed = new Memory();
  seedSplit(closed, "open");
  closed.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const unsigned = await assertRejects(
    () =>
      resolveGroupShareInvoiceExtra(closed.client(), {
        userId: USER_A,
        item: { type: "group share", group_id: GROUP, job_id: JOB },
      }),
    GroupWorkOrderError,
  );
  assertEquals(unsigned.code, "group_client_signoff_required");
  assertEquals(unsigned.status, 409);

  const billed = new Memory();
  seedSplit(billed);
  billed.rows("group_work_order_time_entries").push({
    group_id: GROUP,
    user_id: USER_A,
    work_date: "2026-10-20",
    hours: 2,
  });
  billed.rows("group_work_orders")[0].split_frozen_at = "2026-10-21T02:00:00Z";
  billed.rows("group_work_order_shares").push({
    id: SHARE_A,
    group_id: GROUP,
    user_id: USER_A,
    hours: 2,
    points: 80,
    share_ex: 40,
    pot_ex: 482.15,
  });
  billed.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: SHARE_A,
    trade_invoice_id: INV,
    line_type: "group share",
  });
  billed.rows("trade_invoices").push({
    id: INV,
    status: "pending_acknowledgment",
    user_id: USER_A,
  });
  const mismatch = await assertRejects(
    () =>
      resolveGroupShareInvoiceExtra(billed.client(), {
        userId: USER_A,
        item: { type: "group share", group_id: GROUP, quantity: 1, rate: 99 },
      }),
    GroupWorkOrderError,
  );
  assertEquals(mismatch.code, "group_share_amount_mismatch");
  const line = await resolveGroupShareInvoiceExtra(billed.client(), {
    userId: USER_A,
    item: { type: "group share", group_id: GROUP },
  });
  assertEquals(line?.quantity, 1);
  assertEquals(line?.unit_rate, 40);
  assertEquals(line?.line_total_ex, 40);
  assertEquals(line?.total_hours, 0);
  assertEquals(line?.source_work_order_id, null);
  assertEquals(line?.group_share_id, SHARE_A);
  assertEquals(line?.office_review_status, "awaiting");
});

Deno.test("a freeze is an explicit snapshot, a held invoice is returned, and a paid invoice keeps the freeze", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  const quoted = await resolveGroupShareInvoiceExtra(memory.client(), {
    userId: USER_A,
    item: { type: "group share", group_id: GROUP },
  });
  assertEquals(quoted?.unit_rate, 321.43);
  assertEquals(quoted?.group_share_id, null);
  assertEquals(quoted?.office_review_status, "awaiting");
  assertEquals(memory.rows("group_work_orders")[0].split_frozen_at ?? null, null);
  assertEquals(memory.rows("group_work_order_shares").length, 0);

  const frozen = await freezeGroupWorkOrder(memory.client(), trade(USER_A), {
    group_id: GROUP,
  });
  assertEquals(frozen.awaiting, "frozen");
  assertEquals(frozen.my_share, 321.43);
  const shareA = String(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_A)
      ?.id,
  );
  const shareB = Number(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_B)
      ?.share_ex,
  );
  assertEquals(shareB, 160.72);

  const joined = await assertRejects(
    () => joinGroupWorkOrder(memory.client(), trade(USER_C, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(joined.code, "group_split_frozen");
  assertEquals(joined.status, 409);

  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: shareA,
    trade_invoice_id: INV,
    line_type: "group share",
  });
  memory.rows("trade_invoices").push({
    id: INV,
    status: "pending_acknowledgment",
    user_id: USER_A,
  });
  const submitted = await assertRejects(
    () =>
      unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(submitted.code, "group_split_has_live_invoice");
  assertEquals(memory.rows("group_work_orders")[0].split_frozen_at != null, true);
  memory.rows("trade_invoices")[0].status = "draft";
  const opened = await unfreezeGroupWorkOrder(
    memory.client(),
    trade(USER_A, true),
    { group_id: GROUP },
  );
  assertEquals(opened.split_frozen, false);
  assertEquals(memory.rows("group_work_orders")[0].split_frozen_at ?? null, null);
  assertEquals(memory.rows("group_work_order_shares").length, 0);
  assertEquals(memory.rows("trade_invoices")[0].status, "draft");
  assertEquals(memory.rows("trade_invoice_lines").length, 0);
  assertEquals(opened.stripped_invoice_ids, [INV]);

  memory.rows("group_work_order_time_entries")[0].hours = 7.5;
  await freezeGroupWorkOrder(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  const recomputed = new Map(
    memory.rows("group_work_order_shares").map((row) => [
      String(row.user_id),
      Number(row.share_ex),
    ]),
  );
  assertEquals(recomputed.get(USER_A), 425.43);
  assertEquals(recomputed.get(USER_B), 56.72);

  const nextShare = String(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_A)
      ?.id,
  );
  memory.rows("trade_invoices")[0].status = "approved";
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: nextShare,
    trade_invoice_id: INV,
    line_type: "group share",
  });
  const held = await assertRejects(
    () =>
      unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(held.code, "group_split_has_live_invoice");
  assertEquals(memory.rows("group_work_orders")[0].split_frozen_at != null, true);

  const crew = await assertRejects(
    () => unfreezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(crew.status, 403);
});

Deno.test("the claim fence is mutual, travel is not a claim, and another person's share is not mine", () => {
  const share = {
    job_id: JOB,
    line_type: "group share",
    group_share_id: SHARE_A,
  };
  const hours = { job_id: JOB, line_type: "labour" };
  const travel = {
    job_id: JOB,
    line_type: "travel",
    source_work_order_id: "crew-wo",
  };
  assertEquals(
    findFenceProblem(USER_A, [share], [hours])?.code,
    "group_share_blocked_by_work_order_claim",
  );
  assertEquals(
    findFenceProblem(USER_A, [hours], [{ ...share, user_id: USER_B }])?.code,
    "work_order_claim_blocked_by_group_share",
  );
  assertEquals(
    findFenceProblem(USER_A, [share, hours], [])?.code,
    "group_share_mixed_with_hours",
  );
  assertEquals(
    findFenceProblem(USER_A, [share], [{ ...share, user_id: USER_B }]),
    null,
  );
  assertEquals(
    findFenceProblem(USER_A, [share], [{ ...share, user_id: USER_A }])?.code,
    "group_share_already_invoiced",
  );
  assertEquals(findFenceProblem(USER_A, [share], [travel]), null);
  assertEquals(
    findFenceProblem(USER_A, [share], [{
      job_id: JOB,
      line_type: "Other",
      user_id: USER_B,
    }])?.code,
    "group_share_blocked_by_work_order_claim",
  );
  assertEquals(
    isGroupShareLine({
      job_id: JOB,
      source_work_order_id: "x",
      line_type: "labour",
    }),
    false,
  );
});

Deno.test("invoice fence reads live claims and ignores a released draft", async () => {
  const memory = new Memory();
  memory.rows("feature_flags").push({
    flag_name: "group_work_order_v1",
    enabled: true,
  });
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    line_type: "labour",
    source_work_order_id: null,
    group_share_id: null,
    trade_invoice_id: INV,
  });
  memory.rows("trade_invoices").push({
    id: INV,
    status: "draft",
    user_id: USER_B,
  });
  await assertGroupWorkOrderInvoiceFence(memory.client(), {
    userId: USER_A,
    lines: [{ job_id: JOB, line_type: "group share", group_share_id: SHARE_A }],
  });
  memory.rows("trade_invoices")[0].status = "pending_acknowledgment";
  const blocked = await assertRejects(
    () =>
      assertGroupWorkOrderInvoiceFence(memory.client(), {
        userId: USER_A,
        lines: [{
          job_id: JOB,
          line_type: "group share",
          group_share_id: SHARE_A,
        }],
      }),
    GroupWorkOrderError,
  );
  assertEquals(blocked.code, "group_share_blocked_by_work_order_claim");
});

Deno.test("DEFAULT: break comes off finish minus start", () => {
  const entry = groupHoursFromBody({
    work_date: "2026-10-21",
    start_time: "08:00",
    finish_time: "12:00",
    break_minutes: 30,
  }, "2026-10-21");
  assertEquals(entry.hours, 3.5);
  assertEquals(entry.break_minutes, 30);
});

Deno.test("sending the client link is refused and nothing is addressed to a sender", () => {
  const refused = assertThrows(
    () => refuseClientLinkSend({ send: true }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "client_message_disabled");
  assertEquals(refused.status, 409);
  refuseClientLinkSend({ send: false });
  const draft = draftClientLinkMessage({
    firstName: "Alex",
    site: "Subiaco",
    link: "https://example.test/sign",
  });
  assert(draft.includes("The installers do not see what you write."));
  assert(draft.includes("https://example.test/sign"));
  assertEquals(GROUP_REVIEW_URL_SEED, GOOGLE_REVIEW_URL);
});

Deno.test("feedback is office-only, and a good rating names the configured review link", async () => {
  const refused = await assertRejects(
    () =>
      readGroupWorkOrderFeedback({} as never, trade(USER_A), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(refused.status, 403);
  assertEquals(promptGoogleReview([4, 4, 4, 4, 4], 4), true);
  assertEquals(promptGoogleReview([4, 4, 3, 4, 4], 4), false);

  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_settings").push({
    id: 1,
    google_review_url: "https://review.example/configured",
    review_prompt_min_rating: 4,
  });
  const good = await submitGroupWorkOrderFeedback(memory.client(), {
    share_token: "tok-secret",
    sales_process: 5,
    communication: 5,
    cleanliness: 5,
    punctuality: 5,
    crew: 5,
  });
  assertEquals(good.prompt_google_review, true);
  assertEquals(good.google_review_url, "https://review.example/configured");
  assertEquals(JSON.stringify(good).includes(GOOGLE_REVIEW_URL), false);
  const jobs = memory.rows("jobs");
  assertEquals(jobs[0].status, "scheduled");
});

Deno.test("client sign records the signature and does not complete the job", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const signed = await clientSignGroupWorkOrder(memory.client(), {
    share_token: "tok-secret",
    signer_name: "Alex Client",
    signature_png: png,
    signed_via: "on_site",
  });
  assertEquals(signed.client_signed, true);
  assertEquals(memory.rows("jobs")[0].status, "scheduled");
  assertEquals(memory.rows("group_work_orders")[0].status, "client_signed");
  assertEquals(memory.rows("job_media")[0].phase, "signature");
  assertEquals(memory.rows("job_client_signoffs")[0].method, "share_link");
  assertEquals(memory.rows("job_client_signoffs")[0].captured_by ?? null, null);
  assertEquals(
    memory.rows("job_client_signoffs")[0].captured_by_actor,
    "client link",
  );
  const again = await clientSignGroupWorkOrder(memory.client(), {
    share_token: "tok-secret",
    signer_name: "Alex Client",
    signature_png: png,
  });
  assertEquals(again.already_signed, true);
});

Deno.test("create_group_work_order is refused while the feature is off", async () => {
  const memory = new Memory();
  memory.rows("jobs").push({
    id: JOB,
    org_id: ORG,
    job_number: "SWF-1",
    work_order_id: WO,
    status: "scheduled",
  });
  const refused = await assertRejects(
    () => createGroupWorkOrder(memory.client(), trade(USER_A), { job_id: JOB }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "group_work_order_disabled");
  assertEquals(refused.status, 409);
  assertEquals(refused.message.toLowerCase().includes("feature off"), true);
  assertEquals(memory.rows("group_work_orders").length, 0);
  assertEquals(
    memory.calls.some((call) => call.table.startsWith("group_")),
    false,
  );

  const closed = await assertRejects(
    () =>
      unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), {
        group_id: GROUP,
      }),
    GroupWorkOrderError,
  );
  assertEquals(closed.code, "group_work_order_disabled");
  assertEquals(closed.message.toLowerCase().includes("feature off"), true);
  assertEquals(
    memory.calls.some((call) => call.table.startsWith("group_")),
    false,
  );
});

Deno.test("normal pay is every line that is not on the exclusion list", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261022050000_group_work_orders.sql",
      import.meta.url,
    ),
  );
  const start = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.group_work_order_line_is_normal_pay",
  );
  const end = sql.indexOf(
    "CREATE OR REPLACE FUNCTION public.group_work_orders_refuse_existing_pay",
  );
  const body = sql.slice(start, end);
  for (const type of [
    ...TRADE_INVOICE_TIME_LINE_TYPES,
    "hours",
    "work order",
    "work_order",
    "make_safe",
    "Other",
    "mystery",
  ]) {
    assertEquals(
      isNormalWorkOrderPayLine({ line_type: type, job_id: JOB }),
      true,
      type,
    );
  }
  assertEquals(isNormalWorkOrderPayLine({ line_type: "mystery" }), true);
  for (const type of [
    "commission",
    "travel",
    "materials",
    "equipment",
    "adjustment",
    "final_payout_deduction",
    "FinalPayoutDeduction",
    "group share",
  ]) {
    assert(body.includes(
      type.toLowerCase().replace(/_/g, "").replace(/ /g, "") === "groupshare"
        ? "'groupshare'"
        : `'${type.toLowerCase().replace(/_/g, "").replace(/ /g, "")}'`,
    ));
    assertEquals(
      isNormalWorkOrderPayLine({
        line_type: type,
        source_work_order_id: "crew-wo",
      }),
      false,
      type,
    );
  }
  assertEquals(body.includes("'labour'"), false);
  assertEquals(body.includes("'other'"), false);
  assertEquals(body.includes("feature_flags"), false);
});

Deno.test("opening a group on a job that already has a work-order claim is refused", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_orders").splice(0, memory.rows("group_work_orders").length);
  memory.rows("trade_invoices").push({ id: INV, status: "draft", user_id: USER_B });
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    trade_invoice_id: INV,
    line_type: "work order",
    group_share_id: null,
    source_work_order_id: null,
  });
  const refused = await assertRejects(
    () => createGroupWorkOrder(memory.client(), trade(USER_A, true), { job_id: JOB }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "group_open_blocked_by_work_order_claim");
  assertEquals(refused.status, 409);
  assert(refused.message.toLowerCase().includes("work-order claim"));
  assertEquals(memory.rows("group_work_orders").length, 0);

  memory.rows("trade_invoices")[0].status = "ops-reject";
  const opened = await createGroupWorkOrder(
    memory.client(),
    trade(USER_A, true),
    { job_id: JOB },
  );
  assertEquals(opened.ok, true);
  assertEquals(memory.rows("group_work_orders").length, 1);
});

Deno.test("a switch that is off never reads pay or group tables on create", async () => {
  const memory = new Memory();
  memory.rows("jobs").push({
    id: JOB,
    org_id: ORG,
    job_number: "SWF-1",
    work_order_id: WO,
    status: "scheduled",
  });
  memory.rows("trade_invoices").push({ id: INV, status: "draft" });
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    trade_invoice_id: INV,
    line_type: "decking",
  });
  const refused = await assertRejects(
    () => createGroupWorkOrder(memory.client(), trade(USER_A), { job_id: JOB }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "group_work_order_disabled");
  assertEquals(
    memory.calls.some((call) =>
      call.table.startsWith("group_") || call.table === "trade_invoice_lines"
    ),
    false,
  );
});

Deno.test("unfreeze strips only the share, and an acknowledged or Xero invoice stays", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  await freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP });
  const shareA = String(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_A)?.id,
  );
  memory.rows("trade_invoices").push({
    id: INV,
    status: "draft",
    user_id: USER_A,
    gst_on: false,
    xero_bill_id: "BILL-1",
  });
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: shareA,
    trade_invoice_id: INV,
    line_type: "group share",
    line_total_ex: 321.43,
  });
  const xero = await assertRejects(
    () => unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(xero.code, "group_split_has_live_invoice");
  assert(memory.rows("group_work_orders")[0].split_frozen_at != null);

  memory.rows("trade_invoices")[0].xero_bill_id = null;
  memory.rows("trade_invoices")[0].status = "acknowledged";
  const acknowledged = await assertRejects(
    () => unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(acknowledged.code, "group_split_has_live_invoice");

  memory.rows("trade_invoices")[0].status = "queried";
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    group_share_id: null,
    trade_invoice_id: INV,
    line_type: "travel",
    line_total_ex: 10,
  });
  const opened = await unfreezeGroupWorkOrder(
    memory.client(),
    trade(USER_A, true),
    { group_id: GROUP },
  );
  assertEquals(opened.stripped_invoice_ids, [INV]);
  assertEquals(memory.rows("group_work_orders")[0].split_frozen_at ?? null, null);
  assertEquals(memory.rows("trade_invoices")[0].status, "queried");
  assertEquals(memory.rows("trade_invoice_lines").length, 1);
  assertEquals(memory.rows("trade_invoice_lines")[0].line_type, "travel");
  assertEquals(memory.rows("trade_invoices")[0].subtotal_ex, 10);
  assertEquals(memory.rows("trade_invoices")[0].super_amount, 1.2);
  assertEquals(memory.rows("trade_invoices")[0].net_pay, 9.4);
  assertEquals(memory.rows("trade_invoices")[0].gst, 0);
  assertEquals(memory.rows("trade_invoices")[0].total_inc, 10);
});

Deno.test("a signature is a PNG or JPEG, and markup never becomes an image source", async () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const jpeg = "data:image/jpeg;base64,/9j/";
  const svg = "data:image/svg+xml;base64,PHN2Zy8+";
  const injected = 'data:image/png;base64,iVBORw0KGgo=" onerror="alert(1)';
  assertEquals(signatureDataUrl(png), png);
  assertEquals(signatureDataUrl(jpeg), jpeg);
  assertEquals(signatureDataUrl(svg), null);
  assertEquals(signatureDataUrl(injected), null);
  assertEquals(signatureDataUrl("<svg onload=alert(1)>"), null);
  const tag = signatureImageTag(png, 'A "name" <script>');
  assert(tag.startsWith(`<img src="${png}"`));
  assert(tag.includes('alt="A &quot;name&quot; &lt;script&gt;"'));
  assertEquals(tag.includes("onerror"), false);
  assertEquals(signatureImageTag(svg, "Client signature"), "");
  assertEquals(signatureImageTag(injected, "Client signature"), "");
  const https = signatureImageTag(
    "https://example.test/sign.png?a=1&b=2",
    "Client signature",
  );
  assert(https.includes("https://example.test/sign.png?a=1&amp;b=2"));
  assertEquals(
    signatureImageTag('https://example.test/x.png" onerror="alert(1)', "x"),
    "",
  );

  const memory = new Memory();
  seedSplit(memory, "open");
  const refused = await assertRejects(
    () =>
      clientSignGroupWorkOrder(memory.client(), {
        share_token: "tok-secret",
        signer_name: "Alex Client",
        signature_png: svg,
      }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "group_signature_invalid");
  assertEquals(memory.rows("job_client_signoffs").length, 0);
  assertEquals(memory.rows("job_media").length, 0);
});

Deno.test("an office removal wins over a booking, is recorded, and the office can undo it", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  // Booked on the job but not named for the group.
  memory.rows("job_assignments").push({
    job_id: JOB, user_id: USER_C, scheduled_date: "2026-10-20", status: "scheduled", role: "lead_installer",
  });
  const before = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(before.code, "group_split_needs_hours");
  assert(before.message.includes(USER_C));

  await removeGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), { group_id: GROUP, user_id: USER_C });
  assertEquals(memory.rows("job_assignments").find((r) => r.user_id === USER_C)?.status, "scheduled");

  const office = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), { group_id: GROUP });
  assertEquals(office.needs_hours.includes(USER_C), false);
  assertEquals(office.removed.map((r) => r.user_id), [USER_C]);
  assertEquals(office.removed[0].removed_by, USER_A);
  assert(office.removed[0].removed_at);

  const tradeTry = await assertRejects(
    () => restoreGroupWorkOrderParticipant(memory.client(), trade(USER_A), { group_id: GROUP, user_id: USER_C }),
    GroupWorkOrderError,
  );
  assertEquals(tradeTry.status, 403);
  await restoreGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), { group_id: GROUP, user_id: USER_C });
  assert(memory.rows("group_work_order_participants").some((r) => r.user_id === USER_C));
  assertEquals(memory.rows("group_work_order_crew_removals")[0].restored_by, USER_A);
  const back = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(back.code, "group_split_needs_hours");
  assert(back.message.includes(USER_C));
  const again = await assertRejects(
    () => restoreGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), { group_id: GROUP, user_id: USER_C }),
    GroupWorkOrderError,
  );
  assertEquals(again.code, "group_removal_not_found");
  assertEquals(again.status, 404);
  const office2 = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), { group_id: GROUP });
  assertEquals(office2.removed, []);
  assert(office2.needs_hours.includes(USER_C));
});

Deno.test("freeze names an installer who has not joined, and removal is only before freeze", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  memory.rows("job_assignments").push({
    job_id: JOB,
    user_id: USER_C,
    scheduled_date: "2026-10-20",
    status: "scheduled",
    role: "lead_installer",
  });
  const named = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(named.code, "group_split_needs_hours");
  assert(named.message.includes(USER_C));
  assertEquals(named.message.includes(USER_A), false);

  const crew = await assertRejects(
    () =>
      removeGroupWorkOrderParticipant(memory.client(), trade(USER_A), {
        group_id: GROUP,
        user_id: USER_B,
      }),
    GroupWorkOrderError,
  );
  assertEquals(crew.status, 403);

  await removeGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
    user_id: USER_B,
  });
  const stillAssigned = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  // The office removal wins over B's booking for this group (20261106170000).
  assertEquals(stillAssigned.code, "group_split_needs_hours");
  assertEquals(stillAssigned.message.includes(USER_B), false);
  assert(stillAssigned.message.includes(USER_C));

  for (const row of memory.rows("job_assignments")) {
    if (row.user_id === USER_B || row.user_id === USER_C) row.status = "cancelled";
  }
  memory.rows("job_client_signoffs").push({
    id: "after-removal",
    job_id: JOB,
    method: "share_link",
    signed_name: "Alex Client",
    happy: true,
    satisfaction_rating: 5,
    signature_media_id: "media-after",
    captured_by_actor: "client link",
    created_at: "2026-11-02T00:00:00.000Z",
  });
  const frozen = await freezeGroupWorkOrder(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(frozen.awaiting, "frozen");
  const held = await assertRejects(
    () =>
      removeGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), {
        group_id: GROUP,
        user_id: USER_A,
      }),
    GroupWorkOrderError,
  );
  assertEquals(held.code, "group_split_frozen");
  assertEquals(
    memory.rows("group_work_order_events").some((row) =>
      row.action === "remove_participant" && row.user_id === USER_B
    ),
    true,
  );
  assert(
    memory.rows("group_work_order_participants").some((row) => row.user_id === USER_A),
  );
});

Deno.test("group sign-off requires fresh evidence; incomplete waiver and revoked rows fail", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  memory.rows("group_work_order_time_entries").push(
    {
      group_id: GROUP,
      user_id: USER_A,
      work_date: "2026-10-20",
      hours: 2,
      created_at: "2026-10-22T00:00:00Z",
    },
    {
      group_id: GROUP,
      user_id: USER_B,
      work_date: "2026-10-20",
      hours: 2,
      created_at: "2026-10-22T00:00:00Z",
    },
  );
  memory.rows("job_client_signoffs").push({
    id: "early",
    job_id: JOB,
    method: "on_site",
    signature_media_id: "media-early",
    happy: true,
    created_at: "2026-10-21T00:00:00Z",
  });
  const early = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(early.code, "group_client_signoff_required");

  memory.rows("job_client_signoffs").push({
    id: "waiver",
    job_id: JOB,
    method: "office_waiver",
    signature_media_id: "media-waiver",
    happy: true,
    created_at: "2026-10-23T00:00:00Z",
  });
  const waiver = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(waiver.code, "group_client_signoff_required");

  memory.rows("job_client_signoffs").push({
    id: "revoked",
    job_id: JOB,
    method: "revoked",
    created_at: "2026-10-24T00:00:00Z",
  });
  const revoked = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(revoked.code, "group_client_signoff_required");

  memory.rows("job_client_signoffs").push({
    id: "drawn",
    job_id: JOB,
    method: "share_link",
    signature_media_id: "media-drawn",
    happy: true,
    satisfaction_rating: 5,
    created_at: "2026-10-25T00:00:00Z",
  });
  const frozen = await freezeGroupWorkOrder(memory.client(), trade(USER_A), {
    group_id: GROUP,
  });
  assertEquals(frozen.awaiting, "frozen");
});

Deno.test("an hour edited after the drawing is not signed", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  memory.rows("group_work_order_time_entries").push(
    {
      group_id: GROUP,
      user_id: USER_A,
      work_date: "2026-10-20",
      hours: 2,
      created_at: "2026-10-20T00:00:00Z",
      updated_at: "2026-10-26T00:00:00Z",
    },
    {
      group_id: GROUP,
      user_id: USER_B,
      work_date: "2026-10-20",
      hours: 2,
      created_at: "2026-10-20T00:00:00Z",
      updated_at: "2026-10-20T00:00:00Z",
    },
  );
  memory.rows("job_client_signoffs").push({
    id: "drawn",
    job_id: JOB,
    method: "on_site",
    signature_media_id: "media-drawn",
    happy: true,
    created_at: "2026-10-25T00:00:00Z",
  });
  const edited = await assertRejects(
    () => freezeGroupWorkOrder(memory.client(), trade(USER_A), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(edited.code, "group_client_signoff_required");
});

function drawnSignoff(id: string, createdAt: string): Row {
  return {
    id,
    job_id: JOB,
    method: "share_link",
    signed_name: "Alex Client",
    happy: true,
    satisfaction_rating: 5,
    signature_media_id: `media-${id}`,
    captured_by_actor: "client link",
    created_at: createdAt,
  };
}

Deno.test("deleting hours or removing a participant invalidates the client sign-off", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  await submitGroupWorkOrderHours(memory.client(), trade(USER_A), {
    group_id: GROUP,
    work_date: "2026-10-20",
    start_time: "08:00",
    finish_time: "10:00",
    break_minutes: 0,
    hours: 2,
  });
  const group = memory.rows("group_work_orders").find((row) => row.id === GROUP)!;
  const afterInsert = Date.parse(String(group.hours_changed_at));
  assert(Number.isFinite(afterInsert));
  memory.rows("job_client_signoffs").push(
    drawnSignoff("after-hours", new Date(afterInsert + 500).toISOString()),
  );
  const signed = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(signed.client_signed, true);

  await deleteGroupWorkOrderHours(memory.client(), trade(USER_A), {
    group_id: GROUP,
    work_date: "2026-10-20",
  });
  const wiped = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(wiped.client_signed, false);
  assertEquals(memory.rows("group_work_order_time_entries").length, 0);

  memory.rows("group_work_order_participants").push({
    id: "p-c",
    group_id: GROUP,
    user_id: USER_C,
  });
  const afterDelete = Date.parse(String(group.hours_changed_at));
  memory.rows("job_client_signoffs").push(
    drawnSignoff("after-delete", new Date(afterDelete + 500).toISOString()),
  );
  const again = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(again.client_signed, true);

  await removeGroupWorkOrderParticipant(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
    user_id: USER_C,
  });
  const removed = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(removed.client_signed, false);
  assertEquals(
    memory.rows("group_work_order_participants").some((row) => row.user_id === USER_C),
    false,
  );
});

Deno.test("ordinary hours on a group job are a draft 409, and the hours list drops that job", async () => {
  const memory = new Memory();
  memory.rows("group_work_orders").push({
    id: GROUP,
    job_id: JOB,
    status: "open",
  });
  memory.rows("feature_flags").push({
    flag_name: "group_work_order_v1",
    enabled: false,
  });
  for (const line_type of ["labour", "Other", "mystery"]) {
    const refused = await assertRejects(
      () => assertGroupJobDraftUsesShare(memory.client(), [{ job_id: JOB, line_type }]),
      GroupWorkOrderError,
    );
    assertEquals(refused.code, "group_job_uses_share");
    assertEquals(refused.status, 409);
    assertEquals(
      refused.message,
      "This job is on a group work order. Save your share, not ordinary hours.",
    );
  }
  await assertGroupJobDraftUsesShare(memory.client(), [
    { job_id: JOB, line_type: "travel" },
    { job_id: JOB, line_type: "commission" },
    { job_id: JOB, line_type: "group share" },
    { line_type: "labour" },
  ]);
  await assertGroupJobDraftUsesShare(memory.client(), []);
  memory.rows("group_work_orders")[0].status = "void";
  await assertGroupJobDraftUsesShare(memory.client(), [{ job_id: JOB, line_type: "labour" }]);
  assertEquals(memory.calls.some((call) => call.table === "feature_flags"), false);

  const kept = withoutGroupJobAssignments([
    { id: "group-job", jobs: { id: JOB } },
    { id: "other-job", jobs: { id: OTHER_JOB } },
    { id: "no-job", jobs: null },
    { id: "blank-job", jobs: { id: "" } },
    { id: "missing-jobs" },
  ], new Set([JOB]));
  assertEquals(kept.map((row) => row.id), [
    "other-job",
    "no-job",
    "blank-job",
    "missing-jobs",
  ]);

  const boom = {
    from() {
      const builder = {
        select() {
          return builder;
        },
        in() {
          return builder;
        },
        then(
          resolve: (value: { data: null; error: { message: string } }) => unknown,
        ) {
          return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve);
        },
      };
      return builder;
    },
  };
  const unread = await assertRejects(
    () => assertGroupJobDraftUsesShare(boom, [{ job_id: JOB, line_type: "labour" }]),
    GroupWorkOrderError,
  );
  assertEquals(unread.code, "group_work_order_unreadable");
  assertEquals(unread.status, 503);
});

Deno.test("unfreeze clears a deduction the reduced payable cannot cover", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  await freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP });
  const shareA = String(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_A)?.id,
  );
  memory.rows("trade_invoices").push(
    {
      id: "inv-over",
      status: "queried",
      gst_on: true,
      week_start: "2026-10-12",
      recurring_deduction_id: "ded-50",
      recurring_deduction_label: "Ute hire",
      recurring_deduction_amount: 50,
      recurring_deduction_note: null,
    },
    {
      id: "inv-zero",
      status: "queried",
      gst_on: true,
      invoice_source: "hourly",
      week_start: "2026-10-05",
      recurring_deduction_id: "ded-zero",
      recurring_deduction_label: "Ute hire",
      recurring_deduction_amount: 50,
    },
    {
      id: "inv-fit",
      status: "queried",
      gst_on: true,
      week_start: "2026-09-28",
      recurring_deduction_id: "ded-5",
      recurring_deduction_label: "Ute hire",
      recurring_deduction_amount: 5,
      recurring_deduction_note: "kept",
    },
  );
  memory.rows("trade_invoice_lines").push(
    {
      trade_invoice_id: "inv-over",
      group_share_id: shareA,
      line_type: "group share",
      line_total_ex: 100,
    },
    { trade_invoice_id: "inv-over", line_type: "travel", line_total_ex: 10 },
    {
      trade_invoice_id: "inv-zero",
      group_share_id: shareA,
      line_type: "group share",
      line_total_ex: 100,
    },
    {
      trade_invoice_id: "inv-fit",
      group_share_id: shareA,
      line_type: "group share",
      line_total_ex: 100,
    },
    { trade_invoice_id: "inv-fit", line_type: "travel", line_total_ex: 10 },
  );
  await unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP });
  const invoice = (id: string) =>
    memory.rows("trade_invoices").find((row) => row.id === id)!;
  const over = invoice("inv-over");
  assertEquals(over.net_pay, 9.4);
  assertEquals(over.gst, 1);
  assertEquals(over.total_inc, 11);
  assertEquals(over.recurring_deduction_id, null);
  assertEquals(over.recurring_deduction_label, null);
  assertEquals(over.recurring_deduction_amount, null);
  assertEquals(
    over.recurring_deduction_note,
    "Ute hire $50.00 NOT taken for the week starting 2026-10-12: the amount payable on this invoice ($10.40) is less than the deduction. Nothing was taken off. The office to recover it another way.",
  );
  const zero = invoice("inv-zero");
  assertEquals(zero.net_pay, 0);
  assertEquals(zero.gst, 0);
  assertEquals(zero.recurring_deduction_amount, null);
  assertEquals(zero.recurring_deduction_note, null);
  const fit = invoice("inv-fit");
  assertEquals(fit.net_pay, 9.4);
  assertEquals(fit.gst, 1);
  assertEquals(fit.recurring_deduction_amount, 5);
  assertEquals(fit.recurring_deduction_label, "Ute hire");
  assertEquals(fit.recurring_deduction_note, "kept");
});

Deno.test("a busy weekly lock is try again, not a live invoice", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  await freezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP });
  const shareA = String(
    memory.rows("group_work_order_shares").find((row) => row.user_id === USER_A)?.id,
  );
  memory.rows("trade_invoices").push({
    id: INV,
    status: "acknowledged",
    gst_on: false,
  });
  memory.rows("trade_invoice_lines").push({
    trade_invoice_id: INV,
    group_share_id: shareA,
    line_type: "group share",
    line_total_ex: 321.43,
  });
  memory.weeklyLockHeld = true;
  const busy = await assertRejects(
    () => unfreezeGroupWorkOrder(memory.client(), trade(USER_A, true), { group_id: GROUP }),
    GroupWorkOrderError,
  );
  assertEquals(busy.code, "group_split_busy");
  assertEquals(busy.status, 409);
  assertEquals(busy.message, "The weekly invoice is busy, try again.");
  assertEquals(busy.code === "group_split_has_live_invoice", false);
  assert(memory.rows("group_work_orders")[0].split_frozen_at);
  assert(
    memory.rows("trade_invoice_lines").some((line) => line.line_type === "group share"),
  );
});

Deno.test("saving the same hours again does not wipe the signature", async () => {
  const memory = new Memory();
  seedSplit(memory, "open");
  const entry = groupHoursFromBody({
    work_date: "2026-10-20",
    start_time: "08:00",
    finish_time: "10:00",
    break_minutes: 0,
    hours: 2,
  });
  memory.rows("group_work_order_time_entries").push({
    group_id: GROUP,
    user_id: USER_A,
    ...entry,
    created_at: "2026-10-20T00:00:00.000Z",
    updated_at: "2026-10-20T00:00:00.000Z",
  });
  memory.rows("job_client_signoffs").push(
    drawnSignoff("before-resave", "2026-10-25T00:00:00.000Z"),
  );
  await submitGroupWorkOrderHours(memory.client(), trade(USER_A), {
    group_id: GROUP,
    ...entry,
  });
  const row = memory.rows("group_work_order_time_entries")[0];
  assertEquals(row.updated_at, "2026-10-20T00:00:00.000Z");
  assertEquals(
    memory.rows("group_work_orders").find((group) => group.id === GROUP)?.hours_changed_at,
    undefined,
  );
  const still = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(still.client_signed, true);

  await submitGroupWorkOrderHours(memory.client(), trade(USER_A), {
    group_id: GROUP,
    work_date: "2026-10-20",
    start_time: "08:00",
    finish_time: "11:00",
    break_minutes: 0,
    hours: 3,
  });
  const changed = await readGroupWorkOrderOffice(memory.client(), trade(USER_A, true), {
    group_id: GROUP,
  });
  assertEquals(changed.client_signed, false);
  assert(
    memory.rows("group_work_orders").find((group) => group.id === GROUP)?.hours_changed_at,
  );
});

Deno.test("ops-api wires the share, the fence, and the trade and public doors", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const setBody = (name: string) => {
    const start = source.indexOf(`const ${name} = new Set([`);
    assert(start > 0);
    return source.slice(start, source.indexOf("])", start));
  };
  const profile = setBody("OPS_API_PROFILE_SCOPED_JWT_ACTIONS");
  for (
    const action of [
      "create_group_work_order",
      "join_group_work_order",
      "sign_group_work_order",
      "submit_group_work_order_hours",
      "delete_group_work_order_hours",
      "group_work_order_my_share",
      "capture_group_client_signoff",
      "freeze_group_work_order",
      "group_work_order_preview_client_link",
    ]
  ) {
    assert(profile.includes(`'${action}'`));
    assertEquals(source.split(`case '${action}':`).length - 1, 2);
  }
  assertEquals(profile.includes("group_work_order_feedback"), false);
  assertEquals(profile.includes("group_work_order_office"), false);
  assertEquals(profile.includes("unfreeze_group_work_order"), false);
  assertEquals(profile.includes("revoke_group_signoff"), false);
  assertEquals(profile.includes("void_group_work_order"), false);
  assertEquals(profile.includes("rekey_group_work_order"), false);
  assertEquals(profile.includes("remove_group_work_order_participant"), false);
  assertEquals(source.split("case 'unfreeze_group_work_order':").length - 1, 1);
  assertEquals(
    source.split("case 'remove_group_work_order_participant':").length - 1,
    1,
  );
  assertEquals(source.split("case 'revoke_group_signoff':").length - 1, 1);
  assertEquals(source.split("case 'void_group_work_order':").length - 1, 1);
  assertEquals(source.split("case 'rekey_group_work_order':").length - 1, 1);
  const pub = setBody("OPS_API_STATIC_KEY_COMPATIBLE_ACTIONS");
  assertEquals(pub.includes("unfreeze_group_work_order"), false);
  for (
    const action of [
      "group_work_order_public",
      "group_work_order_client_sign",
      "group_work_order_submit_feedback",
    ]
  ) {
    assert(pub.includes(`'${action}'`));
  }
  assert(source.includes("resolveGroupShareInvoiceExtra"));
  assert(source.includes("assertGroupWorkOrderInvoiceFence"));
  assert(source.includes("assertLegacyInvoiceNotOnGroupJob"));
  assert(source.includes("assertGroupJobDraftUsesShare"));
  assert(source.includes("withoutGroupJobAssignments"));
  assert(source.includes("group_job_uses_share"));
  assert(source.includes("group_share_id: dbLine.group_share_id || null"));
  assert(
    source.includes(
      "const RELEASED_INVOICE_STATUSES: readonly string[] = ['draft', 'failed', 'ops-reject']",
    ),
  );
  assertEquals([...GROUP_FENCE_RELEASED_INVOICE_STATUSES], [
    "draft",
    "ops-reject",
  ]);
  const moduleSource = await Deno.readTextFile(
    new URL("./group_work_order.ts", import.meta.url),
  );
  assert(moduleSource.includes("DEFAULT, owner to confirm"));
  assert(moduleSource.includes("freeze_group_work_order_split"));
  assert(moduleSource.includes("project_group_work_order_split"));
  assert(moduleSource.includes("unfreeze_group_work_order_split"));
  assertEquals(moduleSource.includes("sharesAreFrozen"), false);
  assertEquals(moduleSource.includes("send_review_request"), false);
  assertEquals(moduleSource.includes("complete_my_job"), false);
  assertEquals(moduleSource.includes("send_sms"), false);
  assertEquals(source.includes('src="${report.signature_data}"'), false);
  assert(source.includes("signatureImageTag(report.signature_data, 'Signature')"));
  const pack = await Deno.readTextFile(
    new URL("../completion-pack/index.ts", import.meta.url),
  );
  assertEquals(pack.includes('src="${signature.signature_data}"'), false);
  assert(pack.includes("signatureImageTag(signature.signature_data, 'Client signature')"));
  assert(pack.includes("completionPackEmailPlan"));
  assert(pack.includes("completion_pack_client_email_v1"));
  assert(pack.includes("plan.send"));
  assert(pack.includes("completionPackClientSignature"));
  assertEquals(pack.includes("job_service_reports"), false);
});

Deno.test("only historical frozen groups keep office waivers; reopening needs a fresh client sign-off", async () => {
  const memory = new Memory(); seedSplit(memory, "open");
  const group = memory.rows("group_work_orders")[0];
  memory.rows("group_client_signoff_policy").push({id:1,client_confirmation_since:"2026-10-24T00:00:00Z"});
  memory.rows("job_client_signoffs").push({id:"historical-office",job_id:JOB,method:"office_waiver",
    waiver_reason:"Fixture approval",captured_by_actor:"user:office",created_at:"2026-10-21T00:00:00Z"});
  const read = () => readGroupWorkOrderOffice(memory.client(),trade(USER_A,true),{group_id:GROUP});
  assertEquals((await read()).client_signed,false,"an office waiver cannot unlock a new freeze");
  group.split_frozen_at="2026-10-22T00:00:00Z";
  assertEquals((await read()).client_signed,true,"the existing frozen authority is preserved");
  group.split_frozen_at=null; group.signoff_required_after="2026-10-25T00:00:00Z";
  assertEquals((await read()).client_signed,false);
  memory.rows("job_client_signoffs").push({id:"fresh-client",job_id:JOB,method:"on_site",signature_media_id:"fixture-signature",happy:true,created_at:"2026-10-26T00:00:00Z"});
  assertEquals((await read()).client_signed,true);
  group.hours_changed_at="2026-10-27T00:00:00Z";
  assertEquals((await read()).client_signed,false);
});

Deno.test("all-in group accepts one isolated share and refuses mixed weekly claims", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("group_work_orders")[0].pay_basis="all_in_12_6_v1";
  const own={extra_items:[{type:"group share",group_id:GROUP}]};
  await assertAllInGroupInvoiceStandalone(db.client(),trade(USER_A),own);
  for(const extra of [{week_start:"2026-10-19"},{extra_items:[...own.extra_items,{type:"travel",quantity:1,rate:10}]},{manual_assignments:[{assignment_id:"a"}]},{final_deductions:[{amount:1}]},{extra_items:[...own.extra_items,...own.extra_items]}]) {
    await assertRejects(()=>assertAllInGroupInvoiceStandalone(db.client(),trade(USER_A),{...own,...extra}),GroupWorkOrderError);
  }
});

Deno.test("allocated workers discover an unjoined group without reading its money",async()=>{
 const db=new Memory(); seedSplit(db);
 assertEquals((await readMyGroupWorkOrders(db.client(),trade(USER_C))).groups,[]);
 db.rows("job_assignments").push({id:"new-assignment",job_id:JOB,user_id:USER_C,status:"scheduled",role:"crew",is_ghost:false});
 const found=await readMyGroupWorkOrders(db.client(),trade(USER_C));
 assertEquals(found.groups.length,1);
 assertEquals(found.groups[0].awaiting,"needs_join");
 assertEquals(found.groups[0].pot_total,null); assertEquals(found.groups[0].my_share,null);
 assertEquals(found.group_job_ids,[JOB]);
 db.rows("job_assignments").at(-1)!.is_ghost=true;
 assertEquals((await readMyGroupWorkOrders(db.client(),trade(USER_C))).groups,[]);
});

Deno.test("invoice routing distinguishes missing groups and refuses a later job despite earlier hourly claims", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("jobs")[0].type = "patio";
  db.rows("feature_flags").push({ flag_name: "patio_pay_group_only_v1", enabled: true });
  const read = () => readInvoicePayableRoutes(db.client(), [JOB], [], ORG);
  assertEquals(await read(), [{ job_id: JOB, route: "group_setup_required", group_id: null, setup_reason: "group_missing", discovery: { state: "create" } }]);
  const existingGroups = db.rows("group_work_orders").splice(0);
  let amountRequests = 0;
  const refusal = await assertRejects(() => assertPatioPaysThroughGroup(db.client(),
    [{ job_id: JOB, line_type: "labour" }], null, async () => { amountRequests++; }),
    GroupWorkOrderError, "The approved work-order amount is ready");
  assertEquals((refusal as GroupWorkOrderError).code, "patio_pay_group_only");
  assertEquals(amountRequests, 0, "an approved allowance must not request a missing amount");
  db.rows("work_orders")[0].agreed_labour_ex = null;
  assertEquals((await read())[0].setup_reason, "allowance_missing");
  db.rows("trade_invoice_lines").push({ job_id: JOB, line_type: "commission", trade_invoices: { status: "paid" } });
  assertEquals((await read())[0].route, "group_setup_required");
  db.rows("trade_invoice_lines").push({ job_id: JOB, line_type: "labour", trade_invoices: { status: "paid" } });
  assertEquals((await read())[0].route, "group_setup_required");
  assertEquals(await readInvoicePayableRoutes(db.client(), [JOB], [], "another-org"), []);
  assertEquals(await readInvoicePayableRoutes(db.client(), [JOB], existingGroups, ORG),
    [{ job_id: JOB, route: "group", group_id: GROUP, discovery: { state: "join" } }]);
});

Deno.test("allocated fencing and patio crew get the same price-free Create or Join decision", async () => {
  for (const type of ["fencing", "patio"]) {
    const db = new Memory();
    seedSplit(db);
    db.rows("jobs")[0].type = type;
    const groups = db.rows("group_work_orders").splice(0);
    let read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery, { state: "create" });
    assertEquals(Object.hasOwn(read, "pot_total"), false);
    assertEquals(Object.hasOwn(read, "share_token"), false);
    db.rows("trade_invoice_lines").push({ job_id: JOB, line_type: "work order", trade_invoices: { status: "draft", user_id: USER_B } });
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery?.reason, "normal_pay_exists");
    db.rows("trade_invoice_lines").splice(0);
    // Someone else's hourly pay leaves the group open to the rest of the crew;
    // the person paid by the hour is told so instead (20261106160000).
    db.rows("trade_invoice_lines").push({ job_id: JOB, line_type: "labour", trade_invoices: { status: "paid", user_id: USER_B, xero_bill_id: "BILL-B", xero_bill_status: "PAID" } });
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery, { state: "create" });
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_B), { job_id: JOB });
    assertEquals(read.discovery?.reason, "paid_by_hours");
    db.rows("trade_invoice_lines").splice(0);
    // An hours draft not billed in Xero yet is not paid: it holds the group.
    db.rows("trade_invoice_lines").push({ job_id: JOB, line_type: "labour", trade_invoices: { status: "draft", user_id: USER_B } });
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery?.reason, "hours_claim_unresolved");
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_B), { job_id: JOB });
    assertEquals(read.discovery?.reason, "hours_claim_unresolved");
    db.rows("trade_invoice_lines").splice(0);
    db.rows("group_work_orders").push(...groups);
    db.rows("group_work_order_participants").splice(0);
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery, { state: "join" });
    assertEquals(Object.hasOwn(read, "pot_total"), false);
    db.rows("group_work_orders")[0].split_frozen_at = "2026-10-22T00:00:00Z";
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery?.reason, "group_frozen");
    db.rows("group_work_order_participants").push({ id: "own-participant", group_id: GROUP, user_id: USER_A });
    read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery, { state: "member" });
    assertEquals(Object.hasOwn(read, "share_token"), false);
    assertEquals(Object.hasOwn(read, "shares"), false);
    db.rows("job_assignments").forEach(row => { row.is_ghost = true; });
    await assertRejects(() => readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB }), GroupWorkOrderError, "not allocated");
    await assertRejects(() => readTradeGroupWorkOrder(db.client(), { ...trade(USER_A), orgId: "other-org" }, { job_id: JOB }), GroupWorkOrderError, "not found");
  }
});

Deno.test("the office can still mark a full-super crew's hours approved; nobody waits for it", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  db.rows("group_work_orders")[0].pay_basis = "all_in_12_v2";
  db.rows("group_work_order_time_entries").push(
    { id: "t-a", group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 8, created_at: "2026-10-20T08:00:00Z", updated_at: "2026-10-20T08:00:00Z" },
    { id: "t-b", group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 8, created_at: "2026-10-20T08:00:00Z", updated_at: "2026-10-20T08:00:00Z" },
  );
  const before = await readGroupWorkOrderOffice(db.client(), trade("office-1", true), { group_id: GROUP });
  // Nobody approves anyone else's hours (6 Nov 2026), so nobody is listed.
  assertEquals(before.needs_approval, []);
  assertEquals(before.hours_office_approved, false);

  // A plain trade cannot, and someone on the crew cannot even with an office role.
  await assertRejects(() => officeApproveGroupHours(db.client(), trade("office-1"), { group_id: GROUP, reason: "Crew agreed by phone" }), GroupWorkOrderError);
  const own = await officeApproveGroupHours(db.client(), trade(USER_A, true), { group_id: GROUP, reason: "Crew agreed by phone" })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(own?.code, "group_office_approver_on_crew");
  const noReason = await officeApproveGroupHours(db.client(), trade("office-1", true), { group_id: GROUP, reason: " " })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(noReason?.code, "group_office_approval_reason_required");
  assertEquals(db.rows("group_work_orders")[0].hours_office_approved_at, undefined);

  const done = await officeApproveGroupHours(db.client(), trade("office-1", true), { group_id: GROUP, reason: "Crew agreed by phone" });
  assertEquals(done.hours_office_approved, true);
  const after = await readGroupWorkOrderOffice(db.client(), trade("office-1", true), { group_id: GROUP });
  assertEquals(after.needs_approval, []);
  assertEquals(after.hours_office_approved, true);
  // Crew signatures are untouched: the office approval is not a crew signature.
  assert(db.rows("group_work_order_participants").every((row) => !row.crew_signed_at));

  // A later hours change takes the office mark off; still nobody is waited on.
  db.rows("group_work_orders")[0].hours_changed_at = "2099-01-02T00:00:00Z";
  const changed = await readGroupWorkOrderOffice(db.client(), trade("office-1", true), { group_id: GROUP });
  assertEquals(changed.needs_approval, []);
  assertEquals(changed.hours_office_approved, false);
});

Deno.test("the sweep picks one unpushed share invoice from each ready, unreleased full-super group only", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  const g = db.rows("group_work_orders")[0];
  Object.assign(g, { pay_basis: "all_in_12_v2", split_frozen_at: "2026-10-29T10:00:00Z", __ready: true });
  db.rows("group_work_order_shares").push({ id: "share-a", group_id: GROUP, user_id: USER_A }, { id: "share-b", group_id: GROUP, user_id: USER_B });
  db.rows("trade_invoices").push(
    { id: "inv-old", status: "ops-reject", xero_bill_id: null },
    { id: "inv-a", status: "pending_acknowledgment", xero_bill_id: null },
    { id: "inv-b", status: "pending_acknowledgment", xero_bill_id: null },
  );
  db.rows("trade_invoice_lines").push(
    { trade_invoice_id: "inv-old", group_share_id: "share-a" },
    { trade_invoice_id: "inv-a", group_share_id: "share-a" },
    { trade_invoice_id: "inv-b", group_share_id: "share-b" },
  );
  assertEquals((await readyUnreleasedGroupInvoiceIds(db.client())).length, 1);
  assert(["inv-a", "inv-b"].includes((await readyUnreleasedGroupInvoiceIds(db.client()))[0]));

  g.__ready = false; // e.g. no current sign-off: the office has to tick it
  assertEquals(await readyUnreleasedGroupInvoiceIds(db.client()), []);
  g.__ready = true;
  db.rows("group_work_order_releases").push({ group_id: GROUP });
  assertEquals(await readyUnreleasedGroupInvoiceIds(db.client()), []);
  db.rows("group_work_order_releases").length = 0;
  g.pay_basis = "all_in_12_6_v1"; // older groups keep their office approval
  assertEquals(await readyUnreleasedGroupInvoiceIds(db.client()), []);
  g.pay_basis = "all_in_12_v2";
  db.rows("feature_flags")[0].enabled = false;
  assertEquals(await readyUnreleasedGroupInvoiceIds(db.client()), []);
});

Deno.test("a Grok Bot sets up a group for named allocated crew on an office person's word", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  db.rows("group_work_orders").length = 0;
  db.rows("group_work_order_participants").length = 0;
  db.rows("users").push(
    { id: "office-nithin", name: "Nithin", role: "ops_manager", org_id: ORG },
    { id: USER_A, name: "Henry", role: "crew", org_id: ORG },
    { id: USER_B, name: "Ryan", role: "crew", org_id: ORG },
    { id: USER_C, name: "Sonny", role: "crew", org_id: ORG },
  );
  const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e as GroupWorkOrderError).code);
  assertEquals(await code(agentCreateGroupWorkOrder(db.client(), { job_id: JOB, requested_by_user_id: "office-nithin", crew_user_ids: [USER_A] })), "group_crew_required");
  assertEquals(await code(agentCreateGroupWorkOrder(db.client(), { job_id: JOB, requested_by_user_id: USER_B, crew_user_ids: [USER_A, USER_B] })), "group_requester_not_office");
  assertEquals(await code(agentCreateGroupWorkOrder(db.client(), { job_id: JOB, requested_by_user_id: "office-nithin", crew_user_ids: [USER_A, USER_C] })), "group_crew_not_allocated");
  assertEquals(db.rows("group_work_orders").length, 0);

  const made = await agentCreateGroupWorkOrder(db.client(), { job_id: JOB, requested_by_user_id: "office-nithin", crew_user_ids: [USER_A, USER_B] });
  assertEquals(made.created, true);
  assertEquals(db.rows("group_work_orders").length, 1);
  assertEquals(db.rows("group_work_orders")[0].created_by, "office-nithin");
  assertEquals(db.rows("group_work_orders")[0].pay_basis, "all_in_12_v2");
  assertEquals(db.rows("group_work_order_participants").map((r) => r.user_id).sort(), [USER_A, USER_B].sort());
  assertEquals(made.crew.map((c: any) => c.added), [true, true]);

  // Asking again changes nothing.
  const again = await agentCreateGroupWorkOrder(db.client(), { job_id: JOB, requested_by_user_id: "office-nithin", crew_user_ids: [USER_A, USER_B] });
  assertEquals(again.created, false);
  assertEquals(db.rows("group_work_orders").length, 1);
  assertEquals(db.rows("group_work_order_participants").length, 2);
});

Deno.test("patio hourly exception belongs only to work started before the first group job", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("jobs")[0].type = "patio";
  db.rows("jobs").push({
    id: OTHER_JOB,
    org_id: ORG,
    type: "patio",
    work_order_id: WO,
  });
  db.rows("feature_flags").push({
    flag_name: "patio_pay_group_only_v1",
    enabled: true,
  });
  db.rows("job_assignments").push(
    {
      id: "anchor",
      job_id: JOB,
      scheduled_date: "2026-01-10",
      status: null,
      is_ghost: false,
    },
    {
      id: "old",
      job_id: OTHER_JOB,
      scheduled_date: "2026-01-09",
      status: null,
      is_ghost: false,
    },
    { id: "watch", job_id: JOB, scheduled_date: "2026-01-01", is_ghost: true },
    {
      id: "observer",
      job_id: JOB,
      scheduled_date: "2026-01-01",
      role: "observer",
    },
    {
      id: "cancelled",
      job_id: JOB,
      scheduled_date: "2026-01-01",
      status: "cancelled",
    },
  );
  db.rows("trade_invoice_lines").push({
    job_id: OTHER_JOB,
    line_type: "labour",
    trade_invoice_id: "prior",
    trade_invoices: { status: "paid" },
  });
  const jobs = db.rows("jobs");
  assertEquals([...await readPatioLegacyHoursJobIds(db.client(), jobs)], [
    OTHER_JOB,
  ]);
  const read = () =>
    readInvoicePayableRoutes(db.client(), [OTHER_JOB], [], ORG);
  assertEquals((await read())[0].route, "hours");
  await assertPatioPaysThroughGroup(db.client(), [{
    job_id: OTHER_JOB,
    line_type: "labour",
  }]);
  db.rows("job_assignments").find((r) => r.id === "old")!.scheduled_date =
    "2026-01-11";
  assertEquals((await read())[0].route, "group_setup_required");
  await assertRejects(
    () =>
      assertPatioPaysThroughGroup(db.client(), [{
        job_id: OTHER_JOB,
        line_type: "labour",
      }]),
    GroupWorkOrderError,
  );
  // A historical rejected claim grants nothing, even for an older job.
  db.rows("job_assignments").find((r) => r.id === "old")!.scheduled_date =
    "2026-01-09";
  db.rows("trade_invoice_lines")[0].trade_invoices = { status: "ops-reject" };
  assertEquals((await read())[0].route, "group_setup_required");
});

Deno.test("an existing group cannot be bypassed by a legacy ordinary claim", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("jobs")[0].type = "patio";
  db.rows("feature_flags").push({
    flag_name: "patio_pay_group_only_v1",
    enabled: true,
  });
  db.rows("trade_invoice_lines").push({
    job_id: JOB,
    line_type: "labour",
    trade_invoice_id: "prior",
    trade_invoices: { status: "paid" },
  });
  await assertRejects(
    () =>
      assertPatioPaysThroughGroup(db.client(), [{
        job_id: JOB,
        line_type: "labour",
      }]),
    GroupWorkOrderError,
  );
});

Deno.test("patio cohort scans all allocation pages and keeps a voided anchor as history", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("jobs")[0].type = "patio";
  db.rows("group_work_orders")[0].status = "void";
  db.rows("jobs").push({ id: OTHER_JOB, org_id: ORG, type: "patio" });
  for (let n = 0; n < 501; n++) {
    db.rows("job_assignments").push({
      id: `a-${n}`,
      job_id: JOB,
      is_ghost: true,
      scheduled_date: "2025-01-01",
    });
  }
  db.rows("job_assignments").push({
    id: "z-anchor",
    job_id: JOB,
    status: null,
    scheduled_date: "2026-01-10",
  }, {
    id: "z-old",
    job_id: OTHER_JOB,
    status: null,
    scheduled_date: "2026-01-09",
  });
  assertEquals([
    ...await readPatioLegacyHoursJobIds(db.client(), db.rows("jobs")),
  ], [OTHER_JOB]);
  for (const row of db.rows("job_assignments")) {
    if (row.job_id === JOB) row.scheduled_date = null;
  }
  assertEquals([
    ...await readPatioLegacyHoursJobIds(db.client(), db.rows("jobs")),
  ], []);

});

function confirmationBody(kind = "written_confirmation"): Record<string, unknown> {
  return {job_id:JOB,request_id:crypto.randomUUID(),signed_name:"Fixture Client",
    client_confirmed_on:new Date(Date.now()+8*3600000).toISOString().slice(0,10),work_done:"Fixture installation",
    outstanding_items:"A recorded fixture note",client_accepts:true,current_client_confirmation:true,
    confirmation_kind:kind,confirmation_reference:kind==="written_confirmation"?"Email fixture, recorded client message ABC":""};
}
function copyStorage(client: any) {
  const objects = new Map<string, Uint8Array>(); let writes=0;
  client.storage={from:()=>({
    upload:(path:string,bytes:Uint8Array)=>{writes++;if(objects.has(path))return {error:{message:"exists"}};objects.set(path,bytes.slice());return {data:{path},error:null};},
    download:(path:string)=>objects.has(path)?{data:new Blob([new Uint8Array(objects.get(path)!).buffer]),error:null}:{data:null,error:{message:"missing"}},
  })};
  return {objects,writes:()=>writes};
}
Deno.test("office confirmation records the actual written reference once and cannot impersonate the operator", async () => {
  const db=new Memory();seedSplit(db,"open");const client=db.client();const body=confirmationBody();
  const result=await recordOfficeClientConfirmation(client,trade(USER_A,true),{...body,captured_by:USER_B,captured_by_actor:"forged"});
  const rows=db.rows("job_client_signoffs");assertEquals(rows.length,1);assertEquals(rows[0].captured_by,USER_A);
  assertEquals(rows[0].captured_by_actor,"user:"+USER_A);assertEquals(rows[0].confirmation_reference,body.confirmation_reference);
  assertEquals(hasOfficeClientConfirmation(rows[0]),true);assertEquals(rows[0].signed_copy_path,null);
  const replay=await recordOfficeClientConfirmation(client,trade(USER_A,true),body);
  assertEquals(replay.signoff_id,result.signoff_id);assertEquals(replay.already_recorded,true);assertEquals(rows.length,1);
  const changed=await assertRejects(()=>recordOfficeClientConfirmation(client,trade(USER_A,true),{...body,work_done:"Different work"}),ClientSignoffFormError);
  assertEquals(changed.code,"client_signoff_request_changed");assertEquals(rows.length,1);
  const other=await assertRejects(()=>recordOfficeClientConfirmation(client,trade(USER_B,true),body),ClientSignoffFormError);
  assertEquals(other.code,"client_signoff_request_changed");assertEquals(rows.length,1);
});
Deno.test("a signed copy stays private, is reconciled by exact bytes, and is verified again on read", async () => {
  const db=new Memory();seedSplit(db,"open");const client=db.client();const storage=copyStorage(client);
  const bytes=new TextEncoder().encode("%PDF-1.7\nfixture signed copy");
  const body={...confirmationBody("signed_copy"),file_base64:encodeBase64(bytes),file_name:"signed-form.pdf"};
  const record=await recordOfficeClientConfirmation(client,trade(USER_A,true),body);
  assertEquals(storage.writes(),1);assertEquals(db.rows("job_client_signoffs").length,1);
  await recordOfficeClientConfirmation(client,trade(USER_A,true),body);assertEquals(storage.writes(),1);
  const file=await readOfficeClientSignedCopy(client,trade(USER_A,true),JOB,String(record.signoff_id));
  assertEquals(file.file_base64,body.file_base64);assertEquals(file.content_type,"application/pdf");
  const row=db.rows("job_client_signoffs")[0];storage.objects.set(String(row.signed_copy_path),new Uint8Array([1,2,3]));
  const drift=await assertRejects(()=>readOfficeClientSignedCopy(client,trade(USER_A,true),JOB,String(record.signoff_id)),ClientSignoffFormError);
  assertEquals(drift.code,"client_signoff_copy_changed");
});
Deno.test("office confirmation refuses missing evidence, anonymous operators, other organisations and frozen groups", async () => {
  const db=new Memory();seedSplit(db,"open");const body=confirmationBody();
  await assertRejects(()=>recordOfficeClientConfirmation(db.client(),{userId:"",orgId:ORG,isStaff:true},body),ClientSignoffFormError);
  await assertRejects(()=>recordOfficeClientConfirmation(db.client(),trade(USER_A),body),ClientSignoffFormError);
  await assertRejects(()=>recordOfficeClientConfirmation(db.client(),{...trade(USER_A,true),orgId:OTHER_JOB},body),ClientSignoffFormError);
  await assertRejects(()=>recordOfficeClientConfirmation(db.client(),trade(USER_A,true),{...body,current_client_confirmation:false}),ClientSignoffFormError);
  await assertRejects(()=>recordOfficeClientConfirmation(db.client(),trade(USER_A,true),{...body,confirmation_reference:""}),ClientSignoffFormError);
  assertThrows(()=>decodeClientSignedCopy(encodeBase64(new TextEncoder().encode("<svg>not a signed image</svg>"))),ClientSignoffFormError);
  db.rows("group_work_orders")[0].split_frozen_at="2026-10-22T00:00:00Z";
  const frozen=await assertRejects(()=>recordOfficeClientConfirmation(db.client(),trade(USER_A,true),body),ClientSignoffFormError);
  assertEquals(frozen.code,"client_signoff_split_frozen");assertEquals(db.rows("job_client_signoffs").length,0);
});
Deno.test("a group cannot end before current client confirmation, and a real on-site capture is considered before completion", async () => {
  const db=new Memory();seedSplit(db,"open");
  const refusal=await assertRejects(()=>assertGroupClientConfirmationBeforeCompletion(db.client(),JOB),GroupWorkOrderError);
  assertEquals(refusal.code,"group_client_signoff_required");
  let captured=0;
  const result=await assertGroupClientConfirmationBeforeCompletion(db.client(),JOB,async()=>{
    captured++;db.rows("job_client_signoffs").push({id:"client",job_id:JOB,method:"on_site",signature_media_id:"signature",happy:true,created_at:"2026-10-26T00:00:00Z"});return {recorded:true};
  });
  assertEquals(captured,1);assertEquals(result.grouped,true);
  assertEquals(db.calls.some(c=>c.table==="jobs"&&c.op==="update"),false);
  db.rows("group_work_orders")[0].signoff_required_after="2026-10-27T00:00:00Z";
  await assertRejects(()=>assertGroupClientConfirmationBeforeCompletion(db.client(),JOB),GroupWorkOrderError);
});

Deno.test("public client form keeps the work, date and outstanding items and does not turn rejection into acceptance",async()=>{
 const m=new Memory();seedSplit(m,"open");
 const body={share_token:"tok-secret",signer_name:"Invented Client",signature_png:"data:image/png;base64,iVBORw0KGgo=",form_version:"client-confirmation-v1",client_confirmed_on:"2026-11-06",work_done:"Installed agreed work",outstanding_items:"Finish still needs attention",happy:false};
 const result=await clientSignGroupWorkOrder(m.client(),body);assertEquals(result.client_signed,false);
 const row=m.rows("job_client_signoffs")[0];assertEquals([row.work_done,row.client_confirmed_on,row.outstanding_items,row.happy],[body.work_done,body.client_confirmed_on,body.outstanding_items,false]);
 assertEquals(m.rows("jobs")[0].status,"scheduled");
 await assertRejects(()=>clientSignGroupWorkOrder(m.client(),{...body,work_done:""}),GroupWorkOrderError,"Enter the work completed");
});

Deno.test("office cannot present an older client confirmation as fresh after reopening",async()=>{
 const m=new Memory();seedSplit(m,"open");
 m.rows("group_work_orders")[0].signoff_required_after="2026-11-06T05:00:00Z";
 const body={...confirmationBody(),client_confirmed_on:"2026-11-05"};
 await assertRejects(()=>recordOfficeClientConfirmation(m.client(),{isStaff:true,userId:USER_A,orgId:ORG},body),ClientSignoffFormError,"client must confirm again");
 assertEquals(m.rows("job_client_signoffs").length,0);
 m.rows("job_client_signoffs").push({id:"old-confirmation",job_id:JOB,org_id:ORG,method:"office_on_behalf",signed_name:"Invented Client",happy:true,client_confirmed_on:"2026-11-05",work_done:"Agreed work",captured_by:USER_A,captured_by_actor:"user:"+USER_A,capture_auth_source:"jwt",confirmation_kind:"written_confirmation",confirmation_reference:"An earlier client email",created_at:"2026-11-06T06:00:00Z"});
 assertEquals((await readGroupWorkOrderOffice(m.client(),trade(USER_A,true),{group_id:GROUP})).client_signed,false);
});

Deno.test("a new on-site client rejection takes precedence over an earlier counting sign-off",async()=>{
 const m=new Memory();seedSplit(m,"open");
 m.rows("job_client_signoffs").push({id:"earlier-acceptance",job_id:JOB,method:"on_site",happy:true,signature_media_id:"old-signature",created_at:"2026-11-06T05:00:00Z"});
 let recorded=0;
 await assertRejects(()=>assertGroupClientConfirmationBeforeCompletion(m.client(),JOB,async()=>{
  recorded++;m.rows("job_client_signoffs").push({id:"new-rejection",job_id:JOB,method:"on_site",happy:false,signature_media_id:"new-signature",created_at:"2026-11-06T06:00:00Z"});return {recorded:true,counts:false};
 }),GroupWorkOrderError,"client must sign off the current work");
 assertEquals(recorded,1);assertEquals(m.rows("jobs")[0].status,"scheduled");
});

Deno.test("group-required patio completion cannot escape client confirmation while group setup is missing",async()=>{
 const db=new Memory();seedSplit(db,"open");
 db.rows("jobs")[0].type="patio";
 db.rows("feature_flags").push({flag_name:PATIO_PAY_GROUP_ONLY_FLAG,enabled:true});
 db.rows("group_work_orders")[0].job_id=OTHER_JOB;
 db.rows("jobs").push({id:OTHER_JOB,org_id:ORG,type:"patio",status:"scheduled"});
 db.rows("job_assignments").push({id:"anchor-allocation",job_id:OTHER_JOB,user_id:USER_A,scheduled_date:"2026-10-19",status:"scheduled",is_ghost:false});
 const refusal=await assertRejects(()=>assertGroupClientConfirmationBeforeCompletion(db.client(),JOB),GroupWorkOrderError);
 assertEquals(refusal.code,"group_client_signoff_required");
 assertEquals(db.rows("jobs")[0].status,"scheduled");
 db.rows("job_client_signoffs").push({id:"client-confirmation",job_id:JOB,method:"on_site",happy:true,signature_media_id:"signature",created_at:"2026-10-26T00:00:00Z"});
 const result=await assertGroupClientConfirmationBeforeCompletion(db.client(),JOB);
 assertEquals(result.grouped,false);assertEquals(result.requiresConfirmation,true);
 assertEquals(db.rows("group_work_orders").some(g=>g.job_id===JOB),false,"the guard must not create a group");
});
Deno.test("ordinary patio work with genuine pre-group pay and scheduling keeps its existing completion policy",async()=>{
 const db=new Memory();seedSplit(db,"open");db.rows("jobs")[0].type="patio";
 db.rows("feature_flags").push({flag_name:PATIO_PAY_GROUP_ONLY_FLAG,enabled:true});
 db.rows("group_work_orders")[0].job_id=OTHER_JOB;db.rows("jobs").push({id:OTHER_JOB,org_id:ORG,type:"patio",status:"scheduled"});
 for(const a of db.rows("job_assignments"))if(a.job_id===JOB)a.scheduled_date="2026-10-18";
 db.rows("job_assignments").push({id:"anchor-allocation",job_id:OTHER_JOB,user_id:USER_A,scheduled_date:"2026-10-19",status:"scheduled",is_ghost:false});
 db.rows("trade_invoices").push({id:"legacy-invoice",status:"paid"});
 db.rows("trade_invoice_lines").push({job_id:JOB,trade_invoice_id:"legacy-invoice",line_type:"labour",source_work_order_id:WO,trade_invoices:{status:"paid"}});
 const result=await assertGroupClientConfirmationBeforeCompletion(db.client(),JOB);
 assertEquals(result.requiresConfirmation,false);assertEquals(result.grouped,false);
});

// ---- Own hours, any day, no crew approval (owner, 6 Nov 2026) ----

Deno.test("a full-super crew freezes with no crew approval, and logged hours read as confirmed", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-20", hours: 2 },
  );
  assert(db.rows("group_work_order_participants").every((row) => !row.crew_signed_at));
  const read: any = (await readMyGroupWorkOrders(db.client(), trade(USER_A))).groups[0];
  assertEquals(read.crew_approval_required, false);
  assertEquals(read.my_hours_approved, true);
  assert((read.crew_hours as any[]).every((row) => row.approved === true));

  // Full super used to wait for every crew member to approve. It no longer does.
  db.rows("group_work_orders")[0].pay_basis = "all_in_12_v2";
  const share = await readGroupWorkOrderMyShare(db.client(), trade(USER_A), { group_id: GROUP });
  assertEquals(share.awaiting, "ready");
  await freezeGroupWorkOrder(db.client(), trade(USER_A), { group_id: GROUP }).catch((err) => {
    // Only the pay read after the freeze is outside this fake; the freeze itself ran.
    if (!(err instanceof GroupWorkOrderError) || err.code === "group_crew_approval_required") throw err;
  });
  assert(db.rows("group_work_orders")[0].split_frozen_at, "the split froze without any crew approval");
});

Deno.test("hours on a day nobody was booked count, for the share and the freeze", async () => {
  const db = new Memory();
  seedSplit(db);
  // Both booked for 20 October only; the work ran on to the 21st and 22nd.
  db.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-21", hours: 6 },
    { group_id: GROUP, user_id: USER_B, work_date: "2026-10-22", hours: 3 },
  );
  const share = await readGroupWorkOrderMyShare(db.client(), trade(USER_B), { group_id: GROUP });
  assertEquals(share.awaiting, "ready");
  const line = await resolveGroupShareInvoiceExtra(db.client(), { userId: USER_B, item: { type: "group share", group_id: GROUP } });
  assert(Number(line?.unit_rate) > 0);
  await freezeGroupWorkOrder(db.client(), trade(USER_A), { group_id: GROUP });
  const hours = new Map(db.rows("group_work_order_shares").map((row) => [String(row.user_id), Number(row.hours)]));
  assertEquals(hours.get(USER_A), 6);
  assertEquals(hours.get(USER_B), 3);
});

Deno.test("an admin watching allocation cannot block share readiness; an office installer still can", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("users").push({ id: USER_C, role: "admin" });
  db.rows("job_assignments").push({
    id: "watch",
    job_id: JOB,
    user_id: USER_C,
    scheduled_date: "2026-10-20",
    status: "scheduled",
    is_ghost: false,
  });
  const read = () =>
    readGroupWorkOrderOffice(db.client(), trade(USER_A, true), {
      group_id: GROUP,
    });
  assertEquals((await read()).needs_hours, [USER_A, USER_B]);
  db.rows("users")[0].role = "ops_manager";
  assertEquals((await read()).needs_hours, [USER_A, USER_B, USER_C]);
  db.rows("users")[0].role = "admin";
  db.rows("job_assignments").at(-1)!.status = "cancelled";
  db.rows("group_work_order_participants").push({
    group_id: GROUP,
    user_id: USER_C,
  });
  assertEquals(
    (await read()).needs_hours,
    [USER_A, USER_B, USER_C],
    "explicit membership is retained for office reconciliation",
  );
  assertEquals(db.rows("group_work_order_shares"), []);
  assertEquals(db.rows("group_work_orders")[0].split_frozen_at ?? null, null);
});

Deno.test("canonical crew RPC pages every person and refuses incomplete or foreign replies", async () => {
  const people = Array.from(
    { length: 501 },
    (_, n) => ({
      job_id: JOB,
      user_id: `fixture-${String(n).padStart(4, "0")}`,
    }),
  );
  const pages: number[] = [];
  const client = {
    rpc: () => {
      let start = 0, end = 0;
      const q: any = {
        order: () => q,
        range: (a: number, b: number) => {
          start = a;
          end = b;
          return q;
        },
        then: (resolve: any) => {
          pages.push(start);
          return Promise.resolve({
            data: people.slice(start, end + 1),
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  assertEquals(
    (await readGroupWorkOrderCrew(client, [JOB])).get(JOB)?.length,
    501,
  );
  assertEquals(pages, [0, 500]);
  for (
    const reply of [{ data: null, error: null }, {
      data: [],
      error: { message: "missing function" },
    }, { data: [{ job_id: OTHER_JOB, user_id: USER_A }], error: null }]
  ) {
    const bad = {
      rpc: () => {
        const q: any = {
          order: () => q,
          range: () => q,
          then: (resolve: any) => Promise.resolve(reply).then(resolve),
        };
        return q;
      },
    };
    const error = await assertRejects(
      () => readGroupWorkOrderCrew(bad, [JOB]),
      GroupWorkOrderError,
    );
    assertEquals(error.code, "group_crew_unreadable");
    assertEquals(error.status, 503);
  }
});

/** A third crew member already paid ordinary hourly pay on the job: the
 * invoice reached Xero as a live bill. Pass a claim to seed one not billed. */
function seedPaidByHours(
  db: Memory,
  grossEx: number,
  invoice: Record<string, unknown> = { status: "pushed_to_xero", xero_bill_id: "BILL-C", xero_bill_status: "AUTHORISED" },
) {
  db.rows("job_assignments").push({
    job_id: JOB, user_id: USER_C, scheduled_date: "2026-10-20", status: "scheduled", role: "installer",
  });
  db.rows("trade_invoices").push({ id: INV, user_id: USER_C, ...invoice });
  db.rows("trade_invoice_lines").push({
    job_id: JOB, trade_invoice_id: INV, line_type: "labour", line_total_ex: grossEx,
    group_share_id: null, source_work_order_id: null,
    // This fake does not join tables; the live read embeds the invoice.
    trade_invoices: { user_id: USER_C, ...invoice },
  });
}

Deno.test("paid by the hour: the rest of the crew still get a group; the paid member cannot open or join it", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("group_work_orders").splice(0);
  db.rows("group_work_order_participants").splice(0);
  seedPaidByHours(db, 100);
  const paidOpen = await createGroupWorkOrder(db.client(), trade(USER_C), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(paidOpen?.code, "group_member_paid_by_hours");
  assertEquals(paidOpen?.status, 409);
  assertEquals(db.rows("group_work_orders").length, 0);

  const opened = await createGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
  assertEquals(opened.ok, true);
  const group = db.rows("group_work_orders")[0];
  const paidJoin = await joinGroupWorkOrder(db.client(), trade(USER_C), { group_id: group.id })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(paidJoin?.code, "group_member_paid_by_hours");
  assertEquals(db.rows("group_work_order_participants").map((row) => row.user_id), [USER_A]);
  const read = await readTradeGroupWorkOrder(db.client(), trade(USER_C), { job_id: JOB });
  assertEquals(read.discovery?.reason, "paid_by_hours");

  // A work-order claim on the job still stops a group being opened.
  const blocked = new Memory();
  seedSplit(blocked);
  blocked.rows("group_work_orders").splice(0);
  seedPaidByHours(blocked, 100);
  blocked.rows("trade_invoice_lines")[0].line_type = "work order";
  const refused = await createGroupWorkOrder(blocked.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(refused?.code, "group_open_blocked_by_work_order_claim");
});

Deno.test("paid by the hour: a claim not billed in Xero is not paid; it holds the group, named, and stays the person's own", async () => {
  const unbilled: Record<string, unknown>[] = [
    { status: "draft", xero_bill_id: null, xero_bill_status: null },
    { status: "pending_acknowledgment", xero_bill_id: null, xero_bill_status: null },
    { status: "pushed_to_xero", xero_bill_id: "BILL-C", xero_bill_status: null },
    { status: "pushed_to_xero", xero_bill_id: "BILL-C", xero_bill_status: "VOIDED" },
    { status: "approved", xero_bill_id: "BILL-C", xero_bill_status: "DELETED" },
    { status: "pushed_to_xero", xero_bill_id: "BILL-C", xero_bill_status: "DRAFT" },
  ];
  for (const invoice of unbilled) {
    const db = new Memory();
    seedSplit(db);
    db.rows("group_work_orders").splice(0);
    db.rows("group_work_order_participants").splice(0);
    db.rows("users").push({ id: USER_C, name: "Crew C", role: "crew", org_id: ORG });
    seedPaidByHours(db, 100, invoice);
    // Not paid: nothing is taken off the pot and they are not left out.
    assertEquals((await readHoursPaidUserIds(db.client(), JOB)).size, 0);
    const refused = await createGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB })
      .then(() => null, (err) => err as GroupWorkOrderError);
    assertEquals(refused?.code, "group_open_blocked_by_hours_claim", String(invoice.status));
    assertEquals(refused?.status, 409);
    assertStringIncludes(refused?.message || "", "Crew C");
    // A saved draft is named as a draft with how to clear it (fix 4, F3).
    assertStringIncludes(refused?.message || "", invoice.status === "draft" ? "saved draft invoice" : "withdrawn");
    assertEquals(db.rows("group_work_orders").length, 0);
    const read = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
    assertEquals(read.discovery?.reason, "hours_claim_unresolved");
    // With no group the person's own ordinary hours are not refused.
    await assertGroupJobDraftUsesShare(db.client(), [{ job_id: JOB, line_type: "labour" }]);
  }

  // A live group whose paid member's bill was voided afterwards: the freeze
  // waits, named, and writes no share.
  const voided = new Memory();
  seedSplit(voided);
  voided.rows("users").push({ id: USER_C, name: "Crew C", role: "crew", org_id: ORG });
  seedPaidByHours(voided, 100, { status: "pushed_to_xero", xero_bill_id: "BILL-C", xero_bill_status: "VOIDED" });
  voided.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 6 },
  );
  const held = await freezeGroupWorkOrder(voided.client(), trade(USER_A), { group_id: GROUP })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(held?.code, "group_hours_claim_unresolved");
  assertStringIncludes(held?.message || "", "Crew C");
  assertEquals(voided.rows("group_work_order_shares").length, 0);

  // Withdrawn (ops-reject): no claim at all, so the group opens and the
  // person is ordinary crew again.
  const withdrawn = new Memory();
  seedSplit(withdrawn);
  withdrawn.rows("group_work_orders").splice(0);
  withdrawn.rows("group_work_order_participants").splice(0);
  seedPaidByHours(withdrawn, 100, { status: "ops-reject", xero_bill_id: null, xero_bill_status: null });
  const opened = await createGroupWorkOrder(withdrawn.client(), trade(USER_A), { job_id: JOB });
  assertEquals(opened.ok, true);
  assertEquals((await readHoursPaidUserIds(withdrawn.client(), JOB)).size, 0);
});

Deno.test("paid by the hour: the work order drops by that pay and the rest is split by hours", async () => {
  for (const [basis, deducted] of [["all_in_12_v2", 112], ["gross_v1", 100]] as const) {
    const db = new Memory();
    seedSplit(db);
    db.rows("group_work_orders")[0].pay_basis = basis;
    seedPaidByHours(db, 100);
    // An old participant row for the paid member: their hours never count.
    db.rows("group_work_order_participants").push({ id: "p-c", group_id: GROUP, user_id: USER_C });
    db.rows("group_work_order_time_entries").push(
      { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 6 },
      { group_id: GROUP, user_id: USER_B, work_date: "2026-10-21", hours: 2 },
      { group_id: GROUP, user_id: USER_C, work_date: "2026-10-20", hours: 8 },
    );
    await freezeGroupWorkOrder(db.client(), trade(USER_A), { group_id: GROUP }).catch((err) => {
      if (!(err instanceof GroupWorkOrderError) || err.code === "group_pot_used_by_hours_pay") throw err;
    });
    const shares = db.rows("group_work_order_shares");
    assertEquals(shares.map((row) => row.user_id).sort(), [USER_A, USER_B]);
    const pot = moneyToCents(482.15)! - deducted * 100;
    assertEquals(shares.reduce((sum, row) => sum + moneyToCents(row.share_ex)!, 0), pot);
    const byUser = new Map(shares.map((row) => [String(row.user_id), moneyToCents(row.share_ex)!]));
    // The rest is split the usual way (hours at each person's rate), 6 hours to 2.
    assert(byUser.get(USER_A)! > byUser.get(USER_B)! * 3);
  }

  // Paid more than the work order: no group pay to split, said plainly.
  const over = new Memory();
  seedSplit(over);
  over.rows("group_work_orders")[0].pay_basis = "all_in_12_v2";
  seedPaidByHours(over, 500);
  over.rows("group_work_order_time_entries").push(
    { group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 2 },
  );
  const used = await freezeGroupWorkOrder(over.client(), trade(USER_A), { group_id: GROUP })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(used?.code, "group_pot_used_by_hours_pay");
  assertEquals(used?.status, 409);
  assertEquals(over.rows("group_work_orders")[0].split_frozen_at, undefined);
});


// ---- Fix round 4 (6 Nov 2026): office removal, own drafts, card notes, on-site not happy ----

Deno.test("office removal: the trade cannot rejoin, is not offered Join, and only the office puts them back", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  db.rows("job_assignments").push({
    job_id: JOB, user_id: USER_C, scheduled_date: "2026-10-21", status: "scheduled", role: "installer",
  });
  db.rows("users").push(
    { id: USER_A, name: "Crew A", role: "crew", org_id: ORG },
    { id: USER_C, name: "Crew C", role: "crew", org_id: ORG },
    { id: "office-1", name: "Office", role: "ops_manager", org_id: ORG },
  );
  await joinGroupWorkOrder(db.client(), trade(USER_C), { group_id: GROUP });
  assert(db.rows("group_work_order_participants").some((r) => r.user_id === USER_C));
  await removeGroupWorkOrderParticipant(db.client(), trade("office-1", true), { group_id: GROUP, user_id: USER_C });
  assertEquals(db.rows("group_work_order_participants").some((r) => r.user_id === USER_C), false);

  // One tap on Join does not put them back.
  const join = await joinGroupWorkOrder(db.client(), trade(USER_C), { group_id: GROUP })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(join?.code, "group_member_removed_by_office");
  assertEquals(join?.status, 409);
  assertStringIncludes(join?.message || "", "The office removed you");
  assertStringIncludes(join?.message || "", "Ask the office");
  // Nor does opening the job's group again, by job.
  const create = await createGroupWorkOrder(db.client(), trade(USER_C), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(create?.code, "group_member_removed_by_office");
  assertEquals(db.rows("group_work_order_participants").some((r) => r.user_id === USER_C), false);

  // Discovery no longer offers Join, on the job page or the weekly invoice.
  const page = await readTradeGroupWorkOrder(db.client(), trade(USER_C), { job_id: JOB });
  assertEquals(page.discovery?.state, "setup_required");
  assertEquals(page.discovery?.reason, "removed_by_office");
  const mine = await readMyGroupWorkOrders(db.client(), trade(USER_C));
  assertEquals(mine.groups.length, 1);
  assertEquals(mine.groups[0].awaiting, "awaiting_office");
  assertEquals(mine.groups[0].discovery?.reason, "removed_by_office");
  // Someone else on the job still sees Join as before.
  db.rows("group_work_order_participants").splice(
    db.rows("group_work_order_participants").findIndex((r) => r.user_id === USER_B), 1,
  );
  assertEquals((await readTradeGroupWorkOrder(db.client(), trade(USER_B), { job_id: JOB })).discovery, { state: "join" });

  // The office's agent door leaves them off too, and says so.
  const agent = await agentCreateGroupWorkOrder(db.client(), {
    job_id: JOB, requested_by_user_id: "office-1", crew_user_ids: [USER_A, USER_C],
  });
  assertEquals(agent.crew.find((c) => c.user_id === USER_C)?.removed_by_office, true);
  assertEquals(agent.crew.find((c) => c.user_id === USER_C)?.added, false);
  assertStringIncludes(agent.note, "removed from this group by the office");
  assertEquals(db.rows("group_work_order_participants").some((r) => r.user_id === USER_C), false);

  // Only the office's restore puts them back; then they are a member.
  await restoreGroupWorkOrderParticipant(db.client(), trade("office-1", true), { group_id: GROUP, user_id: USER_C });
  assert(db.rows("group_work_order_participants").some((r) => r.user_id === USER_C));
  assertEquals((await joinGroupWorkOrder(db.client(), trade(USER_C), { group_id: GROUP })).ok, true);
  assertEquals(db.rows("group_work_order_participants").filter((r) => r.user_id === USER_C).length, 1);
  assertEquals((await readTradeGroupWorkOrder(db.client(), trade(USER_C), { job_id: JOB })).discovery?.state, "member");
});

function seedHoursClaim(db: Memory, userId: string, invoiceId: string, invoice: Record<string, unknown>) {
  const row = { id: invoiceId, user_id: userId, ...invoice };
  db.rows("trade_invoices").push(row);
  db.rows("trade_invoice_lines").push({
    job_id: JOB, trade_invoice_id: invoiceId, line_type: "labour", line_total_ex: 90,
    group_share_id: null, source_work_order_id: null,
    // The live route read embeds the invoice; this fake does not join.
    trade_invoices: row,
  });
}

Deno.test("group setup on a job the customer has not accepted is refused by name (RQ-19.a)", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("group_work_orders").splice(0);
  db.rows("group_work_order_participants").splice(0);
  db.rows("users").push({ id: USER_A, name: "Crew A", role: "crew", org_id: ORG });
  db.insertFault.set(
    "group_work_orders",
    "group_job_not_accepted: the job is quoted, so no crew group opens before the customer accepts",
  );
  const refused = await createGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals([refused?.status, refused?.code], [409, "group_job_not_accepted"]);
  assertStringIncludes(refused?.message || "", "has not accepted this job yet");
  assertEquals(db.rows("group_work_orders").length, 0);
});

Deno.test("own saved draft: group setup names the week and how to clear it, and the draft clears it", async () => {
  const db = new Memory();
  seedSplit(db);
  db.rows("group_work_orders").splice(0);
  db.rows("group_work_order_participants").splice(0);
  db.rows("users").push({ id: USER_A, name: "Crew A", role: "crew", org_id: ORG });
  seedHoursClaim(db, USER_A, INV, { status: "draft", week_start: "2026-11-02", xero_bill_id: null, xero_bill_status: null });

  const refused = await createGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(refused?.code, "group_open_blocked_by_hours_claim");
  assertEquals(refused?.status, 409);
  assertStringIncludes(refused?.message || "", "Your saved draft invoice for the week starting Monday 2 November has hours on this job");
  assertStringIncludes(refused?.message || "", "take this job off it");
  assertStringIncludes(refused?.message || "", "delete the draft");
  assertEquals((refused?.message || "").includes("Someone"), false);
  assertEquals(db.rows("group_work_orders").length, 0);

  // The weekly invoice and job page say the same, with the draft to open.
  const page = await readTradeGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB });
  assertEquals(page.discovery?.reason, "hours_claim_unresolved");
  assertEquals(page.discovery?.own_draft, { invoice_id: INV, week_start: "2026-11-02" });
  assertStringIncludes(page.discovery?.message || "", "Monday 2 November");
  // Another crew member is told someone holds it, never the draft's details.
  const other = await readTradeGroupWorkOrder(db.client(), trade(USER_B), { job_id: JOB });
  assertEquals(other.discovery?.reason, "hours_claim_unresolved");
  assertEquals(other.discovery?.own_draft, undefined);
  // Named to the rest of the crew as a draft, with what clears it.
  const forB = await createGroupWorkOrder(db.client(), trade(USER_B), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertStringIncludes(forB?.message || "", "Crew A has a saved draft invoice for the week starting Monday 2 November");

  // Saved again without the job (or deleted): the group opens.
  db.rows("trade_invoice_lines").splice(0);
  assertEquals((await createGroupWorkOrder(db.client(), trade(USER_A), { job_id: JOB })).ok, true);
});

Deno.test("regression: a submitted, approved or unbilled hours line still blocks group setup; billed hours still keep their payee off", async () => {
  for (const invoice of [
    { status: "pending_acknowledgment", xero_bill_id: null, xero_bill_status: null },
    { status: "approved", xero_bill_id: null, xero_bill_status: null },
    { status: "pushed_to_xero", xero_bill_id: "BILL-1", xero_bill_status: null },
  ]) {
    const db = new Memory();
    seedSplit(db);
    db.rows("group_work_orders").splice(0);
    db.rows("group_work_order_participants").splice(0);
    seedHoursClaim(db, USER_A, INV, { ...invoice, week_start: "2026-11-02" });
    for (const caller of [USER_A, USER_B]) {
      const refused = await createGroupWorkOrder(db.client(), trade(caller), { job_id: JOB })
        .then(() => null, (err) => err as GroupWorkOrderError);
      assertEquals(refused?.code, "group_open_blocked_by_hours_claim", `${invoice.status} ${caller}`);
      assertStringIncludes(refused?.message || "", "not billed in Xero yet");
      assertEquals((refused?.message || "").includes("saved draft"), false);
      const page = await readTradeGroupWorkOrder(db.client(), trade(caller), { job_id: JOB });
      assertEquals(page.discovery?.own_draft, undefined);
    }
    assertEquals(db.rows("group_work_orders").length, 0);
  }

  // Own draft plus a submitted claim: both are named, and it still blocks.
  const mixed = new Memory();
  seedSplit(mixed);
  mixed.rows("group_work_orders").splice(0);
  mixed.rows("group_work_order_participants").splice(0);
  mixed.rows("users").push({ id: USER_B, name: "Crew B", role: "crew", org_id: ORG });
  seedHoursClaim(mixed, USER_A, INV, { status: "draft", week_start: "2026-11-02" });
  seedHoursClaim(mixed, USER_B, "60000000-0000-4000-8000-000000000002", { status: "pending_acknowledgment", week_start: "2026-10-26" });
  const both = await createGroupWorkOrder(mixed.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(both?.code, "group_open_blocked_by_hours_claim");
  assertStringIncludes(both?.message || "", "Crew B has an hours invoice on this job that is not billed in Xero yet");
  assertStringIncludes(both?.message || "", "Your saved draft invoice for the week starting Monday 2 November");
  const mixedPage = await readTradeGroupWorkOrder(mixed.client(), trade(USER_A), { job_id: JOB });
  assertEquals(mixedPage.discovery?.own_draft, undefined, "a submitted claim is not the caller's draft to clear");

  // Billed hours: the payee still cannot open or join; the freeze still names an own draft.
  const billed = new Memory();
  seedSplit(billed);
  billed.rows("group_work_orders").splice(0);
  billed.rows("group_work_order_participants").splice(0);
  seedHoursClaim(billed, USER_A, INV, { status: "pushed_to_xero", xero_bill_id: "BILL-1", xero_bill_status: "AUTHORISED" });
  const paid = await createGroupWorkOrder(billed.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(paid?.code, "group_member_paid_by_hours");

  const freeze = new Memory();
  seedSplit(freeze);
  freeze.rows("group_work_order_time_entries").push({ group_id: GROUP, user_id: USER_A, work_date: "2026-10-20", hours: 6 });
  seedHoursClaim(freeze, USER_A, INV, { status: "draft", week_start: "2026-11-02" });
  const held = await freezeGroupWorkOrder(freeze.client(), trade(USER_A), { group_id: GROUP })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(held?.code, "group_hours_claim_unresolved");
  assertStringIncludes(held?.message || "", "Your saved draft invoice for the week starting Monday 2 November");
  assertStringIncludes(held?.message || "", "be finalised");
  assertEquals(freeze.rows("group_work_order_shares").length, 0);
});

Deno.test("week start words read a Monday plainly and refuse what is not a date", () => {
  assertEquals(weekStartWords("2026-11-02"), "Monday 2 November");
  assertEquals(weekStartWords("2026-10-26T00:00:00Z"), "Monday 26 October");
  assertEquals(weekStartWords(""), null);
  assertEquals(weekStartWords("not a day"), null);
});

Deno.test("weekly invoice hours cards carry no group note without a group; group jobs keep theirs", async () => {
  // Pure rule.
  const note = { state: "setup_required" as const, reason: "work_order_not_approved", message: "office" };
  assertEquals(invoiceCardRoute({ job_id: JOB, route: "hours", group_id: null, discovery: note }), { job_id: JOB, route: "hours", group_id: null });
  assertEquals(invoiceCardRoute({ job_id: JOB, route: "hours", group_id: null, discovery: { state: "create" } }).discovery, { state: "create" });
  assertEquals(invoiceCardRoute({ job_id: JOB, route: "group_setup_required", group_id: null, discovery: note }).discovery, note);
  assertEquals(invoiceCardRoute({ job_id: JOB, route: "group", group_id: GROUP, discovery: note }).discovery, note);

  // A fencing hours card whose work order is not approved: no setup note.
  const fence = new Memory();
  seedSplit(fence);
  fence.rows("group_work_orders").splice(0);
  fence.rows("group_work_order_participants").splice(0);
  fence.rows("work_orders")[0].status = "draft";
  const fenceRoutes = (await readMyGroupWorkOrders(fence.client(), trade(USER_A))).payable_routes || [];
  assertEquals(fenceRoutes.find((r) => r.job_id === JOB)?.route, "hours");
  assertEquals(fenceRoutes.find((r) => r.job_id === JOB)?.discovery, undefined);
  // The job's own group page still says why.
  assertEquals((await readTradeGroupWorkOrder(fence.client(), trade(USER_A), { job_id: JOB })).discovery?.reason, "work_order_not_approved");

  // Paid by the hour on a job with no group: no "group pay is for the rest
  // of the crew" note on the card, and the page does not speak of group pay.
  const paidNoGroup = new Memory();
  seedSplit(paidNoGroup);
  paidNoGroup.rows("group_work_orders").splice(0);
  paidNoGroup.rows("group_work_order_participants").splice(0);
  seedHoursClaim(paidNoGroup, USER_A, INV, { status: "paid", xero_bill_id: "BILL-1", xero_bill_status: "PAID" });
  const paidRoutes = (await readMyGroupWorkOrders(paidNoGroup.client(), trade(USER_A))).payable_routes || [];
  assertEquals(paidRoutes.find((r) => r.job_id === JOB)?.discovery, undefined);
  const paidPage = await readTradeGroupWorkOrder(paidNoGroup.client(), trade(USER_A), { job_id: JOB });
  assertEquals(paidPage.discovery?.reason, "paid_by_hours");
  assertEquals((paidPage.discovery?.message || "").includes("group pay is for the rest of the crew"), false);
  const paidCreate = await createGroupWorkOrder(paidNoGroup.client(), trade(USER_A), { job_id: JOB })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals((paidCreate?.message || "").includes("group pay is for the rest of the crew"), false);

  // With a group the trade is paid outside of, the note stays.
  const paidGroup = new Memory();
  seedSplit(paidGroup);
  paidGroup.rows("group_work_order_participants").splice(0);
  seedHoursClaim(paidGroup, USER_A, INV, { status: "paid", xero_bill_id: "BILL-1", xero_bill_status: "PAID" });
  const grouped = await readMyGroupWorkOrders(paidGroup.client(), trade(USER_A));
  assertStringIncludes((grouped.payable_routes || []).find((r) => r.job_id === JOB)?.discovery?.message || "", "group pay is for the rest of the crew");

  // A patio crew job that needs its group set up keeps its setup note.
  const patio = new Memory();
  seedSplit(patio);
  patio.rows("group_work_orders").splice(0);
  patio.rows("group_work_order_participants").splice(0);
  patio.rows("jobs")[0].type = "patio";
  patio.rows("work_orders")[0].status = "draft";
  patio.rows("feature_flags").push({ flag_name: PATIO_PAY_GROUP_ONLY_FLAG, enabled: true });
  const patioRoute = ((await readMyGroupWorkOrders(patio.client(), trade(USER_A))).payable_routes || []).find((r) => r.job_id === JOB);
  assertEquals(patioRoute?.route, "group_setup_required");
  assertEquals(patioRoute?.discovery?.reason, "work_order_not_approved");
});

const SIGNATURE = "data:image/png;base64,iVBORw0KGgo=";

Deno.test("on-site sign-off: not happy with a reason saves once, a retry adds nothing, and shares stay locked", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  const body = {
    group_id: GROUP, signer_name: "Invented Client", signature_png: SIGNATURE, happy: false,
    outstanding_items: "Gate latch still to fix",
    ratings: { sales_process: 5, communication: 5, cleanliness: 5, punctuality: 5, crew: 5 },
  };
  const first = await captureGroupClientSignoff(db.client(), trade(USER_A), body);
  assertEquals(first.client_signed, false);
  assertEquals(db.rows("job_client_signoffs").length, 1);
  const row = db.rows("job_client_signoffs")[0];
  assertEquals([row.method, row.happy, row.outstanding_items], ["on_site", false, "Gate latch still to fix"]);
  // Not happy: no feedback step, so nothing throws after the signature is stored.
  assertEquals(db.rows("group_work_order_feedback").length, 0);
  assertEquals(db.rows("group_work_orders")[0].status, "open");

  const retry = await captureGroupClientSignoff(db.client(), trade(USER_A), body);
  assertEquals(retry, first);
  assertEquals(db.rows("job_client_signoffs").length, 1);
  assertEquals(db.rows("job_media").filter((m) => m.phase === "signature").length, 1);

  // A different answer is a new sign-off, not a retry.
  await captureGroupClientSignoff(db.client(), trade(USER_A), { ...body, outstanding_items: "Gate latch and one paling" });
  assertEquals(db.rows("job_client_signoffs").length, 2);

  // Not happy needs a reason.
  const noReason = await captureGroupClientSignoff(db.client(), trade(USER_A), { ...body, outstanding_items: " " })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals(noReason?.code, "group_client_reason_required");
  assertEquals(noReason?.status, 400);
  assertEquals(db.rows("job_client_signoffs").length, 2);
});

Deno.test("on-site sign-off: the happy path is unchanged and a retry writes nothing new", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  const body = {
    group_id: GROUP, signer_name: "Invented Client", signature_png: SIGNATURE, happy: true,
    ratings: { sales_process: 5, communication: 5, cleanliness: 5, punctuality: 5, crew: 5 },
  };
  const signed = await captureGroupClientSignoff(db.client(), trade(USER_A), body);
  assertEquals(signed.client_signed, true);
  assertEquals(db.rows("job_client_signoffs").length, 1);
  assertEquals(db.rows("job_client_signoffs")[0].outstanding_items, null);
  assertEquals(db.rows("group_work_order_feedback").length, 1);
  assertEquals(db.rows("group_work_orders")[0].status, "client_signed");
  const again = await captureGroupClientSignoff(db.client(), trade(USER_A), body);
  assertEquals(again.client_signed, true);
  assertEquals((again as Record<string, unknown>).already_signed, true);
  assertEquals(db.rows("job_client_signoffs").length, 1);
  assertEquals(db.rows("group_work_order_feedback").length, 1);
});

Deno.test("on-site sign-off: two identical captures at the same moment leave one sign-off and one signature", async () => {
  const db = new Memory();
  seedSplit(db, "open");
  const body = {
    group_id: GROUP, signer_name: "Invented Client", signature_png: SIGNATURE, happy: false,
    outstanding_items: "Gate latch still to fix",
  };
  const [a, b] = await Promise.all([
    captureGroupClientSignoff(db.client(), trade(USER_A), body),
    captureGroupClientSignoff(db.client(), trade(USER_A), body),
  ]);
  assertEquals(db.rows("job_client_signoffs").length, 1);
  assertEquals(db.rows("job_media").filter((m) => m.phase === "signature").length, 1);
  assertEquals(a, b);
  assertEquals(a.client_signed, false);
  assertEquals(db.rows("group_work_orders")[0].status, "open");

  // The app's own capture id: two copies at once still save once.
  const withId = { ...body, outstanding_items: "Gate latch and one paling", capture_id: "7d1c2f9a-3b4e-4c5d-8e6f-0a1b2c3d4e5f" };
  const [c, d] = await Promise.all([
    captureGroupClientSignoff(db.client(), trade(USER_A), withId),
    captureGroupClientSignoff(db.client(), trade(USER_A), withId),
  ]);
  assertEquals(c, d);
  assertEquals(db.rows("job_client_signoffs").length, 2);
  assertEquals(db.rows("job_media").filter((m) => m.phase === "signature").length, 2);

  // The same capture id with different answers is refused and writes nothing.
  const reused = await captureGroupClientSignoff(db.client(), trade(USER_A), { ...withId, outstanding_items: "Something else" })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals([reused?.code, reused?.status], ["group_client_signoff_capture_reused", 409]);
  const badId = await captureGroupClientSignoff(db.client(), trade(USER_A), { ...body, capture_id: "not-a-uuid" })
    .then(() => null, (err) => err as GroupWorkOrderError);
  assertEquals([badId?.code, badId?.status], ["group_client_capture_id_invalid", 400]);
  assertEquals(db.rows("job_client_signoffs").length, 2);
  assertEquals(db.rows("job_media").filter((m) => m.phase === "signature").length, 2);
});
