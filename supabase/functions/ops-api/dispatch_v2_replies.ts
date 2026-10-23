// deno-lint-ignore-file no-explicit-any
// Dispatch v2, slice 8: supplier replies and suggested moves. The engine.
// Contract: replies.md (the build contract for this slice).
//
// What it does:
//   * The scan (dispatch_v2_replies_scan, every five minutes from pg_cron):
//     reads the inbound emails the capture reader saved since last time,
//     keeps only the ones from a supplier, matches each to a Dispatch order by
//     the four rungs (dispatch_v2_replies_rules.ts) and, when a matched email
//     gives a delivery date, adds a suggestion "Stratco WA: delivery Tue 3 Nov".
//     Emails that are not from a supplier are left exactly as they were.
//   * The screen's reads: a job's supplier emails and suggestions, and the
//     Unmatched supplier emails tray.
//   * The presses: assign an email to a job (and order), confirm or reject a
//     best guess, hide tray noise, Accept or Dismiss a suggestion.
//
// What it never does: send anything, move a job's stage or status (Accept
// only sets the order's confirmed delivery date; the screen may then offer
// update_job_status with its own confirm), write suppliers.email, or touch
// Xero. No paid AI read: dates are read by written-down rules.
//
// The database is behind RepliesStore (dispatch_v2_replies_store.ts) and the
// other slices' tables behind DispatchRepliesSources
// (dispatch_v2_replies_sources.ts), so the tests run on in-memory copies.

import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
} from "./dispatch_materials_store.ts";
import {
  type ApprovedSupplierSender,
  dayLabel,
  identifySender,
  isAutoReply,
  type JobHint,
  jobNumbersIn,
  matchEmail,
  normaliseJobNumber,
  perthDay,
  readDeliveryDate,
  rungLabel,
  type SenderIdentity,
  stageMoveOffer,
  suggestionLabel,
  supplierRefsIn,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";
import {
  type EmailRow,
  type RefLinkRow,
  type RepliesStore,
  RepliesStoreError,
  type SuggestionRow,
} from "./dispatch_v2_replies_store.ts";
import {
  type DispatchRepliesSources,
  SourceReadError,
} from "./dispatch_v2_replies_sources.ts";
import { emailProviderKey } from "../_shared/evidence/outlook_mail.ts";

export const DISPATCH_V2_REPLIES_READ_ACTIONS = [
  "dispatch_v2_replies",
  "dispatch_v2_replies_unmatched",
] as const;

export const DISPATCH_V2_REPLIES_WRITE_ACTIONS = [
  "dispatch_v2_replies_assign",
  "dispatch_v2_replies_confirm_guess",
  "dispatch_v2_replies_reject_guess",
  "dispatch_v2_replies_hide",
  "dispatch_v2_suggestion_accept",
  "dispatch_v2_suggestion_dismiss",
] as const;

export const DISPATCH_V2_REPLIES_SCAN_ACTION = "dispatch_v2_replies_scan";

export type DispatchV2RepliesContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // 'screen' for a signed-in session, 'terminal' for the ops key.
  via: "screen" | "terminal";
  store: RepliesStore;
  sources: DispatchRepliesSources;
  now?: () => string;
};

// The scan reads at most this many captured emails per run (and up to 500
// when asked). Five minutes of admin@ is far fewer.
const SCAN_LIMIT_DEFAULT = 200;
const SCAN_LIMIT_MAX = 500;
// A captured row is read only once it is two minutes old, so a row saved a
// moment late (a lower sequence number committed after a higher one) is not
// stepped over.
const SCAN_LAG_MS = 2 * 60_000;
// Orders sent this long ago or less are matched; older orders still match by
// job number.
const ORDER_WINDOW_DAYS = 180;
const SNIPPET_CHARS = 280;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Operator = { userId: string | null; email: string };

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchMaterialsError(status, code, message, extra);
}

function nowIso(ctx: DispatchV2RepliesContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function uuidParam(
  value: unknown,
  name: string,
  required = true,
): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    if (required) refuse(400, "invalid_request", `${name} is required`);
    return null;
  }
  if (!UUID_RE.test(v)) {
    refuse(400, "invalid_request", `${name} must be a uuid`);
  }
  return v.toLowerCase();
}

