export function withoutPairedLegacyCallRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  additionalPairedLegacyIds: ReadonlySet<string> = new Set(),
): T[] {
  const pairedLegacyIds = new Set(additionalPairedLegacyIds);
  for (const row of rows) {
    if (row.event_type !== "client.call_logged") continue;
    const payload = row.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const id = (payload as Record<string, unknown>).legacy_event_id;
    if (typeof id === "string" && id.trim()) pairedLegacyIds.add(id.trim());
  }
  return rows.filter((row) =>
    row.event_type !== "client.call_complete" ||
    typeof row.id !== "string" || !pairedLegacyIds.has(row.id)
  );
}

export async function filterPairedLegacyCallRows<T extends Record<string, unknown>>(
  client: any,
  rows: readonly T[],
): Promise<T[]> {
  const legacyIds = rows.flatMap((row) =>
    row.event_type === "client.call_complete" && typeof row.id === "string"
      ? [row.id]
      : []
  );
  if (legacyIds.length === 0) return withoutPairedLegacyCallRows(rows);

  const pairedLegacyIds = new Set<string>();
  for (let offset = 0; offset < legacyIds.length; offset += 25) {
    const chunk = legacyIds.slice(offset, offset + 25);
    const { data, error } = await client.from("business_events")
      .select("payload")
      .eq("event_type", "client.call_logged")
      .in("payload->>legacy_event_id", chunk);
    if (error) throw new Error(`paired GHL call lookup failed: ${error.message}`);
    for (const row of data || []) {
      const payload = row?.payload;
      const id = payload && typeof payload === "object" &&
          !Array.isArray(payload)
        ? (payload as Record<string, unknown>).legacy_event_id
        : null;
      if (typeof id === "string" && id.trim()) pairedLegacyIds.add(id.trim());
    }
  }
  return withoutPairedLegacyCallRows(rows, pairedLegacyIds);
}
