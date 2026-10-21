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
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";
import {
  signatureDataUrl,
  signatureImageTag,
} from "../_shared/signature_image.ts";
import {
  allocatePotCents,
  assertGroupWorkOrderInvoiceFence,
  centsToMoney,
  clientSignGroupWorkOrder,
  createGroupWorkOrder,
  draftClientLinkMessage,
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
  refuseClientLinkSend,
  removeGroupWorkOrderParticipant,
  resolveGroupShareInvoiceExtra,
  submitGroupWorkOrderFeedback,
  unfreezeGroupWorkOrder,
  visibleShareRows,
} from "./group_work_order.ts";
import { TRADE_INVOICE_TIME_LINE_TYPES } from "./trade_invoice_time_entry.ts";

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

  runRpc(fn: string, args: Record<string, unknown>) {
    const groupId = String(args.p_group_id || "");
    const group = this.rows("group_work_orders").find((row) =>
      row.id === groupId
    );
    if (!group) throw new Error("group_work_order_not_found");
    if (fn === "unfreeze_group_work_order_split") {
      return this.unfreeze(group);
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
    return { ok: true };
  }

  latestHoursAt(jobId: string): string | null {
    const live = new Set(
      this.rows("group_work_orders").filter((row) =>
        row.job_id === jobId && row.status !== "void"
      ).map((row) => String(row.id)),
    );
    let latest: number | null = null;
    let text: string | null = null;
    for (const entry of this.rows("group_work_order_time_entries")) {
      if (!live.has(String(entry.group_id))) continue;
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
      if (!instant) continue;
      const at = Date.parse(instant);
      if (!Number.isFinite(at)) continue;
      if (latest == null || at > latest) {
        latest = at;
        text = instant;
      }
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
    if (method === "revoked" || method === "office_waiver") return false;
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
    const potCents = workOrder && workOrder.kind === "job" &&
        workOrder.status === "approved" && workOrder.sealed_content_hash
      ? moneyToCents(workOrder.agreed_labour_ex)
      : null;
    if (potCents == null || potCents <= 0) throw new Error("group_pot_missing");
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
      if (
        worked <= 0 ||
        !this.assignmentCovers(userId, String(group.job_id), workDate)
      ) {
        continue;
      }
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
    const participantIds = this.rows("group_work_order_participants").filter((
      row,
    ) => row.group_id === group.id).map((row) => String(row.user_id));
    const assigneeIds = this.rows("job_assignments").filter((row) =>
      String(row.job_id) === String(group.job_id) &&
      row.is_ghost !== true &&
      String(row.role || "").toLowerCase() !== "observer" &&
      String(row.status || "").toLowerCase() !== "cancelled"
    ).map((row) => String(row.user_id));
    const needsHours = [...new Set([...participantIds, ...assigneeIds])]
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
  private filters: { op: "eq" | "in"; col: string; value: unknown }[] = [];
  private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: unknown = null;
  private one: "none" | "maybe" | "single" = "none";

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
      if (filter.op === "eq") return row[filter.col] === filter.value;
      return (filter.value as unknown[]).includes(row[filter.col]);
    });
  }

  private run(): { data: unknown; error: { message?: string } | null } {
    this.memory.calls.push({ table: this.table, op: this.op });
    const rows = this.memory.rows(this.table);
    if (this.op === "insert") {
      const created = {
        id: crypto.randomUUID(),
        ...(this.payload as Row),
      };
      rows.push(created);
      return { data: this.one === "none" ? [created] : created, error: null };
    }
    if (this.op === "upsert") {
      const incomingRows = Array.isArray(this.payload)
        ? this.payload as Row[]
        : [this.payload as Row];
      for (const incoming of incomingRows) {
        const at = rows.findIndex((row) =>
          row.group_id === incoming.group_id && row.user_id === incoming.user_id
        );
        if (at >= 0) rows[at] = { ...rows[at], ...incoming };
        else rows.push({ id: crypto.randomUUID(), ...incoming });
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
      const kept = rows.filter((row) => !this.matches(row));
      rows.splice(0, rows.length, ...kept);
      return { data: null, error: null };
    }
    const found = rows.filter((row) => this.matches(row));
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
  assertEquals(waiting.calls.some((call) => call.op === "rpc"), false);

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
      "../../migrations/20261021141000_group_work_orders.sql",
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

Deno.test("opening a group on a job that already has normal pay is refused", async () => {
  const memory = new Memory();
  seedSplit(memory);
  memory.rows("group_work_orders").splice(0, memory.rows("group_work_orders").length);
  memory.rows("trade_invoices").push({ id: INV, status: "draft", user_id: USER_B });
  memory.rows("trade_invoice_lines").push({
    job_id: JOB,
    trade_invoice_id: INV,
    line_type: "fencing",
    group_share_id: null,
    source_work_order_id: null,
  });
  const refused = await assertRejects(
    () => createGroupWorkOrder(memory.client(), trade(USER_A, true), { job_id: JOB }),
    GroupWorkOrderError,
  );
  assertEquals(refused.code, "group_open_blocked_by_work_order_claim");
  assertEquals(refused.status, 409);
  assert(refused.message.toLowerCase().includes("already has normal pay"));
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
  assertEquals(stillAssigned.code, "group_split_needs_hours");
  assert(stillAssigned.message.includes(USER_B));
  assert(stillAssigned.message.includes(USER_C));

  for (const row of memory.rows("job_assignments")) {
    if (row.user_id === USER_B || row.user_id === USER_C) row.status = "cancelled";
  }
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

Deno.test("a group sign-off is a drawn signature after the latest hours, never a waiver", async () => {
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