function intParam(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(String(value ?? ""));
  if (
    value === undefined || value === null || value === "" || !Number.isFinite(n)
  ) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// Every press names a person: the signed-in user, or for the ops key the
// operator_email in the body matching a row in users (as Dispatch slice 6).
async function resolveOperator(
  body: any,
  ctx: DispatchV2RepliesContext,
): Promise<Operator> {
  if (ctx.via === "screen") {
    if (!ctx.actor.userId || !ctx.actor.email) {
      refuse(400, "operator_required", "A named person is required");
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
      "operator_email naming a person is required",
    );
  }
  const user = await ctx.store.userByEmail(ctx.orgId, raw);
  if (!user) {
    refuse(
      400,
      "operator_required",
      "operator_email does not name a person in users",
    );
  }
  // The key is not that person: the by-id stays null and the email names them.
  return { userId: null, email: user.email };
}

// ── What the screen gets ──────────────────────────────────────────────────

export function projectSuggestion(s: SuggestionRow) {
  return {
    id: s.id,
    job_id: s.job_id,
    order_id: s.order_id,
    email_id: s.email_id,
    supplier_name: s.supplier_name,
    delivery_date: s.delivery_date,
    delivery_label: dayLabel(s.delivery_date),
    label: s.label,
    quote: s.quote,
    weekday_mismatch: s.flags?.weekday_mismatch === true,
    day_word_only: s.flags?.day_word_only === true,
    other_dates: Array.isArray(s.flags?.other_dates) ? s.flags.other_dates : [],
    state: s.state,
    can_accept: s.state === "open",
    // No single order was matched: Accept needs order_id from the screen.
    needs_order_pick: s.state === "open" && !s.order_id,
    accepted_order_id: s.accepted_order_id,
    acted_at: s.acted_at,
    acted_by_email: s.acted_by_email,
    created_at: s.created_at,
  };
}

export function projectEmail(
  e: EmailRow,
  jobNumbers: Map<string, string | null>,
  suggestionByEmail: Map<string, SuggestionRow>,
) {
  const suggestion = suggestionByEmail.get(e.id) ?? null;
  return {
    id: e.id,
    business_event_id: e.business_event_id,
    received_at: e.received_at,
    from_email: e.from_email,
    subject: e.subject,
    snippet: e.snippet,
    supplier_name: e.supplier_name,
    order_desk: e.order_desk,
    state: e.state,
    rung: e.rung,
    rung_label: rungLabel(e.rung),
    match_reason: e.match_reason,
    needs_confirmation: e.state === "needs_confirmation",
    job_id: e.job_id,
    job_number: e.job_id ? jobNumbers.get(e.job_id) ?? null : null,
    order_id: e.order_id,
    candidates: e.candidates ?? [],
    job_numbers: e.job_numbers ?? [],
    supplier_refs: e.supplier_refs ?? [],
    delivery_date: e.delivery_date,
    delivery_label: e.delivery_date ? dayLabel(e.delivery_date) : null,
    suggestion_id: suggestion?.id ?? null,
    suggestion_state: suggestion?.state ?? null,
    decision: e.decision,
    decided_at: e.decided_at,
    decided_by_email: e.decided_by_email,
  };
}

async function projectEmails(ctx: DispatchV2RepliesContext, rows: EmailRow[]) {
  const jobs = await ctx.store.jobsByIds(
    ctx.orgId,
    rows.map((r) => r.job_id).filter((x): x is string => !!x),
  );
  const jobNumbers = new Map(jobs.map((j) => [j.job_id, j.job_number]));
  const suggestions = await ctx.store.suggestionsForEmails(
    ctx.orgId,
    rows.map((r) => r.id),
  );
  const byEmail = new Map(suggestions.map((s) => [s.email_id, s]));
  return rows.map((r) => projectEmail(r, jobNumbers, byEmail));
}

async function projectOne(ctx: DispatchV2RepliesContext, row: EmailRow) {
  return (await projectEmails(ctx, [row]))[0];
}

// ── Shared steps ──────────────────────────────────────────────────────────

/** Link the email's supplier numbers to an order, skipping any number that
 * is already linked to a different order (one number, one order). */
async function linkRefs(
  ctx: DispatchV2RepliesContext,
  email: EmailRow,
  order: { order_id: string; job_id: string; supplier_name: string | null },
  via: RefLinkRow["linked_via"],
  operator: Operator | null,
  known?: Map<string, { order_id: string; supplier_key: string | null }[]>,
): Promise<string[]> {
  // The table keeps 3 to 24 characters, upper case, no spaces.
  const refs = (email.supplier_refs ?? []).filter((r) =>
    /^[A-Z0-9/-]{3,24}$/.test(r)
  );
  if (refs.length === 0) return [];
  const existing = known ??
    new Map<string, { order_id: string; supplier_key: string | null }[]>();
  if (!known) {
    for (const l of await ctx.store.refLinks(ctx.orgId, refs)) {
      existing.set(l.ref, [...(existing.get(l.ref) ?? []), l]);
    }
  }
  // A number already linked (to this order or another) is left as it is.
  const fresh = refs.filter((ref) => (existing.get(ref) ?? []).length === 0);
  if (fresh.length === 0) return [];
  await ctx.store.insertRefLinks(
    ctx.orgId,
    fresh.map((ref) => ({
      order_id: order.order_id,
      job_id: order.job_id,
      supplier_key: email.supplier_key,
      supplier_name: order.supplier_name ?? email.supplier_name,
      ref,
      source_email_id: email.id,
      linked_via: via,
      linked_by: operator?.userId ?? null,
      linked_by_email: operator?.email ?? null,
    })),
  );
  for (const ref of fresh) {
    existing.set(ref, [
      ...(existing.get(ref) ?? []),
      { order_id: order.order_id, supplier_key: email.supplier_key },
    ]);
  }
  return fresh;
}

/** The suggestion for a matched email, when it gives a delivery date that
 * is not in the past and is not already the order's confirmed date. If the
 * email already has an open suggestion (it was assigned again), that one is
 * moved to the new job and order instead. */
async function suggestFor(
  ctx: DispatchV2RepliesContext,
  email: EmailRow,
  order: V2Order | null,
  now: string,
): Promise<SuggestionRow | null> {
  if (!email.delivery_date || !email.job_id) return null;
  const today = perthDay(now)!;
  if (email.delivery_date < today) return null;
  if (order && order.confirmed_delivery_date === email.delivery_date) {
    return null;
  }
  const supplierName = order?.supplier_name ?? email.supplier_name;
  const label = suggestionLabel(supplierName, email.delivery_date);

  const [prior] = await ctx.store.suggestionsForEmails(ctx.orgId, [email.id]);
  let row: SuggestionRow | null;
  if (prior) {
    if (prior.state !== "open") return null;
    row = await ctx.store.updateSuggestion(ctx.orgId, prior.id, "open", {
      job_id: email.job_id,
      order_id: order?.order_id ?? null,
      supplier_name: supplierName,
      label,
      updated_at: now,
    });
  } else {
    const read = (email.delivery_read ?? {}) as Record<string, unknown>;
    row = await ctx.store.insertSuggestion({
      org_id: ctx.orgId,
      job_id: email.job_id,
      order_id: order?.order_id ?? null,
      email_id: email.id,
      supplier_key: email.supplier_key,
      supplier_name: supplierName,
      delivery_date: email.delivery_date,
      label,
      quote: typeof read.quote === "string" ? read.quote : null,
      flags: {
        weekday_mismatch: read.weekday_mismatch === true,
        day_word_only: read.day_word_only === true,
        other_dates: Array.isArray(read.other_dates) ? read.other_dates : [],
      },
      state: "open",
      accepted_order_id: null,
      acted_at: null,
      acted_by: null,
      acted_by_email: null,
    });
  }
  // A newer date for the same order replaces the older open one.
  if (row && order) {
    await ctx.store.supersedeOpenForOrder(
      ctx.orgId,
      order.order_id,
      row.id,
      now,
    );
  }
  return row;
}

async function orderOnJob(
  ctx: DispatchV2RepliesContext,
  orderId: string,
  jobId: string,
): Promise<V2Order> {
  const read = await ctx.sources.getOrder(ctx.orgId, orderId);
  if (!read.available) {
    refuse(
      503,
      "orders_not_wired",
      "Dispatch orders are not in the database yet",
    );
  }
  const order = read.rows[0];
  if (!order || order.job_id !== jobId) {
    refuse(409, "order_not_on_job", "That order is not on this job");
  }
  return order;
}

async function loadEmail(ctx: DispatchV2RepliesContext, body: any) {
  const id = uuidParam(body?.email_id, "email_id")!;
  const email = await ctx.store.getEmail(ctx.orgId, id);
  if (!email) refuse(404, "email_not_found", "No such supplier email");
  return email;
}

async function loadJob(
  ctx: DispatchV2RepliesContext,
  jobId: string,
): Promise<JobHint> {
  const [job] = await ctx.store.jobsByIds(ctx.orgId, [jobId]);
  if (!job) refuse(404, "job_not_found", "No such job");
  return job;
}

function decided(operator: Operator, decision: string, now: string) {
  return {
    decision,
    decided_at: now,
    decided_by: operator.userId,
    decided_by_email: operator.email,
    updated_at: now,
  };
}

// ── The scan ──────────────────────────────────────────────────────────────

type ScanCounts = {
  read: number;
  stored: number;
  matched: number;
  needs_confirmation: number;
  unmatched: number;
  not_supplier: number;
  auto_reply: number;
  deep_history: number;
  already_stored: number;
  suggestions: number;
  refs_linked: number;
};

function zeroCounts(): ScanCounts {
  return {
    read: 0,
    stored: 0,
    matched: 0,
    needs_confirmation: 0,
    unmatched: 0,
    not_supplier: 0,
    auto_reply: 0,
    deep_history: 0,
    already_stored: 0,
    suggestions: 0,
    refs_linked: 0,
  };
}

/** One run of the scan. Body (all optional): from_sequence (start after this
 * business_events.sequence_number instead of the saved cursor), limit, force
 * (run while the flag is off, for a supervised test). */
export async function scanDispatchV2Replies(
  body: any,
  ctx: DispatchV2RepliesContext,
) {
  const now = nowIso(ctx);
  const { store, sources, orgId } = ctx;
  if (!(await store.flagEnabled()) && body?.force !== true) {
    return { ok: true, skipped: "flag_off", flag: "dispatch_v2_replies_v1" };
  }
  const state = await store.getScanState();
  const from = Number.isInteger(body?.from_sequence) && body.from_sequence >= 0
    ? Number(body.from_sequence)
    : null;
  const cursor = from ?? state.cursor_sequence;
  const counts = zeroCounts();

  if (cursor == null) {
    // First run: start from now. Older mail is read only when asked
    // (from_sequence), so switching on never floods the tray.
    const head = (await store.headSequence()) ?? 0;
    await store.saveScanState({
      cursor_sequence: head,
      last_scan_at: now,
      last_result: { first_run: true, ...counts },
    });
    return { ok: true, first_run: true, cursor_sequence: head, ...counts };
  }

  const limit = intParam(body?.limit, SCAN_LIMIT_DEFAULT, 1, SCAN_LIMIT_MAX);
  const before = new Date(Date.parse(now) - SCAN_LAG_MS).toISOString();
  const rows = await store.readInboundEmails(cursor, before, limit);
  counts.read = rows.length;
  if (rows.length === 0) {
    await store.saveScanState({
      cursor_sequence: cursor,
      last_scan_at: now,
      last_result: counts,
    });
    return { ok: true, cursor_sequence: cursor, ...counts };
  }

  // Who each email is from. Most mail is not from a supplier: it stops here.
  const approvedRead = await sources.listApprovedSenders(orgId);
  const approved: ApprovedSupplierSender[] = approvedRead.rows;
  const contacts = await store.supplierContacts(orgId);
  const stored = await store.storedEventIds(
    rows.map((r) => r.business_event_id),
  );
  const work: { row: (typeof rows)[number]; sender: SenderIdentity }[] = [];
  for (const row of rows) {
    if (row.history_tier === "deep") {
      counts.deep_history++;
      continue;
    }
    const sender = identifySender(
      row.from_email,
      approved,
      contacts,
      row.sender_kind,
    );
    if (!sender.is_supplier) {
      counts.not_supplier++;
      continue;
    }
    if (isAutoReply(row.subject, row.body)) {
      counts.auto_reply++;
      continue;
    }
    if (stored.has(row.business_event_id)) {
      counts.already_stored++;
      continue;
    }
    work.push({ row, sender });
  }

  let ordersWired = true;
  if (work.length > 0) {
    // Everything the rungs need, read once for the whole run.
    const numbers = [
      ...new Set(work.flatMap((w) => jobNumbersIn(w.row.subject, w.row.body))),
    ];
    const numberedJobs = await store.jobsByNumbers(orgId, numbers);
    const jobsByNumber = new Map(
      numberedJobs.map((j) => [normaliseJobNumber(j.job_number), j]),
    );
    const sinceIso = new Date(
      Date.parse(now) - ORDER_WINDOW_DAYS * 86_400_000,
    ).toISOString();
    const ordersRead = await sources.listOrders(orgId, {
      sentSince: sinceIso,
      jobIds: numberedJobs.map((j) => j.job_id),
    });
    ordersWired = ordersRead.available;
    const orders = ordersRead.rows;
    const orderById = new Map(orders.map((o) => [o.order_id, o]));

    const keyByOrder = new Map<string, string>();
    for (const o of orders) {
      const key = emailProviderKey(o.sent_internet_message_id);
      if (key) keyByOrder.set(o.order_id, key);
    }
    const capturedConv = await store.conversationIdsFor([
      ...keyByOrder.values(),
    ]);
    const orderConversationIds = new Map<string, string[]>();
    for (const o of orders) {
      const ids = [
        o.sent_conversation_id,
        capturedConv.get(keyByOrder.get(o.order_id) ?? "") ?? null,
      ].filter((x): x is string => !!x);
      orderConversationIds.set(o.order_id, [...new Set(ids)]);
    }

    const refs = [
      ...new Set(
        work.flatMap((w) => supplierRefsIn(w.row.subject, w.row.body)),
      ),
    ];
    const refLinks = new Map<
      string,
      { order_id: string; supplier_key: string | null }[]
    >();
    for (const l of await store.refLinks(orgId, refs)) {
      refLinks.set(l.ref, [...(refLinks.get(l.ref) ?? []), l]);
    }
    const jobsById = new Map(
      (await store.jobsByIds(orgId, orders.map((o) => o.job_id)))
        .map((j) => [j.job_id, j]),
    );
    for (const j of numberedJobs) jobsById.set(j.job_id, j);

    for (const { row, sender } of work) {
      const result = matchEmail(
        {
          email: row,
          sender,
          orders,
          orderConversationIds,
          jobsByNumber,
          refLinks,
          jobsById,
          rejectedOrderIds: [],
        },
        approved,
        now,
      );
      const delivery = readDeliveryDate(row.body, row.received_at);
      const placed = result.state !== "unmatched";
      const inserted = await store.insertEmail({
        org_id: orgId,
        business_event_id: row.business_event_id,
        sequence_number: row.sequence_number,
        provider_message_id: row.provider_message_id,
        conversation_id: row.conversation_id,
        received_at: row.received_at,
        from_email: row.from_email ?? "",
        subject: row.subject,
        snippet: row.body.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS),
        supplier_key: sender.supplier_key,
        supplier_name: sender.supplier_name,
        sender_via: sender.via,
        order_desk: sender.order_desk,
        job_numbers: jobNumbersIn(row.subject, row.body),
        supplier_refs: supplierRefsIn(row.subject, row.body),
        delivery_date: delivery?.date ?? null,
        delivery_read: delivery ? { ...delivery } : null,
        state: result.state,
        rung: result.rung,
        match_reason: result.reason,
        job_id: placed ? result.job_id : null,
        order_id: placed ? result.order_id : null,
        candidates: result.state === "matched" ? [] : result.candidates,
        rejected_order_ids: [],
        decision: null,
        decided_at: null,
        decided_by: null,
        decided_by_email: null,
        matched_at: placed ? now : null,
      });
      if (!inserted) {
        counts.already_stored++;
        continue;
      }
      counts.stored++;
      counts[result.state]++;
      if (result.state !== "matched") continue;
      const order = result.order_id
        ? orderById.get(result.order_id) ?? null
        : null;
      if (order) {
        counts.refs_linked += (await linkRefs(
          ctx,
          inserted,
          order,
          "certain_match",
          null,
          refLinks,
        )).length;
      }
      if (await suggestFor(ctx, inserted, order, now)) counts.suggestions++;
    }
  }

  const next = rows[rows.length - 1].sequence_number;
  await store.saveScanState({
    cursor_sequence: next,
    last_scan_at: now,
    last_result: {
      ...counts,
      orders_wired: ordersWired,
      approved_wired: approvedRead.available,
    },
  });
  return {
    ok: true,
    cursor_sequence: next,
    ...counts,
    orders_wired: ordersWired,
    approved_wired: approvedRead.available,
  };
}

