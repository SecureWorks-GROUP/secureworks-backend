import { automationLaneEnabled } from "../automation_switch.ts";

export class CaptureDisabledError extends Error {
  constructor() { super("evidence capture disabled or unavailable"); this.name = "CaptureDisabledError"; }
}

// Uncached checks apply even when the older feature flag is bypassed.
// deno-lint-ignore no-explicit-any
export async function assertCaptureEnabled(client: any): Promise<void> {
  if (!(await automationLaneEnabled(client, "capture"))) throw new CaptureDisabledError();
}

/** Evidence-only guard: callers continue their ordinary business operation. */
// deno-lint-ignore no-explicit-any
export async function insertCapturedEvidence(client: any, row: unknown): Promise<any> {
  if (!(await automationLaneEnabled(client, "capture"))) {
    return { data: null, error: null, skipped: true };
  }
  return await client.from("business_events").insert(row);
}
