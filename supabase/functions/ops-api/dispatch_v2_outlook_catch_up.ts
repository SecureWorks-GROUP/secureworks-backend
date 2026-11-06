// deno-lint-ignore-file no-explicit-any
// Dispatch v2 (Shaun, 6 Nov 2026): the one-off catch-up for orders sent from
// Outlook before the send rule (dispatch_v2_outlook_on_send.ts) was switched
// on. Contract: docs/dispatch-v2-board-contract.md, section 3g.2.
//
// In business words:
//   * It reads every order email sent from admin@ since 5 Oct 2026 (Perth)
//     and applies the same rule as the send rule: subject, supplier, job.
//   * Only jobs still on the Dispatch board count (the board's own rule,
//     including repairs at Materials or Scheduled). Finished jobs are skipped
//     and listed.
//   * By default it is a dry run: it changes nothing and answers with every
//     order it would make (job and client, the job's stage, supplier, the
//     day sent, the lines read or "no list", the replies it would tie and
//     the stage each box would end at).
//   * The real run needs dry_run false and is for the owner only (Shaun). It
//     records the orders and boxes, ties the supplier replies already stored
//     for them, and lets the normal one-step move follow (on account: Quote
//     received, pay first: Awaiting payment). On a job that is In Progress
//     every caught-up box goes straight to Delivered.
//   * It never runs the order-confirmed step (section 3e: crew lines,
//     supplier PDFs, the order sheet), never sends anything, never moves a
//     job's stage or status, and never writes GHL, Xero or suppliers.
//   * Run it twice and nothing changes the second time: each sent email is
//     recorded once per supplier, a reply is tied only while it has no order,
//     and a box set to Delivered is not set again.

import {
  type OnSendBox,
  type OnSendEntry,
  type OnSendOrderRow,
  type OnSendStore,
  type OrderRef,
  outlookSendTieReason,
  type PlannedOrder,
  planEmails,
  recordInputFor,
  type SentEmailPlan,
  type StoredReply,
  storedRepliesToTie,
  supplierIdsFor,
  trayRowFor,
} from "./dispatch_v2_outlook_on_send.ts";
import { dayLabel, perthDay } from "./dispatch_v2_replies_rules.ts";
import {
  dispatchMaterialStageLabel,
  dispatchMaterialStageOf,
} from "./dispatch_v2_material_stage.ts";
import type { RepliesStore } from "./dispatch_v2_replies_store.ts";

export const DISPATCH_V2_OUTLOOK_CATCH_UP_ACTION =
  "dispatch_v2_outlook_catch_up";

// Who may run it for real. Shaun is the owner of Dispatch's catch-up (as of
// the Debt Workshop, the owner is named, not a role: no user has the role
// 'owner').
export const CATCH_UP_OWNERS: readonly string[] = [
  "shaun@secureworkswa.com.au",
];

// Shaun, 6 Nov 2026: about 5 Oct. Midnight 5 Oct 2026 in Perth.
export const CATCH_UP_SINCE_DEFAULT = "2026-10-04T16:00:00Z";
// Sent emails younger than this are left to the send rule.
const CATCH_UP_LAG_MS = 2 * 60_000;
const CATCH_UP_LIMIT = 3000;

export function isCatchUpOwner(email: unknown): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return !!e && CATCH_UP_OWNERS.includes(e);
}

// ── The store: one more write than the send rule ─────────────────────────

export type SetDeliveredInput = {
  org_id: string;
  box: OnSendBox;
  supplier_name: string;
  operator_email: string;
  operator_user_id: string | null;
  now: string;
};

export interface CatchUpStore extends OnSendStore {
  /** Set a box to Delivered, only while it still has the stage stamp just
   * read, with a job_events row. False when someone changed it first. */
  setBoxDelivered(input: SetDeliveredInput): Promise<boolean>;
}

/** The default: the send rule's store, plus the Delivered write. Writes the
 * box the way a person's stage press does (stage, time, who), and its
 * job_events row, but never runs anything a press would run after. */