// ── The reads ─────────────────────────────────────────────────────────────

/** GET ?action=dispatch_v2_replies&job_id=... */
export async function listJobReplies(
  params: URLSearchParams,
  ctx: DispatchV2RepliesContext,
) {
  const jobId = uuidParam(params.get("job_id"), "job_id")!;
  const job = await loadJob(ctx, jobId);
  const now = nowIso(ctx);
  const rows = await ctx.store.emailsForJob(ctx.orgId, jobId, 100);
  const emails = await projectEmails(ctx, rows);
  const suggestions = (await ctx.store.suggestionsForJob(ctx.orgId, jobId))
    .sort((a, b) =>
      Number(b.state === "open") - Number(a.state === "open") ||
      b.created_at.localeCompare(a.created_at)
    )
    .map(projectSuggestion);
  const ordersRead = await ctx.sources.listOrders(ctx.orgId, {
    sentSince: new Date(Date.parse(now) - ORDER_WINDOW_DAYS * 86_400_000)
      .toISOString(),
    jobIds: [jobId],
  });
  const scan = await ctx.store.getScanState();
  return {
    ok: true,
    job_id: job.job_id,
    job_number: job.job_number,
    emails,
    suggestions,
    orders: ordersRead.rows
      .filter((o) => o.job_id === jobId)
      .map((o) => ({
        order_id: o.order_id,
        supplier_name: o.supplier_name,
        status: o.status,
        sent_at: o.sent_at,
        confirmed_delivery_date: o.confirmed_delivery_date,
      })),
    orders_wired: ordersRead.available,
    scan: {
      enabled: await ctx.store.flagEnabled(),
      last_scan_at: scan.last_scan_at,
    },
  };
}

