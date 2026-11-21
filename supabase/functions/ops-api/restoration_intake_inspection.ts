// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client is intentionally untyped at this boundary,
// matching the sibling store modules.
//
// A new restoration card's first visit (owner, 20 Nov 2026): every restoration
// job that comes in through ses@ puts Marnin and Jean on the job with NO date
// ("it shouldn't be booked for the day it comes in"). Jean arranges a time with
// the client and books it in the Trade App (restoration_visit_booking.ts).
// Jean's pay for that visit is always the same: 2 hours at $44 an hour, $88 ex
// GST, for the moisture inspection, readings, photos and room scan the report
// and quote are built from. The owner's standing rule is that this work order
// is filled and approved automatically, and that Jean is texted when the job
// comes through.
//
// So at mint, after the restoration crew is put on the job:
//   1. the job's ONE job work order (kind 'job') is filled with that visit
//      (scope line, agreed amount, site address, builder references; no date,
//      because none is agreed yet) and
//      approved through approve_job_work_order_by_agent, which records the
//      actor and the standing rule's name and never claims a person pressed it;
//   2. the paid trade gets one text asking him to arrange the visit with the
//      client and book it in the app, claimed first as a job event so a retry
//      never texts twice.
//
// Neither step may fail the mint: each is logged and left for the office.
// The works themselves get their own additional work order once the quote is
// approved; this is only the inspection visit.

export const RESTORATION_INSPECTION_HOURS = 2;
export const RESTORATION_INSPECTION_RATE_EX = 44;
export const RESTORATION_INSPECTION_AGREED_EX =
  RESTORATION_INSPECTION_HOURS * RESTORATION_INSPECTION_RATE_EX;

/** The trade paid on the inspection work order (the owner is not paid on it). */
export const RESTORATION_INSPECTION_TRADE_EMAIL = "jeancrous44@gmail.com";

export const RESTORATION_INSPECTION_ACTOR = "agent:restoration-intake";
export const RESTORATION_INSPECTION_APPROVED_BY_NAME =
  "Marnin (standing rule for restoration inspections, 20 Nov 2026)";

/** The note on the crew rows restoration intake puts on a job, undated. */
export const RESTORATION_INTAKE_ASSIGNMENT_NOTE =
  "Auto-allocated at intake (restoration crew); date to be arranged with the client";

export const RESTORATION_INSPECTION_TEXT_EVENT = "restoration_inspection_trade_texted";
export const RESTORATION_INSPECTION_WORK_ORDER_EVENT = "restoration_inspection_work_order_set";

const SCOPE_LINE =
  "Attend site with Marnin: moisture inspection, readings, photos and room scan for the report and quote";

export interface RestorationInspectionContext {
  jobId: string;
  orgId: string | null;
  jobNumber: string | null;
  siteAddress: string | null;
  suburb: string | null;
  builderReference: string | null;
  builderPoNumber: string | null;
  clientName?: string | null;
  clientPhone?: string | null;
}

