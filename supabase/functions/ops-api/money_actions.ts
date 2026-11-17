// deno-lint-ignore-file no-explicit-any
// P4-09.2: a server request waits for a person's press when the gate is on.
const issuedWorkOrder = (body: any) =>
  ["sent", "accepted", "complete", "completed", "approved"].includes(
    String(body?.status ?? body?.state ?? "").toLowerCase(),
  );
export const MONEY_ACTIONS: Record<
  string,
  { kind: string; onlyWhen?: (body: any) => boolean }
> = {
  approve_invoice: { kind: "xero_approve" },
  approve_and_send_invoice: { kind: "xero_approve" },
  void_invoice: { kind: "xero_void" },
  reconcile_payment: { kind: "xero_payment" },
  create_deposit_invoice: { kind: "customer_invoice" },
  complete_and_invoice: { kind: "customer_invoice" },
  send_acceptance_invoice: { kind: "customer_invoice" },
  send_payment_link: { kind: "send" },
  email_po: { kind: "send" },
  create_po: { kind: "order" },
  push_po_to_xero: { kind: "order" },
  update_po: { kind: "order" },
  scope_to_po: { kind: "order" },
  approve_expense: { kind: "expense" },
  push_expense_to_xero: { kind: "expense" },
  approve_variation: { kind: "variation" },
  create_work_order: { kind: "work_order_state", onlyWhen: issuedWorkOrder },
  update_work_order: { kind: "work_order_state", onlyWhen: issuedWorkOrder },
};
export function isMoneyAction(action: string, body: any): boolean {
  const rule = Object.hasOwn(MONEY_ACTIONS, action)
    ? MONEY_ACTIONS[action]
    : undefined;
  return !!rule && (!rule.onlyWhen || rule.onlyWhen(body));
}
function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value).sort().map((k) =>
        `${JSON.stringify(k)}:${canonicalJson(value[k])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
export async function paramsSha256(action: string, body: any): Promise<string> {
  const jsonBody = JSON.parse(JSON.stringify(body));
  const bytes = new TextEncoder().encode(
    `${action}\n${canonicalJson(jsonBody)}`,
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function proposalSummary(action: string, body: any): string {
  const field = (name: string) => {
    const value = body?.[name];
    return typeof value === "string" || typeof value === "number"
      ? String(value).slice(0, 160)
      : "";
  };
  const invoice = field("invoice_number") || field("xero_invoice_id") ||
    "the selected invoice";
  const order = field("po_number") || "the selected purchase order";
  const job = field("job_number") || field("job_id") || "the selected job";
  switch (action) {
    case "reconcile_payment": {
      const raw = body?.amount;
      const amount = (typeof raw === "number" || typeof raw === "string") &&
          String(raw).trim() && Number.isFinite(Number(raw))
        ? `$${Number(raw).toFixed(2)}`
        : "the requested amount";
      return `Record a payment of ${amount} against invoice ${invoice}.`;
    }
    case "approve_invoice":
      return `Approve invoice ${invoice} in Xero.`;
    case "approve_and_send_invoice":
      return `Approve and send invoice ${invoice}.`;
    case "void_invoice":
      return `Void invoice ${invoice} in Xero.`;
    case "email_po":
      return `Email purchase order ${order} to the supplier.`;
    case "send_payment_link":
      return `Send the payment link for ${invoice}${
        field("to") ? ` to ${field("to")}` : ""
      }.`;
    case "create_deposit_invoice":
      return `Create a deposit invoice for job ${job}.`;
    case "complete_and_invoice":
      return `Complete and invoice job ${job}.`;
    case "send_acceptance_invoice":
      return `Send the acceptance invoice for job ${job}.`;
    case "create_po":
      return `Create a purchase order for job ${job}.`;
    case "update_po":
      return `Update purchase order ${order}.`;
    case "push_po_to_xero":
      return `Push purchase order ${order} to Xero.`;
    case "scope_to_po":
      return `Create purchase orders from the scope for job ${job}.`;
    case "approve_expense":
      return `Approve the expense for job ${job}.`;
    case "push_expense_to_xero":
      return `Push the expense for job ${job} to Xero.`;
    case "approve_variation":
      return `Approve the variation for job ${job}.`;
    case "create_work_order":
      return `Create the work order for job ${job}${
        field("status") ? ` as ${field("status")}` : ""
      }.`;
    case "update_work_order":
      return `Update the work order for job ${job}${
        field("status") ? ` to ${field("status")}` : ""
      }.`;
    default:
      return "Request a money action.";
  }
}
export type MoneyProposalInput = {
  action: string;
  method: string;
  body: any;
  actor: string;
  authMode: string;
  status: "pending" | "observed";
};
export async function proposeMoneyAction(
  client: any,
  input: MoneyProposalInput,
): Promise<string> {
  const hash = await paramsSha256(input.action, input.body);
  const { data, error } = await client.from("agent_action_proposals").insert({
    actor: input.actor || "actor_missing",
    auth_mode: input.authMode,
    action: input.action,
    http_method: input.method,
    params: input.body,
    params_sha256: hash,
    job_id: input.body?.job_id || null,
    kind: MONEY_ACTIONS[input.action].kind,
    summary: proposalSummary(input.action, input.body),
    status: input.status,
  }).select("id").single();
  if (!error && data?.id) return data.id;
  if (error?.code === "23505" && input.status === "pending") {
    const existing = await client.from("agent_action_proposals").select("id")
      .eq("action", input.action).eq("params_sha256", hash).eq(
        "status",
        "pending",
      ).maybeSingle();
    if (!existing.error && existing.data?.id) return existing.data.id;
  }
  throw new Error("money_proposal_store_failed");
}
export type MoneyActionFlags = { press: boolean; observe: boolean };
let flagCache: { until: number; flags: MoneyActionFlags } | undefined;
let flagRead: Promise<MoneyActionFlags> | undefined;
export async function readMoneyActionFlags(
  client: any,
  now = Date.now(),
): Promise<MoneyActionFlags> {
  if (flagCache && flagCache.until > now) return flagCache.flags;
  if (flagRead) return await flagRead;
  flagRead = (async () => {
    let flags: MoneyActionFlags = { press: false, observe: false };
    try {
      const { data, error } = await client.from("feature_flags").select(
        "flag_name,enabled",
      )
        .in("flag_name", [
          "agent_money_press_v1",
          "agent_money_press_observe_v1",
        ]);
      if (!error && Array.isArray(data)) {
        flags = {
          press: data.some((r: any) =>
            r.flag_name === "agent_money_press_v1" && r.enabled === true
          ),
          observe: data.some((r: any) =>
            r.flag_name === "agent_money_press_observe_v1" && r.enabled === true
          ),
        };
      }
    } catch { /* An unreadable switch is off. */ }
    flagCache = { until: now + 30_000, flags };
    return flags;
  })();
  try {
    return await flagRead;
  } finally {
    flagRead = undefined;
  }
}
export async function moneyActionGate(
  client: any,
  input: Omit<MoneyProposalInput, "status"> & { fromPerson: boolean },
  flags: MoneyActionFlags,
): Promise<{ status: number; body: any } | null> {
  if (input.fromPerson || !isMoneyAction(input.action, input.body)) return null;
  if (flags.press) {
    const proposal_id = await proposeMoneyAction(client, {
      ...input,
      status: "pending",
    });
    console.log(
      JSON.stringify({
        event: "money_action_proposed",
        action: input.action,
        proposal_id,
      }),
    );
    return {
      status: 202,
      body: {
        ok: true,
        proposal: true,
        proposal_id,
        status: "pending",
        changed: false,
        message:
          "Nothing has changed. A signed-in person must press Carry out in Ops, under Waiting for a press.",
      },
    };
  }
  if (flags.observe) {
    try {
      const proposal_id = await proposeMoneyAction(client, {
        ...input,
        status: "observed",
      });
      console.log(
        JSON.stringify({
          event: "money_action_observed",
          action: input.action,
          proposal_id,
        }),
      );
    } catch { /* Observation must not interrupt the existing action. */ }
  }
  return null;
}