export function postgrestCatchUpStore(
  client: any,
  base: OnSendStore,
): CatchUpStore {
  return {
    ...base,
    async setBoxDelivered(input) {
      let update = client.from("job_material_suppliers")
        .update({
          material_stage: "delivered",
          material_stage_set_at: input.now,
          material_stage_set_by_email: input.operator_email,
        })
        .eq("id", input.box.box_id)
        .eq("org_id", input.org_id);
      update = input.box.material_stage_set_at
        ? update.eq("material_stage_set_at", input.box.material_stage_set_at)
        : update.is("material_stage_set_at", null);
      const { data, error } = await update.select("id");
      if (error) {
        console.error("[dispatch_v2_outlook_catch_up] box write failed:", error);
        throw new Error("box write failed");
      }
      if (!Array.isArray(data) || data.length === 0) return false;
      const { error: eventError } = await client.from("job_events").insert({
        job_id: input.box.job_id,
        user_id: input.operator_user_id,
        event_type: "dispatch_v2_material_stage_set",
        detail_json: {
          box_id: input.box.box_id,
          supplier_id: input.box.supplier_id,
          supplier: input.supplier_name,
          from: input.box.material_stage,
          to: "delivered",
          via: "outlook_catch_up",
          operator_email: input.operator_email,
        },
      });
      if (eventError) {
        console.error(
          "[dispatch_v2_outlook_catch_up] job_events insert failed:",
          eventError,
        );
      }
      return true;
    },
  };
}

// ── The plan (what the dry run shows) ─────────────────────────────────────

export type CatchUpReply = {
  email_id: string;
  from_email: string | null;
  subject: string;
  received_at: string | null;
};

export type CatchUpOrder = {
  business_event_id: string;
  job_id: string;
  job_number: string | null;
  client_name: string | null;
  job_status: string | null;
  job_stage: string | null;
  supplier: string;
  supplier_id: string | null;
  on_account: boolean;
  to: string;
  subject: string;
  sent_at: string | null;
  sent_day: string | null;
  // The lines read from "Materials Needed:"; empty with list_read false
  // ("no list": the email's words are kept as the order).
  lines: string[];
  list_read: boolean;
  fulfilment: string;
  date_text: string | null;
  date_mode: "asap" | "date";
  delivery_date: string | null;
  address: string | null;
  // The supplier replies already stored that would be tied to this order.
  replies: CatchUpReply[];
  // The box: whether it is there already, and the stage it would show.
  box_exists: boolean;
  box_stage: string;
  box_stage_label: string;
  // delivered: In Progress job; reply: moved by a tied reply; sent: Sent to
  // supplier; kept: a person's stage set after the order stays; newer: a
  // newer order on the box decides.
  box_stage_why: "delivered" | "reply" | "sent" | "kept" | "newer";
  // Recorded by an earlier run (or the send rule): nothing new to do.
  already_recorded: boolean;
  // No Xero contact can be told for the supplier: nothing is recorded.
  no_contact: boolean;
};

export type CatchUpRefusal = {
  business_event_id: string;
  subject: string;
  sent_at: string | null;
  to: string[];
  job_number: string | null;
  client_name: string | null;
  job_stage: string | null;
  reason: string;
  reason_text: string | null;
  // Put under Emails to sort by the real run (a wrong or unknown job
  // number, or a supplier with no Xero contact). A finished job, or one not
  // on the board, is only listed.
  to_sort: boolean;
};

export type CatchUpPlan = {
  since: string;
  before: string;
  read: number;
  orders: CatchUpOrder[];
  refused: CatchUpRefusal[];
  ignored: Record<string, number>;
  // Internals the real run uses.
  _plans: SentEmailPlan[];
  _supplierIds: Map<PlannedOrder, string | null>;
  _boxes: OnSendBox[];
  _recorded: OnSendOrderRow[];
};

