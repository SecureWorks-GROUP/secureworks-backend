import { ContextMailError } from "./context_mail.ts";

function actor(
  authMode: string,
  authUser: { id?: string; orgId?: string } | null,
  expectedOrgId: string,
  bodyActor?: unknown,
) {
  if (authMode === "jwt") {
    if (!authUser?.id) throw new ContextMailError(401, "named operator required");
    if (authUser.orgId && authUser.orgId !== expectedOrgId) {
      throw new ContextMailError(403, "operator organisation mismatch");
    }
    return authUser.id;
  }
  const a = String(bodyActor || "").trim();
  if (!a) throw new ContextMailError(400, "actor is required");
  return a;
}

export async function openNeedsScoperItem(
  client: { rpc: Function },
  body: Record<string, unknown>,
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  const who = actor(auth.mode, auth.user, expectedOrgId, body.actor);
  const { data, error } = await client.rpc("open_needs_scoper_item", {
    p_org_id: expectedOrgId,
    p_owner_key: body.owner_key,
    p_contact_id: body.contact_id ?? null,
    p_job_id: body.job_id ?? null,
    p_opportunity_id: body.opportunity_id ?? null,
    p_conversation_id: body.conversation_id,
    p_channel: body.channel ?? "ghl",
    p_question: body.question,
    p_context: body.context ?? null,
    p_dash_link: body.dash_link ?? null,
    p_actor: who,
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}

export async function notifyNeedsScoper(
  client: { rpc: Function },
  body: Record<string, unknown>,
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  actor(auth.mode, auth.user, expectedOrgId, body.actor);
  const { data, error } = await client.rpc("notify_needs_scoper", {
    p_item_id: body.item_id,
    p_org_id: expectedOrgId,
    p_from_number: body.from_number || "+61489267771",
    p_body: body.body,
    p_now: body.now ?? new Date().toISOString(),
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}

export async function answerNeedsScoper(
  client: { rpc: Function },
  body: Record<string, unknown>,
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  const who = actor(auth.mode, auth.user, expectedOrgId, body.actor);
  const { data, error } = await client.rpc("answer_needs_scoper", {
    p_item_id: body.item_id,
    p_org_id: expectedOrgId,
    p_answer: body.answer,
    p_proposed_client_reply: body.proposed_client_reply ?? null,
    p_actor: who,
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}