/** GET ?action=dispatch_v2_replies_unmatched[&include_other=1][&limit=100] */
export async function listUnmatchedReplies(
  params: URLSearchParams,
  ctx: DispatchV2RepliesContext,
) {
  const includeOther = ["1", "true", "yes"].includes(
    String(params.get("include_other") ?? "").toLowerCase(),
  );
  const limit = intParam(params.get("limit"), 100, 1, 200);
  const { rows, counts } = await ctx.store.tray(ctx.orgId, {
    includeOther,
    limit,
  });
  return {
    ok: true,
    include_other: includeOther,
    emails: await projectEmails(ctx, rows),
    counts,
  };
}

// ── The presses ───────────────────────────────────────────────────────────

/** POST {email_id, job_id, order_id?}: this email is for that job (order). */
export async function assignReply(body: any, ctx: DispatchV2RepliesContext) {
  const operator = await resolveOperator(body, ctx);
  const email = await loadEmail(ctx, body);
  const jobId = uuidParam(body?.job_id, "job_id")!;
  const orderId = uuidParam(body?.order_id, "order_id", false);
  const job = await loadJob(ctx, jobId);
  const order = orderId ? await orderOnJob(ctx, orderId, jobId) : null;
  const now = nowIso(ctx);
  const updated = await ctx.store.updateEmail(
    ctx.orgId,
    email.id,
    email.state,
    {
      state: "matched",
      rung: "manual",
      match_reason: "Picked by hand",
      job_id: jobId,
      order_id: order?.order_id ?? null,
      candidates: [],
      matched_at: now,
      ...decided(operator, "assigned", now),
    },
  );
  if (!updated) {
    refuse(409, "email_changed", "Someone else changed this email first");
  }
  const linked = order
    ? await linkRefs(ctx, updated, order, "assigned", operator)
    : [];
  const suggestion = await suggestFor(ctx, updated, order, now);
  await ctx.store.logJobEvent(
    jobId,
    operator.userId,
    "dispatch_v2_reply_assigned",
    {
      email_id: updated.id,
      order_id: order?.order_id ?? null,
      supplier: order?.supplier_name ?? updated.supplier_name,
      subject: updated.subject,
      supplier_refs_linked: linked,
      operator_email: operator.email,
      via: ctx.via,
    },
  );
  return {
    ok: true,
    email: await projectOne(ctx, updated),
    job_number: job.job_number,
    supplier_refs_linked: linked,
    suggestion: suggestion ? projectSuggestion(suggestion) : null,
  };
}

