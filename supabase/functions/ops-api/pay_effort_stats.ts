import { payRunCheckParams } from "./trade_pay_run_check.ts";

export class EffortStatsUnreadable extends Error {
  constructor() {
    super("effort_stats_unreadable");
  }
}

export async function readPayEffortStats(
  client: {
    rpc: (
      name: string,
      args: object,
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  weeks: string | null,
  orgId: string | null,
) {
  const params = payRunCheckParams(null, weeks?.trim() || "8", orgId);
  try {
    const { data, error } = await client.rpc("pay_effort_stats", {
      p_weeks: params.p_weeks,
      p_org_id: params.p_org_id,
    });
    if (
      error || !Array.isArray(data) || data.length !== params.p_weeks ||
      data.some((week) =>
        !week || typeof week.sent !== "number" ||
        !Array.isArray(week.held) ||
        typeof week.told_no_after_sent?.invoices !== "number"
      )
    ) {
      throw new EffortStatsUnreadable();
    }
    return { ok: true, target_share: 0.05, weeks: data };
  } catch {
    throw new EffortStatsUnreadable();
  }
}
