// deno-lint-ignore-file no-explicit-any
// P0-12.5: server-only cache writes with a verified job identity.
export async function syncConversationCache(
  client: any,
  body: any,
  caller: { method: string; serverCaller: boolean },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fail = (status: number, code: string) => ({
    status,
    body: { ok: false, code },
  });
  if (caller.method !== "POST") return fail(405, "POST_REQUIRED");
  if (!caller.serverCaller) return fail(403, "SERVER_KEY_REQUIRED");
  if (
    typeof body?.contact_id !== "string" || !body.contact_id.trim() ||
    !Array.isArray(body.messages) || body.messages.length > 2000
  ) {
    return fail(400, "INVALID_CACHE_INPUT");
  }

  const contactId = body.contact_id;
  const messages = body.messages;
  const jobValue = body.job_id || body.job_number;
  let jobId: string | null = null;
  if (jobValue) {
    const isUuid = typeof jobValue === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        jobValue,
      );
    const { data, error } = await client.from("jobs").select("id")
      .eq(
        isUuid ? "id" : "job_number",
        isUuid ? jobValue : String(jobValue).toUpperCase(),
      )
      .maybeSingle();
    if (error) return fail(500, "JOB_LOOKUP_FAILED");
    if (!data) return fail(422, "JOB_NOT_FOUND");
    jobId = data.id;
  }

  const { data: existing, error: readError } = await client.from(
    "ghl_conversation_cache",
  )
    .select("id").eq("contact_id", contactId).limit(1).maybeSingle();
  if (readError) return fail(500, "CACHE_READ_FAILED");
  const row = {
    job_id: jobId,
    messages,
    message_count: messages.length,
    synced_at: new Date().toISOString(),
  };
  try {
    const { error } = existing
      ? await client.from("ghl_conversation_cache").update(row).eq(
        "id",
        existing.id,
      )
      : await client.from("ghl_conversation_cache").insert({
        contact_id: contactId,
        ...row,
      });
    if (error) return fail(500, "CACHE_WRITE_FAILED");
  } catch {
    return fail(500, "CACHE_WRITE_FAILED");
  }

  // Keep evidence best-effort as in the agent tool, after the durable cache write.
  // New evidence uses the canonical writer, which owns capture policy and time.
  try {
    const { data, error } = await client.rpc("capture_business_event", {
      p_row: {
        provider_message_id: `conversation-sync:${crypto.randomUUID()}`,
        event_type: "conversation.synced",
        source: "mcp_agent",
        entity_type: "ghl_conversation",
        entity_id: contactId,
        job_id: jobId,
        payload: {
          tool: "sw_sync_conversation",
          contact_id: contactId,
          message_count: messages.length,
          sent_by: "graf",
        },
        metadata: { capture_mode: "live" },
      },
    });
    if (error || data?.outcome === "error") {
      console.error("[conversation-cache] sync evidence failed");
    }
  } catch {
    console.error("[conversation-cache] sync evidence failed");
  }
  return {
    status: 200,
    body: {
      ok: true,
      contact_id: contactId,
      job_id: jobId,
      message_count: messages.length,
    },
  };
}