/** POST {email_id}: yes, the best guess is right. Links the supplier's own
 * numbers in the email to the order, so the next email quoting one matches by
 * itself. */
export async function confirmGuess(body: any, ctx: DispatchV2RepliesContext) {
  const operator = await resolveOperator(body, ctx);
  const email = await loadEmail(ctx, body);
  if (
    email.state !== "needs_confirmation" || !email.order_id || !email.job_id
  ) {
    refuse(
      409,
      "not_a_best_guess",
      "This email is not waiting on a best guess",
      {
        state: email.state,
      },
    );
  }
  const order = await orderOnJob(ctx, email.order_id, email.job_id);
  const now = nowIso(ctx);
  const updated = await ctx.store.updateEmail(
    ctx.orgId,
    email.id,
    "needs_confirmation",
    {
      state: "matched",
      candidates: [],
      matched_at: now,
      ...decided(operator, "confirmed", now),
    },
  );
  if (!updated) {
    refuse(409, "email_changed", "Someone else changed this email first");
  }
  const linked = await linkRefs(
    ctx,
    updated,
    order,
    "confirmed_guess",
    operator,
  );
  const suggestion = await suggestFor(ctx, updated, order, now);
  await ctx.store.logJobEvent(
    order.job_id,
    operator.userId,
    "dispatch_v2_reply_guess_confirmed",
    {
      email_id: updated.id,
      order_id: order.order_id,
      supplier: order.supplier_name,
      subject: updated.subject,
      supplier_refs_linked: linked,
      operator_email: operator.email,
      via: ctx.via,
    },
  );
  return {
    ok: true,
    email: await projectOne(ctx, updated),
    supplier_refs_linked: linked,
    suggestion: suggestion ? projectSuggestion(suggestion) : null,
  };
}