function at(value: string | null | undefined): number {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

function label(sentAt: string | null): string | null {
  const day = perthDay(sentAt);
  return day ? dayLabel(day) : null;
}

const TRAYED_REFUSALS = new Set(["job_number_unknown", "supplier_not_in_xero"]);

/** The orders the catch-up would make from the sent emails in [since,
 * before), and the stage each box would end at. Reads only. */
export async function planCatchUp(
  store: OnSendStore,
  orgId: string,
  window: { since: string; before: string },
): Promise<CatchUpPlan> {
  const emails = await store.sentOrderEmails({
    since: window.since,
    before: window.before,
    limit: CATCH_UP_LIMIT,
  });
  const { plans } = await planEmails(store, orgId, emails);
  const ignored: Record<string, number> = {};
  const refused: CatchUpRefusal[] = [];
  for (const p of plans) {
    if (p.verdict === "ignored") {
      ignored[p.reason!] = (ignored[p.reason!] ?? 0) + 1;
    }
    if (p.verdict === "refused" || p.unlinked.length > 0) {
      refused.push({
        business_event_id: p.email.business_event_id,
        subject: p.email.subject,
        sent_at: p.email.sent_at,
        to: p.email.to,
        job_number: p.job_number,
        client_name: p.job?.client_name ?? null,
        job_stage: p.place?.stage_label ?? p.job?.status ?? null,
        reason: p.reason ?? "supplier_not_in_xero",
        reason_text: p.verdict === "refused" ? p.reason_text : null,
        to_sort: TRAYED_REFUSALS.has(p.reason ?? "supplier_not_in_xero"),
      });
    }
  }
  const orderPlans = plans.filter((p) => p.verdict === "orders");
  const jobIds = [...new Set(orderPlans.map((p) => p.job!.job_id))];
  const [recorded, boxes, existing, replies] = jobIds.length
    ? await Promise.all([
      store.ordersFromEvents(
        orgId,
        orderPlans.map((p) => p.email.business_event_id),
      ),
      store.boxesOnJobs(orgId, jobIds),
      store.sentOrdersOnJobs(orgId, jobIds),
      store.repliesOnJobs(orgId, jobIds),
    ])
    : [[], [], [], []] as [
      OnSendOrderRow[],
      OnSendBox[],
      OnSendOrderRow[],
      StoredReply[],
    ];
  const supplierIds = await supplierIdsFor(store, orgId, orderPlans, boxes);
  const orders = buildCatchUpOrders({
    plans: orderPlans,
    supplierIds,
    recorded,
    boxes,
    existing,
    replies,
  });
  return {
    since: window.since,
    before: window.before,
    read: emails.length,
    orders,
    refused,
    ignored,
    _plans: plans,
    _supplierIds: supplierIds,
    _boxes: boxes,
    _recorded: recorded,
  };
}

/** The dry-run rows, from the plans and what is in the database. Pure. */
export function buildCatchUpOrders(input: {
  plans: SentEmailPlan[];
  supplierIds: Map<PlannedOrder, string | null>;
  recorded: OnSendOrderRow[];
  boxes: OnSendBox[];
  existing: OnSendOrderRow[];
  replies: StoredReply[];
}): CatchUpOrder[] {
  type Item = {
    plan: SentEmailPlan;
    order: PlannedOrder;
    supplierId: string | null;
    orderId: string;
    already: boolean;
  };
  const items: Item[] = [];
  for (const plan of input.plans) {
    for (const order of plan.orders) {
      const supplierId = input.supplierIds.get(order) ?? null;
      const done = input.recorded.find((r) =>
        r.source_business_event_id === plan.email.business_event_id &&
        !!r.supplier_id && order.entry.supplier_ids.includes(r.supplier_id)
      );
      items.push({
        plan,
        order,
        supplierId: done?.supplier_id ?? supplierId,
        // An order not recorded yet gets a stand-in id for the reckoning.
        orderId: done?.order_id ??
          `planned:${plan.email.business_event_id}:${order.entry.supplier_key}`,
        already: !!done,
      });
    }
  }

  // One box per job and Xero contact: work out each box once.
  const byBox = new Map<string, Item[]>();
  for (const it of items) {
    if (!it.supplierId) continue;
    const key = `${it.plan.job!.job_id}|${it.supplierId}`;
    byBox.set(key, [...(byBox.get(key) ?? []), it]);
  }
  type BoxView = {
    exists: boolean;
    stage: string;
    why: CatchUpOrder["box_stage_why"];
    ties: Map<string, StoredReply[]>;
  };
  const views = new Map<string, BoxView>();
  for (const [key, group] of byBox) {
    const [jobId, supplierId] = key.split("|");
    const entry = group[0].order.entry;
    const job = group[0].plan.job!;
    const box = input.boxes.find((b) =>
      b.job_id === jobId && b.supplier_id === supplierId
    ) ?? null;
    const ours = new Set(group.map((g) => g.orderId));
    const orders: OrderRef[] = input.existing
      .filter((o) =>
        o.job_id === jobId && o.supplier_id === supplierId &&
        !ours.has(o.order_id)
      )
      .map((o) => ({
        order_id: o.order_id,
        sent_at: o.sent_at,
        sent_conversation_id: o.sent_conversation_id,
      }));
    for (const g of group) {
      orders.push({
        order_id: g.orderId,
        sent_at: g.plan.email.sent_at,
        sent_conversation_id: g.plan.email.conversation_id,
      });
    }
    const ties = new Map<string, StoredReply[]>();
    for (
      const t of storedRepliesToTie(input.replies, {
        job_id: jobId,
        entry,
        orders,
        tieable: ours,
      })
    ) {
      ties.set(t.order.order_id, [...(ties.get(t.order.order_id) ?? []), t.reply]);
    }
    const newest = [...orders].sort((a, b) => at(b.sent_at) - at(a.sent_at))[0];
    const newestOurs = group.map((g) => at(g.plan.email.sent_at))
      .reduce((a, b) => Math.max(a, b), -Infinity);
    const setAt = at(box?.material_stage_set_at ?? null);
    const kept = !!box?.material_stage && Number.isFinite(setAt) &&
      setAt >= newestOurs;
    let stage: string;
    let why: BoxView["why"];
    if (job.status === "in_progress") {
      stage = kept ? box!.material_stage! : "delivered";
      why = kept ? "kept" : "delivered";
    } else {
      // The board's own rule, with the replies as they would be after the
      // run: those tied already and those the run ties.
      const tiedReplies = [
        ...input.replies.filter((r) =>
          r.job_id === jobId && r.state === "matched" && !!r.order_id
        ),
        ...[...ties.entries()].flatMap(([orderId, rs]) =>
          rs.map((r) => ({ ...r, order_id: orderId }))
        ),
      ].map((r) => ({
        id: r.id,
        state: r.state,
        order_id: r.order_id,
        received_at: r.received_at,
        matched_at: null,
        rung: r.rung,
      }));
      const shown = dispatchMaterialStageOf({
        stored: box?.material_stage ?? null,
        storedAt: box?.material_stage_set_at ?? null,
        sentAts: orders.map((o) => o.sent_at),
        unsentLineChanges: [],
        confirmedAt: null,
        terms: entry.on_account === true ? "on_account" : "pay_first",
        newestSent: newest
          ? { id: newest.order_id, sent_at: String(newest.sent_at) }
          : null,
        replies: tiedReplies,
      });
      stage = shown.key;
      why = shown.source === "set"
        ? "kept"
        : shown.source === "reply"
        ? "reply"
        : newest && !ours.has(newest.order_id)
        ? "newer"
        : "sent";
    }
    views.set(key, { exists: !!box, stage, why, ties });
  }

  return items.map((it) => {
    const e = it.plan.email;
    const job = it.plan.job!;
    const view = it.supplierId
      ? views.get(`${job.job_id}|${it.supplierId}`) ?? null
      : null;
    const parsed = it.order.parsed;
    return {
      business_event_id: e.business_event_id,
      job_id: job.job_id,
      job_number: job.job_number,
      client_name: job.client_name,
      job_status: job.status,
      job_stage: it.plan.place?.stage_label ?? null,
      supplier: it.order.entry.supplier_name,
      supplier_id: it.supplierId,
      on_account: it.order.entry.on_account === true,
      to: it.order.address,
      subject: e.subject,
      sent_at: e.sent_at,
      sent_day: label(e.sent_at),
      lines: parsed.lines.map((l) => l.text),
      list_read: parsed.list_read,
      fulfilment: parsed.fulfilment,
      date_text: parsed.date_text,
      date_mode: parsed.date_mode,
      delivery_date: parsed.delivery_date,
      address: parsed.address,
      replies: (view?.ties.get(it.orderId) ?? []).map((r) => ({
        email_id: r.id,
        from_email: r.from_email,
        subject: r.subject,
        received_at: r.received_at,
      })),
      box_exists: view?.exists ?? false,
      box_stage: view?.stage ?? "sent",
      box_stage_label: dispatchMaterialStageLabel(view?.stage ?? "sent"),
      box_stage_why: view?.why ?? "sent",
      already_recorded: it.already,
      no_contact: !it.supplierId,
    };
  });
}

// ── The action ────────────────────────────────────────────────────────────

export type CatchUpContext = {
  orgId: string;
  store: CatchUpStore;
  replies: RepliesStore;
  // The person running it: from the session, or operator_email with the
  // ops key. Null when neither names a user.
  operator: { email: string | null; userId: string | null };
  now?: () => string;
};

export class CatchUpRefused extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.body = { error: message, code };
  }
}

