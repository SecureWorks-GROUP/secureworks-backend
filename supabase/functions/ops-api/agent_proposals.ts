// deno-lint-ignore-file no-explicit-any
import { paramsSha256 } from "./money_actions.ts";

const LIST_COLUMNS =
  "id,created_at,actor,action,kind,summary,job_id,status,decided_by,decided_at,expires_at,error";
const OFFICE_KINDS = new Set([
  "send",
  "order",
  "expense",
  "variation",
  "customer_invoice",
  "work_order_state",
]);
const XERO_KINDS = new Set(["xero_approve", "xero_void", "xero_payment"]);
export type AgentProposalRequest = {
  action: string;
  method: string;
  body: any;
  query: URLSearchParams;
  authMode: string;
  user?: { id: string; role: string } | null;
  staff: boolean;
  url: string;
  headers: Headers;
};
function decisionLog(id: string, decision: string, user: string) {
  console.log(
    JSON.stringify({
      event: "agent_proposal_decided",
      id,
      decision,
      user_id: user,
    }),
  );
}
export async function agentProposalAction(
  client: any,
  input: AgentProposalRequest,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; body: any }> {
  const answer = (status: number, body: any) => ({ status, body });
  if (input.authMode !== "jwt" || !input.user) {
    return answer(401, { error: "Sign in to decide a proposal." });
  }
  if (!input.staff) return answer(403, { error: "Staff access is required." });
  const user = input.user;
  const list = input.action === "list_agent_proposals";
  if (input.method !== (list ? "GET" : "POST")) {
    return answer(405, { error: list ? "Use GET." : "Use POST." });
  }
  if (list) {
    const expired = await client.rpc("agent_action_proposals_expire");
    if (expired.error) throw new Error("proposal_expiry_failed");
    const raw = Number(input.query.get("limit") || 50);
    const limit = Number.isFinite(raw)
      ? Math.min(100, Math.max(1, Math.floor(raw)))
      : 50;
    const { data, error } = await client.from("agent_action_proposals").select(
      LIST_COLUMNS,
    )
      .eq("status", input.query.get("status") || "pending").order(
        "created_at",
        { ascending: false },
      ).limit(limit);
    if (error) throw new Error("proposal_list_failed");
    return answer(200, { proposals: data || [] });
  }
  const id = input.body?.proposal_id;
  if (typeof id !== "string" || !id) {
    return answer(400, { error: "proposal_id is required." });
  }
  if (input.action === "decline_agent_proposal") {
    const reason = typeof input.body?.reason === "string"
      ? input.body.reason.trim()
      : "";
    if (reason.length < 3 || reason.length > 300) {
      return answer(400, { error: "Give a reason of 3 to 300 characters." });
    }
    const { data, error } = await client.from("agent_action_proposals").update({
      status: "declined",
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decline_reason: reason,
    }).eq("id", id).eq("status", "pending").select("id").maybeSingle();
    if (error) throw new Error("proposal_decline_failed");
    if (!data?.id) {
      return answer(409, { error: "Someone has already decided this one." });
    }
    decisionLog(id, "declined", user.id);
    return answer(200, { ok: true, status: "declined" });
  }
  const loaded = await client.from("agent_action_proposals").select("*").eq(
    "id",
    id,
  ).maybeSingle();
  if (loaded.error) throw new Error("proposal_read_failed");
  const row = loaded.data;
  if (!row) return answer(404, { error: "Proposal not found." });
  const role = String(user.role).toLowerCase();
  const mayPress = (["admin", "owner"].includes(role) &&
    (XERO_KINDS.has(row.kind) || OFFICE_KINDS.has(row.kind))) ||
    (role === "ops_manager" && OFFICE_KINDS.has(row.kind));
  if (!mayPress) {
    return answer(403, {
      error: "You do not have permission for this one. Ask an admin.",
    });
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    const expired = await client.from("agent_action_proposals").update({
      status: "expired",
    }).eq("id", id).eq("status", "pending").select("id").maybeSingle();
    if (expired.error) throw new Error("proposal_expiry_failed");
    return answer(410, { error: "This one has expired. Ask the agent again." });
  }
  if (row.status !== "pending") {
    return answer(409, { error: "Someone has already decided this one." });
  }
  if (await paramsSha256(row.action, row.params) !== row.params_sha256) {
    const failed = await client.from("agent_action_proposals").update({
      status: "failed",
      error: "params_changed",
    })
      .eq("id", id).eq("status", "pending").select("id").maybeSingle();
    if (failed.error) throw new Error("proposal_failure_store_failed");
    if (failed.data?.id) decisionLog(id, "failed", user.id);
    return answer(409, { error: "params_changed" });
  }
  const claimed = await client.rpc("agent_action_proposal_claim", {
    p_id: id,
    p_user: user.id,
  });
  if (claimed.error) throw new Error("proposal_claim_failed");
  const claim = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  if (!claim?.id) {
    return answer(409, { error: "Someone has already decided this one." });
  }
  // The claim owns the only attempt. An uncertain transport is never retried.
  let status: "carried_out" | "failed" = "failed";
  let result: any;
  let error = "self_call_outcome_unknown";
  let refused = false;
  try {
    const url = new URL(input.url);
    url.search = "";
    url.searchParams.set("action", claim.action);
    const headers = new Headers({
      "Content-Type": "application/json",
      "x-sw-proposal-id": id,
    });
    for (const name of ["Authorization", "apikey"]) {
      const value = input.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const response = await fetcher(url.toString(), {
      method: claim.http_method,
      headers,
      body: JSON.stringify(claim.params),
    });
    const text = await response.text();
    if (response.ok) {
      status = "carried_out";
      try {
        result = JSON.parse(text);
      } catch {
        result = { text };
      }
      if (JSON.stringify(result).length > 20_000) {
        result = { truncated: true, text: text.slice(0, 3000) };
      }
    } else {
      error = `${response.status}: ${text.slice(0, 500)}`;
      refused = response.status === 400;
    }
  } catch { /* A lost response cannot be asserted to have changed nothing. */ }
  const saved = await client.from("agent_action_proposals").update(
    status === "carried_out" ? { status, result } : { status, error },
  )
    .eq("id", id).eq("status", "carrying_out").select("id").maybeSingle();
  if (saved.error || !saved.data?.id) {
    throw new Error("proposal_outcome_store_failed");
  }
  decisionLog(id, status, user.id);
  return status === "carried_out"
    ? answer(200, { ok: true, status, result })
    : answer(502, {
      ok: false,
      status,
      error,
      ...(refused
        ? {
          changed: false,
          message: `Could not be done: ${error}. Nothing was changed.`,
        }
        : {
          message:
            "The action could not be confirmed. Check its records before asking again.",
        }),
    });
}