/** POST {email_id}: no, the best guess is wrong. The email goes to the
 * Unmatched tray, and that order is never guessed for it again. */
export async function rejectGuess(body: any, ctx: DispatchV2RepliesContext) {
  const operator = await resolveOperator(body, ctx);
  const email = await loadEmail(ctx, body);
  if (email.state !== "needs_confirmation" || !email.order_id) {
    refuse(
      409,
      "not_a_best_guess",
      "This email is not waiting on a best guess",
      {
        state: email.state,
      },
    );
  }
  const now = nowIso(ctx);
  const rejected = [
    ...new Set([...(email.rejected_order_ids ?? []), email.order_id]),
  ];
  const updated = await ctx.store.updateEmail(
    ctx.orgId,
    email.id,
    "needs_confirmation",
    {
      state: "unmatched",
      rung: null,
      match_reason: "Best guess turned down",
      job_id: null,
      order_id: null,
      matched_at: null,
      rejected_order_ids: rejected,
      candidates: (email.candidates ?? []).filter((c: any) =>
        !rejected.includes(c?.order_id)
      ),
      ...decided(operator, "rejected", now),
    },
  );
  if (!updated) {
    refuse(409, "email_changed", "Someone else changed this email first");
  }
  return { ok: true, email: await projectOne(ctx, updated) };
}

