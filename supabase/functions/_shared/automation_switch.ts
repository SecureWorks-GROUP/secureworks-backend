export const LANE_ANSWER_TTL_MS = 45_000;
type LaneAnswer = { value: boolean; at: number };
const sharedLaneAnswers = new Map<string, LaneAnswer>();
const perClientLaneAnswers = new WeakMap<object, Map<string, LaneAnswer>>();
function laneAnswers(client: object): Map<string, LaneAnswer> {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") return sharedLaneAnswers;
  let m = perClientLaneAnswers.get(client);
  if (!m) {
    m = new Map();
    perClientLaneAnswers.set(client, m);
  }
  return m;
}
export function _resetAutomationLaneCacheForTest(): void {
  sharedLaneAnswers.clear();
}

/** Strict boolean RPC read, remembered for 45 seconds per lane (never an error): missing schema and transport errors stop the lane. */
export async function automationLaneEnabled(
  client: {
    rpc: (
      name: string,
      args: { lane: string },
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  lane: "capture" | "attribution" | "extraction" | "closeout",
  nowMs: number = Date.now(),
): Promise<boolean> {
  const store = laneAnswers(client as object);
  const hit = store.get(lane);
  if (hit && nowMs - hit.at < LANE_ANSWER_TTL_MS) return hit.value;
  try {
    const { data, error } = await client.rpc("automation_lane_enabled", {
      lane,
    });
    if (error) return false;
    const value = data === true;
    store.set(lane, { value, at: nowMs });
    return value;
  } catch {
    return false;
  }
}

export function contextActionLane(
  action: string,
): "capture" | "attribution" | null {
  if (
    ["backfill_ghl_conversations", "backfill_call_transcripts"].includes(action)
  ) return "capture";
  return null;
}