function sinceParam(value: unknown): string {
  if (value == null || value === "") return CATCH_UP_SINCE_DEFAULT;
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) {
    throw new CatchUpRefused(400, "bad_since", "since must be a date");
  }
  return new Date(t).toISOString();
}

/** POST {dry_run?: boolean (default true), since?: ISO time (default 5 Oct
 * 2026 Perth), operator_email? (ops key)}. */
export async function runDispatchV2OutlookCatchUp(
  body: any,
  ctx: CatchUpContext,
) {
  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const dryRun = body?.dry_run !== false;
  const since = sinceParam(body?.since);
  const before = new Date(Date.parse(now) - CATCH_UP_LAG_MS).toISOString();
  if (!dryRun) {
    if (!isCatchUpOwner(ctx.operator.email)) {
      throw new CatchUpRefused(
        403,
        "owner_only",
        "Only the owner (Shaun) can run the catch-up for real",
      );
    }
    if (!ctx.operator.userId) {
      throw new CatchUpRefused(
        403,
        "operator_unknown",
        "The owner's user record was not found",
      );
    }
  }
  const plan = await planCatchUp(ctx.store, ctx.orgId, { since, before });
  const summary = summarise(plan);
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      since,
      before,
      ...summary,
      orders: plan.orders,
      refused: plan.refused,
    };
  }
  const done = await applyCatchUp(plan, ctx, now);
  return {
    ok: true,
    dry_run: false,
    since,
    before,
    ...summary,
    done,
    orders: plan.orders,
    refused: plan.refused,
  };
}

