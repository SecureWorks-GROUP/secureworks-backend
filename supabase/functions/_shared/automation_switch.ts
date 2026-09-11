/** Uncached, strict boolean RPC read: missing schema and transport errors stop the lane. */
export async function automationLaneEnabled(
  client: { rpc: (name: string, args: { lane: string }) => PromiseLike<{ data: unknown; error: unknown }> },
  lane: 'capture' | 'attribution' | 'extraction',
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc('automation_lane_enabled', { lane })
    return !error && data === true
  } catch {
    return false
  }
}

export function contextActionLane(action: string): 'capture' | 'attribution' | null {
  if (['backfill_ghl_conversations', 'backfill_call_transcripts'].includes(action)) return 'capture'
  return null
}
