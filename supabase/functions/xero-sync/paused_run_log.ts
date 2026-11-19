/**
 * A sync_invoices run that reaches Xero's rate-limit pause after its paging
 * (the incremental marker saved, the matcher run) still writes its log row:
 * status 'paused', never 'processed' (a processed row reads as "the run reached
 * its end", 20261103230000), with the matcher's counts and a paused_by_xero
 * mark. Then the same error is thrown again, so the action still answers 429.
 * Only a XeroCooldownError is caught; any other error passes through untouched.
 * No retry, no wait, and no cursor or pause state is written here.
 */
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

type Sb = { from: (t: string) => any };

export async function logPausedRun<T>(
  sb: Sb,
  orgId: string,
  payload: () => Record<string, unknown>,
  tail: () => Promise<T>,
): Promise<T> {
  try {
    return await tail();
  } catch (e) {
    if (e instanceof XeroCooldownError) {
      // Its own try: a failed write never swallows the pause.
      try {
        const retryAt = typeof e.details?.retry_at === "string" ? e.details.retry_at : null;
        const { error } = await sb.from("webhook_log").insert({
          org_id: orgId,
          source: "xero",
          event_type: "sync_invoices",
          payload: { ...payload(), paused_by_xero: { code: e.code, status: e.status, retry_at: retryAt } },
          status: "paused",
        });
        if (error) console.error("[xero-sync] paused run log not written", JSON.stringify({ code: error.code ?? null }));
      } catch {
        console.error("[xero-sync] paused run log threw");
      }
    }
    throw e;
  }
}