/** POST {email_id}: take an unmatched email out of the tray (marketing,
 * statements). The email itself stays in the capture record. */
export async function hideReply(body: any, ctx: DispatchV2RepliesContext) {
  const operator = await resolveOperator(body, ctx);
  const email = await loadEmail(ctx, body);
  if (email.state !== "unmatched") {
    refuse(409, "not_unmatched", "Only an unmatched email can be hidden", {
      state: email.state,
    });
  }
  const now = nowIso(ctx);
  const updated = await ctx.store.updateEmail(
    ctx.orgId,
    email.id,
    "unmatched",
    {
      state: "hidden",
      ...decided(operator, "hidden", now),
    },
  );
  if (!updated) {
    refuse(409, "email_changed", "Someone else changed this email first");
  }
  return { ok: true, email: await projectOne(ctx, updated) };
}

async function loadOpenSuggestion(ctx: DispatchV2RepliesContext, body: any) {
  const id = uuidParam(body?.suggestion_id, "suggestion_id")!;
  const s = await ctx.store.getSuggestion(ctx.orgId, id);
  if (!s) refuse(404, "suggestion_not_found", "No such suggestion");
  if (s.state !== "open") {
    refuse(
      409,
      "suggestion_not_open",
      `This suggestion is already ${s.state}`,
      {
        state: s.state,
      },
    );
  }
  return s;
}

/** POST {suggestion_id, order_id?}: Accept. Sets the order's confirmed
 * delivery date. Never the job's stage or status: the answer carries
 * stage_move_offer for the screen to ASK about (update_job_status). */
