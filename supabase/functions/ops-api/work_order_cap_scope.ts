// Follow-up 49 item 9(b): the work order cap reaches only jobs whose job work
// order was approved on or after the start date in work_order_cap_settings, and
// (director ruling, 18 Nov 2026) jobs created on or after it with no approved
// order, whose lines still go to the office. No start date: no job is capped. The rule lives once, in the database
// function work_order_cap_scope, which the cap guard triggers call directly and
// this reader calls by RPC for the send's sorter, my_hours and the office list.
// deno-lint-ignore-file no-explicit-any

export class WorkOrderCapScopeUnreadable extends Error {
  constructor() {
    super("work order cap scope unreadable");
    this.name = "WorkOrderCapScopeUnreadable";
  }
}

/** Whether each job is under the cap. Every requested job gets an answer; a
 * failed, short, duplicated or malformed answer throws, never defaults either
 * way. Reads work_order_cap_settings_pkey and uq_work_orders_job_current per
 * job, 25 jobs a call. */
export async function readWorkOrderCapScope(
  client: any,
  jobIds: readonly string[],
): Promise<Map<string, boolean>> {
  const ids = [...new Set(jobIds.map(String).filter(Boolean))];
  const scope = new Map<string, boolean>();
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    let result: any;
    try {
      result = await client.rpc("work_order_cap_scope", { p_job_ids: batch });
    } catch {
      throw new WorkOrderCapScopeUnreadable();
    }
    if (
      result?.error || !Array.isArray(result?.data) ||
      result.data.length !== batch.length
    ) throw new WorkOrderCapScopeUnreadable();
    for (const row of result.data) {
      const id = String(row?.job_id ?? "");
      if (
        !batch.includes(id) || scope.has(id) ||
        typeof row?.in_scope !== "boolean"
      ) throw new WorkOrderCapScopeUnreadable();
      scope.set(id, row.in_scope);
    }
  }
  return scope;
}

/** Follow-up 49 item 9(b), the older code cap (_assertWithinWorkOrderTotal,
 * index.ts): with trade_line_hold_v1 on, the given jobs work_order_cap_scope
 * puts under the cap; with it off, every job given, as before. The switch is
 * read strictly here: a failed read throws, never reads as off or on.
 * feature_flags_pkey, then work_order_cap_scope. */
export async function capScopedJobIds(
  client: any,
  jobIds: readonly string[],
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  let flag: any;
  try {
    flag = await client.from("feature_flags").select("enabled")
      .eq("flag_name", "trade_line_hold_v1").limit(1);
  } catch {
    throw new WorkOrderCapScopeUnreadable();
  }
  if (flag?.error || !Array.isArray(flag?.data)) {
    throw new WorkOrderCapScopeUnreadable();
  }
  if (flag.data[0]?.enabled !== true) return [...jobIds];
  const scope = await readWorkOrderCapScope(client, jobIds);
  return jobIds.filter((id) => scope.get(String(id)) === true);
}
