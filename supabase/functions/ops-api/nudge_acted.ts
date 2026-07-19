// M0/U4b — follow-up compliance wiring, extracted from index.ts so it is
// unit-testable with a fake client (index.ts calls serve() at import time and
// cannot be imported into a test).
//
// When a proposed action is sent for a job, mark that job's still-open
// (pending/sent) smart_nudges as acted so the follow-up compliance column
// reflects the action. sw_act_nudge stamps acted_at independently of this.

// deno-lint-ignore no-explicit-any
type Client = any;

// Read an arbitrary feature flag, fail-closed. Kept local so U4b does not widen
// the shared EvidenceFlagKey union (feature_flag.ts is Lane A's this mission).
export async function opsFlagOn(client: Client, flagName: string): Promise<boolean> {
  try {
    const { data, error } = await client.from('feature_flags')
      .select('enabled').eq('flag_name', flagName).limit(1)
    if (error) return false
    return Boolean(data?.[0]?.enabled)
  } catch {
    return false
  }
}

// Gated by nudge_acted_from_proposed_v1 (default OFF). Idempotent (only rows
// without acted_at move) and best-effort (never throws into the send path).
export async function markJobNudgesActedFromProposed(
  client: Client,
  jobId: string | null | undefined,
): Promise<void> {
  if (!jobId) return
  if (!(await opsFlagOn(client, 'nudge_acted_from_proposed_v1'))) return
  try {
    await client.from('smart_nudges')
      .update({ status: 'acted', acted_at: new Date().toISOString() })
      .eq('job_id', jobId)
      .in('status', ['pending', 'sent'])
      .is('acted_at', null)
  } catch (e: any) {
    console.error('[ops-api] markJobNudgesActedFromProposed failed:', e?.message)
  }
}