export interface RestorationInspectionTrade {
  id: string;
  name: string;
  phone: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Pure. "1 Smith St, Nollamara" without repeating a suburb already in the address. */
export function restorationInspectionSite(
  siteAddress: string | null,
  suburb: string | null,
): string {
  const address = text(siteAddress);
  const sub = text(suburb);
  if (!address) return sub;
  if (!sub || address.toLowerCase().includes(sub.toLowerCase())) return address;
  return `${address}, ${sub}`;
}

/** Pure. "MLB-41342 / PO-65390", without repeating a PO already in the reference. */
export function restorationInspectionReference(
  builderReference: string | null,
  builderPoNumber: string | null,
): string {
  const ref = text(builderReference);
  const po = text(builderPoNumber);
  if (!po) return ref;
  const poDigits = po.replace(/\D/g, "");
  if (ref && poDigits && ref.replace(/\D/g, "").includes(poDigits)) return ref;
  return ref ? `${ref} / ${po}` : po;
}

/** Pure. The work order fields for the inspection visit. */
export function buildRestorationInspectionWorkOrder(
  ctx: RestorationInspectionContext,
  trade: RestorationInspectionTrade,
): {
  scope_items: Array<{ description: string; quantity: number; unit: string }>;
  agreed_labour_ex: number;
  site_address: string | null;
  special_instructions: string;
} {
  const reference = restorationInspectionReference(ctx.builderReference, ctx.builderPoNumber);
  const site = restorationInspectionSite(ctx.siteAddress, ctx.suburb);
  const instructions = [
    `${trade.name}: ${RESTORATION_INSPECTION_HOURS} hours, inspection for the report and quote.`,
    reference ? `Builder ref ${reference}.` : "",
  ].filter(Boolean).join(" ");
  return {
    scope_items: [{
      description: SCOPE_LINE,
      quantity: RESTORATION_INSPECTION_HOURS,
      unit: "hours",
    }],
    agreed_labour_ex: RESTORATION_INSPECTION_AGREED_EX,
    site_address: site || null,
    special_instructions: instructions,
  };
}

/** Pure. The text the trade gets when the job comes through. */
export function buildRestorationInspectionText(
  ctx: RestorationInspectionContext,
  trade: RestorationInspectionTrade,
  workOrderApproved: boolean,
): string {
  const first = text(trade.name).split(/\s+/)[0] || "Hi";
  const site = restorationInspectionSite(ctx.siteAddress, ctx.suburb);
  const reference = restorationInspectionReference(ctx.builderReference, ctx.builderPoNumber);
  const client = [text(ctx.clientName), text(ctx.clientPhone)].filter(Boolean).join(", ");
  return [
    `Hi ${first}, new restoration job ${ctx.jobNumber || ""} for you and Marnin.`.replace(/\s+/g, " "),
    site ? `Site: ${site}` : "",
    client ? `Client: ${client}` : "",
    reference ? `Builder ref: ${reference}` : "",
    "Job: moisture inspection, readings, photos and room scan for the report and quote.",
    "Please call the client to arrange a time, then book the date in the Trade App.",
    workOrderApproved
      ? `Your work order is approved: ${RESTORATION_INSPECTION_HOURS} hours ($${RESTORATION_INSPECTION_AGREED_EX}).`
      : "",
    `Open in Trade: https://secureworks-group.github.io/secureworks-ux/trade.html#job/${ctx.jobId}`,
  ].filter(Boolean).join("\n");
}

export interface RestorationInspectionDeps {
  sendSms: (
    phone: string,
    message: string,
    recipient: { role: "crew"; aboutJobId: string },
  ) => Promise<{ accepted: boolean; messageId: string | null; failureReason: string | null }>;
}

const WO_COLUMNS = "id, job_id, kind, status, wo_number, agreed_labour_ex, updated_at";

async function readOpenJobWorkOrder(client: any, jobId: string): Promise<any | null> {
  const { data, error } = await client.from("work_orders").select(WO_COLUMNS)
    .eq("job_id", jobId).eq("kind", "job");
  if (error) throw new Error(`work order read failed: ${error.message || error}`);
  const rows = (data || []).filter((r: any) => r.status === "draft" || r.status === "approved");
  return rows.find((r: any) => r.status === "approved") || rows[0] || null;
}

/**
 * WRITE. Fill and approve the inspection work order. Leaves an approved work
 * order alone (it was set by hand), and leaves a draft someone already wrote
 * into alone too. Returns what it did.
 */
export async function fillRestorationInspectionWorkOrder(
  client: any,
  ctx: RestorationInspectionContext,
  trade: RestorationInspectionTrade,
): Promise<{ state: "approved" | "already_approved" | "draft_in_use" | "saved_not_approved"; workOrderId: string | null; reason?: string }> {
  let wo = await readOpenJobWorkOrder(client, ctx.jobId);
  if (!wo) {
    const { error } = await client.rpc("ensure_job_work_order_draft", {
      p_job_id: ctx.jobId,
      p_origin: "manual",
    });
    if (error) throw new Error(`work order could not be opened: ${error.message || error}`);
    wo = await readOpenJobWorkOrder(client, ctx.jobId);
    if (!wo) throw new Error("work order could not be opened");
  }
  if (wo.status === "approved") return { state: "already_approved", workOrderId: wo.id };
  if (wo.agreed_labour_ex !== null && wo.agreed_labour_ex !== undefined) {
    return { state: "draft_in_use", workOrderId: wo.id };
  }

  const fields = buildRestorationInspectionWorkOrder(ctx, trade);
  const { data: patched, error: patchError } = await client.from("work_orders")
    .update(fields)
    .eq("id", wo.id).eq("kind", "job").eq("status", "draft")
    .select(WO_COLUMNS).maybeSingle();
  if (patchError) throw new Error(`work order save failed: ${patchError.message || patchError}`);
  if (!patched) return { state: "draft_in_use", workOrderId: wo.id, reason: "draft changed" };

  const { error: approveError } = await client.rpc("approve_job_work_order_by_agent", {
    p_work_order_id: patched.id,
    p_actor: RESTORATION_INSPECTION_ACTOR,
    p_approved_by_name: RESTORATION_INSPECTION_APPROVED_BY_NAME,
    p_expected_updated_at: patched.updated_at,
    p_org_id: ctx.orgId,
  });
  const approved = !approveError;
  try {
    await client.from("job_events").insert({
      job_id: ctx.jobId,
      event_type: RESTORATION_INSPECTION_WORK_ORDER_EVENT,
      detail_json: {
        work_order_id: patched.id,
        wo_number: patched.wo_number || null,
        trade_user_id: trade.id,
        agreed_labour_ex: RESTORATION_INSPECTION_AGREED_EX,
        approved,
        approved_by_name: approved ? RESTORATION_INSPECTION_APPROVED_BY_NAME : null,
        refusal: approved ? null : String(approveError?.message || "refused").slice(0, 300),
      },
    });
  } catch (_e) { /* the work order is the record; the event is the audit */ }
  return approved
    ? { state: "approved", workOrderId: patched.id }
    : {
      state: "saved_not_approved",
      workOrderId: patched.id,
      reason: String(approveError?.message || "refused"),
    };
}

/**
 * WRITE. Text the trade once per job. The claim (a job event) is written
 * before the send, so a retry finds it and sends nothing.
 */
export async function textRestorationInspectionTrade(
  client: any,
  ctx: RestorationInspectionContext,
  trade: RestorationInspectionTrade,
  workOrderApproved: boolean,
  deps: RestorationInspectionDeps,
): Promise<{ state: "sent" | "already_texted" | "no_phone" | "not_accepted" | "claim_failed"; reason?: string }> {
  const phone = text(trade.phone);
  if (!phone) return { state: "no_phone" };
  const { data: prior, error: priorError } = await client.from("job_events")
    .select("id").eq("job_id", ctx.jobId).eq("event_type", RESTORATION_INSPECTION_TEXT_EVENT)
    .limit(1);
  if (priorError) return { state: "claim_failed", reason: "prior text unreadable" };
  if (Array.isArray(prior) && prior.length) return { state: "already_texted" };

  const message = buildRestorationInspectionText(ctx, trade, workOrderApproved);
  const { error: claimError } = await client.from("job_events").insert({
    job_id: ctx.jobId,
    event_type: RESTORATION_INSPECTION_TEXT_EVENT,
    detail_json: { trade_user_id: trade.id, state: "claimed" },
  });
  if (claimError) return { state: "claim_failed", reason: String(claimError.message || claimError) };

  const result = await deps.sendSms(phone, message, { role: "crew", aboutJobId: ctx.jobId });
  try {
    await client.from("job_events").insert({
      job_id: ctx.jobId,
      event_type: `${RESTORATION_INSPECTION_TEXT_EVENT}_result`,
      detail_json: {
        trade_user_id: trade.id,
        accepted: result.accepted,
        message_id: result.messageId,
        failure_reason: result.failureReason,
      },
    });
  } catch (_e) { /* best effort audit */ }
  return result.accepted
    ? { state: "sent" }
    : { state: "not_accepted", reason: result.failureReason || "not accepted" };
}

/** WRITE. Both steps for a freshly minted restoration card. Never throws. */
export async function runRestorationInspectionIntake(
  client: any,
  ctx: RestorationInspectionContext,
  crew: ReadonlyArray<{ id: string; name: string; email?: string | null; phone?: string | null }>,
  deps: RestorationInspectionDeps,
): Promise<Record<string, unknown>> {
  const member = crew.find((m) =>
    text(m.email).toLowerCase() === RESTORATION_INSPECTION_TRADE_EMAIL
  );
  if (!member) return { skipped: "inspection_trade_not_booked" };
  const trade: RestorationInspectionTrade = {
    id: member.id,
    name: member.name,
    phone: member.phone ?? null,
  };
  let workOrder: any = null;
  try {
    workOrder = await fillRestorationInspectionWorkOrder(client, ctx, trade);
  } catch (e: any) {
    console.error("[ops-api] restoration inspection work order failed for", ctx.jobNumber, e?.message || e);
    workOrder = { state: "failed", reason: String(e?.message || e) };
  }
  const approved = workOrder?.state === "approved" || workOrder?.state === "already_approved";
  let textResult: any = null;
  try {
    textResult = await textRestorationInspectionTrade(client, ctx, trade, approved, deps);
  } catch (e: any) {
    console.error("[ops-api] restoration inspection text failed for", ctx.jobNumber, e?.message || e);
    textResult = { state: "failed", reason: String(e?.message || e) };
  }
  return { work_order: workOrder, text: textResult };
}
