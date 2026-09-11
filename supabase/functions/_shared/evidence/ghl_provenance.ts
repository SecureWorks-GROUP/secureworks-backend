import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { MatchMethod } from "./types.ts";

export function ghlWebhookAuthenticated(headers: Headers, expected: string | undefined): boolean {
  if (!expected) return false;
  const supplied = headers.get("X-Webhook-Secret") || headers.get("authorization");
  return supplied === expected || supplied === `Bearer ${expected}`;
}

export async function resolveGhlExplicitJob(
  client: Pick<SupabaseClient, "from">,
  body: Record<string, unknown>,
): Promise<{ job_id: string | null; match_method: MatchMethod }> {
  const values = (keys: string[]) => [...new Set(keys.flatMap((key) => {
    const value = body[key];
    return typeof value === "string" && value.trim() && !["null", "undefined"].includes(value.trim()) ? [value.trim()] : [];
  }))];
  const ids = values(["supabase_job_id", "job_id", "jobId"]);
  const numbers = values(["job_number", "jobNumber", "jobNo"]);
  const none = { job_id: null, match_method: "none" as MatchMethod };
  if (!ids.length && !numbers.length) return none;
  const resolved = new Set<string>();
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return none;
    const { data, error } = await client.from("jobs").select("id").eq("id", id).limit(2);
    if (error || data?.length !== 1) return none;
    resolved.add(data[0].id);
  }
  for (const number of numbers) {
    const { data, error } = await client.from("jobs").select("id").eq("job_number", number).limit(2);
    if (error || data?.length !== 1) return none;
    resolved.add(data[0].id);
  }
  return resolved.size === 1
    ? { job_id: [...resolved][0], match_method: ids.length ? "direct_job_id" : "direct_reference" }
    : none;
}
