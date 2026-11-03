// deno-lint-ignore-file no-explicit-any
// "Office, please set a work order" (owner, 3 Nov 2026). When a crew member
// cannot invoice a job because it has no work order amount, or cannot find
// the job at all, one email goes to that job's team group mailbox (patios@,
// fencing@) so the office can create the work order. One email per job per
// Perth day. It never blocks or changes the crew's answer.
import { dispatchV2TeamCc } from "./dispatch_v2_emails.ts";
import { perthDate } from "./debt_ws_rules.ts";

export const WORK_ORDER_REQUEST_EVENT = "work_order_amount_requested";
export const WORK_ORDER_REQUEST_FROM_MAILBOX = "admin@secureworkswa.com.au";
const OFFICE_FALLBACK = "admin@secureworkswa.com.au";
const TRADE_JOB_LINK = "https://secureworks-group.github.io/secureworks-ux/trade.html#job/";

export type WorkOrderRequestEmail = {
  to: string;
  subject: string;
  body_html: string;
};
export type WorkOrderRequestSender = (
  email: WorkOrderRequestEmail,
) => Promise<{ ok: boolean; error?: string }>;

export type WorkOrderRequest = {
  jobId?: string | null;
  // Free text when the crew cannot find the job (address, client, job number).
  jobText?: string | null;
  // patio | fencing, used only when there is no job to read the type from.
  team?: string | null;
  crewName: string;
  crewEmail?: string | null;
  reason: "no_work_order_amount" | "cannot_find_job";
};

export function teamMailboxFor(type: unknown): string {
  const t = String(type ?? "").toLowerCase();
  const key = t === "fence" ? "fencing" : t === "patios" ? "patio" : t;
  return dispatchV2TeamCc(key).email ?? OFFICE_FALLBACK;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string
  );

export function workOrderRequestEmail(input: {
  to: string;
  jobNumber: string | null;
  jobId: string | null;
  client: string | null;
  address: string | null;
  jobText: string | null;
  crewName: string;
  crewEmail: string | null;
  reason: WorkOrderRequest["reason"];
}): WorkOrderRequestEmail {
  const what = input.jobNumber || input.jobText || "a job";
  const subject = input.reason === "cannot_find_job"
    ? `Work order needed: ${input.crewName} cannot find ${what}`.slice(0, 200)
    : `Work order needed: ${input.jobNumber || what}`;
  const ask = input.reason === "cannot_find_job"
    ? `${esc(input.crewName)} tried to invoice a job they cannot find in the app.`
    : `${esc(input.crewName)} tried to invoice this job, but it has no work order amount yet, so the app refused the pay.`;
  const rows = [
    input.jobNumber ? `<p><b>Job:</b> ${esc(input.jobNumber)}</p>` : "",
    input.client ? `<p><b>Client:</b> ${esc(input.client)}</p>` : "",
    input.address ? `<p><b>Address:</b> ${esc(input.address)}</p>` : "",
    input.jobText ? `<p><b>What they typed:</b> ${esc(input.jobText)}</p>` : "",
    `<p><b>Crew:</b> ${esc(input.crewName)}${input.crewEmail ? ` (${esc(input.crewEmail)})` : ""}</p>`,
    input.jobId ? `<p><a href="${TRADE_JOB_LINK}${esc(input.jobId)}">Open the job</a></p>` : "",
  ].filter(Boolean).join("\n");
  const body_html = [
    `<p>${ask}</p>`,
    rows,
    `<p>Please set the work order amount for this job. Reply here once it is done so the crew can invoice.</p>`,
  ].join("\n");
  return { to: input.to, subject, body_html };
}

/**
 * Sends the request once per job per Perth day. Returns what happened; never
 * throws for a send failure, so a crew refusal still reads the same.
 */
export async function requestWorkOrderAmount(
  client: any,
  req: WorkOrderRequest,
  deps: { sendEmail: WorkOrderRequestSender; now?: () => Date },
): Promise<{ status: "sent" | "already_sent_today" | "send_failed"; to: string }> {
  const now = deps.now ? deps.now() : new Date();
  const day = perthDate(now);
  let job: any = null;
  if (req.jobId) {
    const { data, error } = await client.from("jobs")
      .select("id, job_number, client_name, site_address, type")
      .eq("id", req.jobId).maybeSingle();
    if (error) throw new Error(`job read failed: ${error.message}`);
    job = data;
  }
  const to = teamMailboxFor(job?.type ?? req.team);
  if (job) {
    const { data: prior, error } = await client.from("job_events")
      .select("id").eq("job_id", job.id).eq("event_type", WORK_ORDER_REQUEST_EVENT)
      .eq("detail_json->>perth_day", day).limit(1);
    if (error) throw new Error(`request history read failed: ${error.message}`);
    if ((prior || []).length > 0) return { status: "already_sent_today", to };
  }
  const email = workOrderRequestEmail({
    to,
    jobNumber: job?.job_number ?? null,
    jobId: job?.id ?? null,
    client: job?.client_name ?? null,
    address: job?.site_address ?? null,
    jobText: req.jobText ? String(req.jobText).slice(0, 300) : null,
    crewName: req.crewName,
    crewEmail: req.crewEmail ?? null,
    reason: req.reason,
  });
  if (job) {
    await client.from("job_events").insert({
      job_id: job.id,
      event_type: WORK_ORDER_REQUEST_EVENT,
      detail_json: { perth_day: day, to, reason: req.reason, crew: req.crewName },
    });
  }
  const sent = await deps.sendEmail(email).catch((e) => ({
    ok: false,
    error: String((e as Error)?.message || e),
  }));
  if (!sent.ok) {
    console.error("[work-order-request] send failed:", sent.error);
    return { status: "send_failed", to };
  }
  return { status: "sent", to };
}

/** Production sender: admin@ through send-outlook-email (Graph). */
export function sendOutlookWorkOrderRequest(
  supabaseUrl: string,
  serviceKey: string,
  fetchImpl: typeof fetch = fetch,
): WorkOrderRequestSender {
  return async (email) => {
    const resp = await fetchImpl(`${supabaseUrl}/functions/v1/send-outlook-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        mailbox: WORK_ORDER_REQUEST_FROM_MAILBOX,
        to: email.to,
        subject: email.subject,
        htmlBody: email.body_html,
      }),
    });
    if (resp.ok) return { ok: true };
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `send-outlook-email ${resp.status}: ${text}`.slice(0, 500) };
  };
}
