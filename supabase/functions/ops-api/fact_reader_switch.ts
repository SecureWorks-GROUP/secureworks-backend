// A missing or unreadable retirement switch preserves the existing readers.
let cached: { on: boolean; until: number } | undefined;

export async function factReadOn(client: any): Promise<boolean> {
  const now = Date.now();
  if (cached && now < cached.until) return cached.on;
  let on = true;
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled").eq("flag_name", "context_fact_read_v1").maybeSingle();
    if (!error && data?.enabled === false) on = false;
  } catch {
    // Keep today's behaviour if the switch cannot be read.
  }
  cached = { on, until: now + 60_000 };
  return on;
}
