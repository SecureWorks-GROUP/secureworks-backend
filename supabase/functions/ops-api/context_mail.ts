// Canonical mail-occurrence producer, reader and correction at the ops-api door.
// Actor and org come from the authenticated server boundary, not the body.

export class ContextMailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function requireActor(
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
    return { actor: authUser.id, orgId: expectedOrgId };
  }
  const actor = String(bodyActor || "").trim();
  if (!actor) throw new ContextMailError(400, "actor is required");
  return { actor, orgId: expectedOrgId };
}

export async function recordContextMailOccurrence(
  client: { rpc: Function },
  body: Record<string, unknown>,
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  const { actor, orgId } = requireActor(auth.mode, auth.user, expectedOrgId, body.actor);
  const mail = body.mail && typeof body.mail === "object" ? body.mail : null;
  if (!mail) throw new ContextMailError(400, "mail occurrence is required");
  const links = Array.isArray(body.links) ? body.links : [];
  const { data, error } = await client.rpc("record_context_mail_occurrence", {
    p_org_id: orgId,
    p_mail: mail,
    p_links: links,
    p_actor: actor,
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}

export async function readMessageWorkLinks(
  client: { rpc: Function },
  params: { event_id?: string },
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  requireActor(auth.mode, auth.user, expectedOrgId, "ops-api");
  if (!params.event_id) throw new ContextMailError(400, "event_id is required");
  const { data, error } = await client.rpc("read_message_work_links", {
    p_org_id: expectedOrgId,
    p_event_id: params.event_id,
  });
  if (error) throw new ContextMailError(500, error.message);
  return data;
}

export async function correctMessageWorkLink(
  client: { rpc: Function },
  body: Record<string, unknown>,
  auth: { mode: string; user: { id?: string; orgId?: string } | null },
  expectedOrgId: string,
) {
  const { actor, orgId } = requireActor(auth.mode, auth.user, expectedOrgId, body.actor);
  const { data, error } = await client.rpc("correct_message_work_link", {
    p_event_id: body.event_id,
    p_org_id: orgId,
    p_op: body.op,
    p_kind: body.kind,
    p_target_id: body.target_id,
    p_actor: actor,
  });
  if (error) throw new ContextMailError(409, error.message);
  return data;
}