function summarise(plan: CatchUpPlan) {
  const live = plan.orders.filter((o) => !o.already_recorded && !o.no_contact);
  return {
    read: plan.read,
    counts: {
      orders: plan.orders.length,
      to_record: live.length,
      already_recorded: plan.orders.filter((o) => o.already_recorded).length,
      no_contact: plan.orders.filter((o) => o.no_contact).length,
      jobs: new Set(plan.orders.map((o) => o.job_id)).size,
      to_delivered: plan.orders.filter((o) => o.box_stage_why === "delivered")
        .length,
      replies_to_tie: plan.orders.reduce((n, o) => n + o.replies.length, 0),
      refused: plan.refused.length,
      to_sort: plan.refused.filter((r) => r.to_sort).length,
      ignored: plan.ignored,
    },
  };
}

/** The real run: record, tie, set Delivered, and put the unplaceable
 * emails under Emails to sort. Each write is once only. */
async function applyCatchUp(plan: CatchUpPlan, ctx: CatchUpContext, now: string) {
  const { store, orgId } = ctx;
  const done = {
    recorded: 0,
    already_recorded: 0,
    boxes_created: 0,
    replies_tied: 0,
    set_delivered: 0,
    to_sort: 0,
    failed: [] as { business_event_id: string; supplier: string; why: string }[],
  };
  // Order id per planned order, recorded now or before.
  const orderIds = new Map<PlannedOrder, string>();
  for (const p of plan._plans) {
    if (p.verdict !== "orders") continue;
    for (const order of p.orders) {
      const before = plan._recorded.find((r) =>
        r.source_business_event_id === p.email.business_event_id &&
        !!r.supplier_id && order.entry.supplier_ids.includes(r.supplier_id)
      );
      if (before) {
        orderIds.set(order, before.order_id);
        done.already_recorded++;
        continue;
      }
      const supplierId = plan._supplierIds.get(order) ?? null;
      const input = supplierId
        ? recordInputFor(orgId, p, order, supplierId, "catch_up")
        : null;
      if (!input) {
        done.failed.push({
          business_event_id: p.email.business_event_id,
          supplier: order.entry.supplier_name,
          why: supplierId ? "email cannot be kept as an order" : "no_contact",
        });
        continue;
      }
      try {
        const r = await store.recordOrder(input);
        if (r.order_id) orderIds.set(order, r.order_id);
        if (r.recorded) done.recorded++;
        else if (r.reason === "already_recorded") done.already_recorded++;
        else {
          done.failed.push({
            business_event_id: p.email.business_event_id,
            supplier: order.entry.supplier_name,
            why: r.reason ?? "not recorded",
          });
        }
        if (r.box_created) done.boxes_created++;
      } catch (e) {
        console.error("[dispatch_v2_outlook_catch_up] record failed:", e);
        done.failed.push({
          business_event_id: p.email.business_event_id,
          supplier: order.entry.supplier_name,
          why: "write failed",
        });
      }
    }
  }

  // Fresh reads after the writes: the orders as recorded, the boxes as they
  // are now (a new box, or a stage changed meanwhile), the replies.
  const orderPlans = plan._plans.filter((p) => p.verdict === "orders");
  const jobIds = [...new Set(orderPlans.map((p) => p.job!.job_id))];
  if (jobIds.length > 0) {
    const [orders, boxes, replies] = await Promise.all([
      store.sentOrdersOnJobs(orgId, jobIds),
      store.boxesOnJobs(orgId, jobIds),
      store.repliesOnJobs(orgId, jobIds),
    ]);
    // Group by job and Xero contact, as the boxes are.
    const groups = new Map<
      string,
      { entry: OnSendEntry; jobStatus: string | null; ours: OnSendOrderRow[] }
    >();
    for (const p of orderPlans) {
      for (const order of p.orders) {
        const id = orderIds.get(order);
        const row = id ? orders.find((o) => o.order_id === id) : null;
        if (!row || !row.supplier_id) continue;
        const key = `${row.job_id}|${row.supplier_id}`;
        const g = groups.get(key) ??
          { entry: order.entry, jobStatus: p.job!.status, ours: [] };
        if (!g.ours.some((o) => o.order_id === row.order_id)) g.ours.push(row);
        groups.set(key, g);
      }
    }
    for (const [key, g] of groups) {
      const [jobId, supplierId] = key.split("|");
      const ours = new Set(g.ours.map((o) => o.order_id));
      const supplierOrders: OrderRef[] = orders
        .filter((o) => o.job_id === jobId && o.supplier_id === supplierId)
        .map((o) => ({
          order_id: o.order_id,
          sent_at: o.sent_at,
          sent_conversation_id: o.sent_conversation_id,
        }));
      for (
        const t of storedRepliesToTie(replies, {
          job_id: jobId,
          entry: g.entry,
          orders: supplierOrders,
          tieable: ours,
        })
      ) {
        const reason = `${t.reply.match_reason ?? "Job number"}. ${
          outlookSendTieReason(t.order.sent_at)
        }`;
        try {
          if (
            await store.tieReply(orgId, t.reply.id, t.order.order_id, reason, now)
          ) {
            done.replies_tied++;
          }
        } catch (e) {
          console.error("[dispatch_v2_outlook_catch_up] tie failed:", e);
        }
      }
      // In Progress: the materials are on site. Delivered, unless a person
      // (or an earlier run) set the box's stage after the newest of these
      // orders was sent.
      if (g.jobStatus !== "in_progress") continue;
      const box = boxes.find((b) =>
        b.job_id === jobId && b.supplier_id === supplierId
      );
      if (!box) continue;
      const newestOurs = g.ours.map((o) => at(o.sent_at))
        .reduce((a, b) => Math.max(a, b), -Infinity);
      const setAt = at(box.material_stage_set_at);
      if (
        box.material_stage && Number.isFinite(setAt) && setAt >= newestOurs
      ) {
        continue;
      }
      try {
        if (
          await store.setBoxDelivered({
            org_id: orgId,
            box,
            supplier_name: g.entry.supplier_name,
            operator_email: ctx.operator.email!,
            operator_user_id: ctx.operator.userId,
            now,
          })
        ) {
          done.set_delivered++;
        }
      } catch (e) {
        console.error("[dispatch_v2_outlook_catch_up] delivered failed:", e);
      }
    }
  }

  // Emails no order can come from that a person must see.
  for (const p of plan._plans) {
    const reason = p.verdict === "refused"
      ? p.reason
      : p.verdict === "orders" && p.unlinked.length > 0
      ? "supplier_not_in_xero"
      : null;
    if (!reason || !TRAYED_REFUSALS.has(reason)) continue;
    try {
      if (await ctx.replies.insertEmail(trayRowFor(p, orgId))) done.to_sort++;
    } catch (e) {
      console.error("[dispatch_v2_outlook_catch_up] tray write failed:", e);
    }
  }
  return done;
}
