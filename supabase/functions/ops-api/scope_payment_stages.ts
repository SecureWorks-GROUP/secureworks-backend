// The editor seals a schedule. Only named server events consume it. This
// boundary reads persisted stages and records identified staff evidence only.
export async function scopePaymentStagesAction(
  // deno-lint-ignore no-explicit-any
  client: any,
  action: string,
  method: string,
  body: unknown,
  actor: { staff: boolean; orgId: string | null; userId: string | null },
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status });
  if (method !== "POST") return reply({ code: "method_not_allowed" }, 405);
  if (!actor.staff || !actor.orgId) {
    return reply({ code: "operator_access_required" }, 403);
  }
  const confirm = action === "confirm_scope_payment_stage";
  if (confirm && !actor.userId) {
    return reply({ code: "identified_staff_required" }, 403);
  }
  const input = body as Record<string, unknown> | null;
  const allowed = confirm
    ? ["job_id", "scope_revision_id", "stage_id", "evidence_kind", "note"]
    : ["job_id", "scope_revision_id"];
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !input || Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k)) ||
    !uuid.test(String(input.job_id ?? "")) ||
    !uuid.test(String(input.scope_revision_id ?? "")) ||
    confirm && (typeof input.stage_id !== "string" || !input.stage_id ||
        !["work_done", "materials_supplied"].includes(
          String(input.evidence_kind),
        ) ||
        typeof input.note !== "string" || !input.note.trim() ||
        input.note.length > 4000)
  ) {
    return reply({ code: "scope_payment_input_invalid" }, 400);
  }
  const args = {
    p_job_id: input.job_id,
    p_scope_revision_id: input.scope_revision_id,
    p_org_id: actor.orgId,
    ...(confirm
      ? {
        p_actor: actor.userId,
        p_stage_id: input.stage_id,
        p_evidence_kind: input.evidence_kind,
        p_note: input.note,
      }
      : {}),
  };
  const { data, error } = await client.rpc(action, args);
  if (error) {
    const code = String(error.message ?? "");
    const known = /^scope_payment_[a-z_]+$/.test(code);
    return reply(
      { code: known ? code : "scope_payment_unavailable" },
      !known ? 503 : code.endsWith("forbidden") ? 403 : 409,
    );
  }
  return data ? reply(data) : reply({ code: "scope_payment_unavailable" }, 503);
}