export async function acceptSuggestion(
  body: any,
  ctx: DispatchV2RepliesContext,
) {
  const operator = await resolveOperator(body, ctx);
  const s = await loadOpenSuggestion(ctx, body);
  const picked = uuidParam(body?.order_id, "order_id", false);
  if (s.order_id && picked && picked !== s.order_id) {
    refuse(409, "order_mismatch", "This suggestion is for a different order", {
      order_id: s.order_id,
    });
  }
  const orderId = s.order_id ?? picked;
  if (!orderId) {
    refuse(400, "order_required", "Pick which order this delivery date is for");
  }
  const order = await orderOnJob(ctx, orderId, s.job_id);
  const now = nowIso(ctx);
  const write = await ctx.sources.setConfirmedDeliveryDate({
    orgId: ctx.orgId,
    order,
    date: s.delivery_date,
    now,
    suggestionId: s.id,
  });
  if (!write.ok) refuse(write.status, write.code, write.message);
  const updated = await ctx.store.updateSuggestion(ctx.orgId, s.id, "open", {
    state: "accepted",
    order_id: order.order_id,
    accepted_order_id: order.order_id,
    acted_at: now,
    acted_by: operator.userId,
    acted_by_email: operator.email,
    updated_at: now,
  });
  if (!updated) {
    refuse(
      409,
      "suggestion_changed",
      "Someone else acted on this suggestion first",
      {
        confirmed_delivery_date: s.delivery_date,
      },
    );
  }
  await ctx.store.supersedeOpenForOrder(ctx.orgId, order.order_id, s.id, now);
  const [job] = await ctx.store.jobsByIds(ctx.orgId, [s.job_id]);
  const offer = stageMoveOffer(job ?? null);
  await ctx.store.logJobEvent(
    s.job_id,
    operator.userId,
    "dispatch_v2_delivery_accepted",
    {
      suggestion_id: s.id,
      email_id: s.email_id,
      order_id: order.order_id,
      supplier: order.supplier_name,
      delivery_date: s.delivery_date,
      previous_confirmed_delivery_date: order.confirmed_delivery_date,
      operator_email: operator.email,
      via: ctx.via,
    },
  );
  return {
    ok: true,
    suggestion: projectSuggestion(updated),
    order: {
      order_id: order.order_id,
      supplier_name: order.supplier_name,
      confirmed_delivery_date: write.confirmed_delivery_date,
      previous_confirmed_delivery_date: order.confirmed_delivery_date,
    },
    job_status_changed: false,
    stage_move_offer: offer
      ? { ...offer, job_id: s.job_id, action: "update_job_status" }
      : null,
  };
}

/** POST {suggestion_id}: Dismiss. The suggestion is hidden; nothing else. */
export async function dismissSuggestion(
  body: any,
  ctx: DispatchV2RepliesContext,
) {
  const operator = await resolveOperator(body, ctx);
  const s = await loadOpenSuggestion(ctx, body);
  const now = nowIso(ctx);
  const updated = await ctx.store.updateSuggestion(ctx.orgId, s.id, "open", {
    state: "dismissed",
    acted_at: now,
    acted_by: operator.userId,
    acted_by_email: operator.email,
    updated_at: now,
  });
  if (!updated) {
    refuse(
      409,
      "suggestion_changed",
      "Someone else acted on this suggestion first",
    );
  }
  await ctx.store.logJobEvent(
    s.job_id,
    operator.userId,
    "dispatch_v2_delivery_dismissed",
    {
      suggestion_id: s.id,
      email_id: s.email_id,
      order_id: s.order_id,
      supplier: s.supplier_name,
      delivery_date: s.delivery_date,
      operator_email: operator.email,
      via: ctx.via,
    },
  );
  return { ok: true, suggestion: projectSuggestion(updated) };
}

// ── The router's one entry ────────────────────────────────────────────────

export async function runDispatchV2RepliesAction(
  action: string,
  params: URLSearchParams,
  body: any,
  ctx: DispatchV2RepliesContext,
) {
  try {
    switch (action) {
      case "dispatch_v2_replies":
        return await listJobReplies(params, ctx);
      case "dispatch_v2_replies_unmatched":
        return await listUnmatchedReplies(params, ctx);
      case "dispatch_v2_replies_assign":
        return await assignReply(body, ctx);
      case "dispatch_v2_replies_confirm_guess":
        return await confirmGuess(body, ctx);
      case "dispatch_v2_replies_reject_guess":
        return await rejectGuess(body, ctx);
      case "dispatch_v2_replies_hide":
        return await hideReply(body, ctx);
      case "dispatch_v2_suggestion_accept":
        return await acceptSuggestion(body, ctx);
      case "dispatch_v2_suggestion_dismiss":
        return await dismissSuggestion(body, ctx);
      case DISPATCH_V2_REPLIES_SCAN_ACTION:
        return await scanDispatchV2Replies(body, ctx);
      default:
        refuse(400, "unknown_action", `Unknown action ${action}`);
    }
  } catch (e) {
    if (e instanceof RepliesStoreError || e instanceof SourceReadError) {
      console.error("[dispatch_v2_replies]", e.message, e.detail);
      refuse(500, "replies_read_failed", e.message);
    }
    throw e;
  }
}
