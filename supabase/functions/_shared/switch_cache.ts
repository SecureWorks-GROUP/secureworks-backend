/**
 * Remembered `feature_flags` reads. Each switch answer is kept for 45 seconds,
 * so a switch turned on or off takes up to 45 seconds to bite everywhere.
 * Inside the edge runtime one store is shared by every client; elsewhere
 * (tests, scripts) each client object has its own. An error or a throw reads
 * as off and is never remembered, as the readers this replaces did.
 */
export const SWITCH_ANSWER_TTL_MS = 45_000;

type SwitchAnswer = { value: boolean; at: number };
const sharedSwitchAnswers = new Map<string, SwitchAnswer>();
let perClientSwitchAnswers = new WeakMap<object, Map<string, SwitchAnswer>>();

function switchAnswers(client: object): Map<string, SwitchAnswer> {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") return sharedSwitchAnswers;
  let m = perClientSwitchAnswers.get(client);
  if (!m) {
    m = new Map();
    perClientSwitchAnswers.set(client, m);
  }
  return m;
}

function fresh(
  store: Map<string, SwitchAnswer>,
  name: string,
  nowMs: number,
): SwitchAnswer | null {
  const hit = store.get(name);
  return hit && nowMs - hit.at < SWITCH_ANSWER_TTL_MS ? hit : null;
}

/** Forgets every remembered answer, shared and per client (tests that flip a switch). */
export function _resetSwitchCacheForTest(): void {
  sharedSwitchAnswers.clear();
  perClientSwitchAnswers = new WeakMap();
}

export async function readSwitch(
  // deno-lint-ignore no-explicit-any
  client: any,
  name: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const store = switchAnswers(client as object);
  const hit = fresh(store, name, nowMs);
  if (hit) return hit.value;
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", name).limit(1);
    if (error) return false;
    const value = data?.[0]?.enabled === true;
    store.set(name, { value, at: nowMs });
    return value;
  } catch {
    return false;
  }
}

export async function readSwitches(
  // deno-lint-ignore no-explicit-any
  client: any,
  names: string[],
  nowMs: number = Date.now(),
): Promise<Record<string, boolean>> {
  const store = switchAnswers(client as object);
  const out: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const hit = fresh(store, name, nowMs);
    if (hit) out[name] = hit.value;
    else missing.push(name);
  }
  if (missing.length === 0) return out;
  try {
    const { data, error } = await client.from("feature_flags")
      .select("flag_name, enabled").in("flag_name", missing);
    if (error) {
      for (const name of missing) out[name] = false;
      return out;
    }
    const on = new Set<string>();
    for (const row of Array.isArray(data) ? data : []) {
      if (row?.enabled === true && typeof row.flag_name === "string") {
        on.add(row.flag_name);
      }
    }
    for (const name of missing) {
      const value = on.has(name);
      store.set(name, { value, at: nowMs });
      out[name] = value;
    }
  } catch {
    for (const name of missing) out[name] = false;
  }
  return out;
}
