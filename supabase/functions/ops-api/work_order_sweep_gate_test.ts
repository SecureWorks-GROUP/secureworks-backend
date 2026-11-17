import { readSwitches } from "../_shared/switch_cache.ts";
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Execute the production action with local sweep dependencies and no server.
const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const action = source.split("case 'auto_issue_job_work_orders': {")[1]
  .split(/\n\s*case /)[0];
const body = action.slice(0, action.lastIndexOf("}"))
  .replaceAll(": Record<string, unknown>", "")
  .replaceAll(": unknown[]", "")
  .replaceAll(": unknown", "")
  .replaceAll(" as Error", "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction(
  "client", "url", "authMode", "serverSecretPresented", "req", "body", "json",
  "readSwitches", "openMissingPatioWorkOrders", "openMissingFenceWorkOrders",
  "runJobWorkOrder", "autoIssueJobWorkOrders", "autoGroupPatioJobs", "autoGroupFenceJobs",
  "readyUnreleasedGroupInvoiceIds", "releaseGroupCrewBills", body,
);

Deno.test("work order sweep confirms only a valid successful sweep and reports RPC failure", async () => {
  const token = "a".repeat(32);
  for (const scenario of [
    { query: `gate=job-work-order-auto-issue&gate_token=${token}`, confirmed: true },
    { query: "", confirmed: false },
    { query: `gate=other&gate_token=${token}`, confirmed: false },
    { query: "gate=job-work-order-auto-issue&gate_token=invalid", confirmed: false },
    { query: `gate=job-work-order-auto-issue&gate_token=${token}`, releaseError: true, confirmed: false },
    { query: `gate=job-work-order-auto-issue&gate_token=${token}`, xeroPushError: true, confirmed: false },
    { query: `gate=job-work-order-auto-issue&gate_token=${token}`, rpcError: true, confirmed: false },
    { query: `gate=job-work-order-auto-issue&gate_token=${token}`, issueError: true, confirmed: false },
  ]) {
    const calls: unknown[] = [];
    const client = { rpc: (name: string, args: unknown) => {
      calls.push([name, args]);
      return Promise.resolve({ error: scenario.rpcError ? { message: "contract refusal" } : null });
    } };
    const empty = () => Promise.resolve({});
    const invoke = () => run(
      client, new URL(`https://example.invalid/?${scenario.query}`), "api_key", true,
      { method: "POST" }, {}, (value: unknown) => value, () => Promise.resolve({ sweep_gate_v1: true }), empty, empty,
      (fn: () => unknown) => fn(),
      () => scenario.issueError ? Promise.reject(new Error("issue failed")) : Promise.resolve({ issued: 1 }),
      empty, empty, () => Promise.resolve(["invoice-fixture"]),
      () => Promise.resolve(scenario.releaseError ? { error: "release failed" } : scenario.xeroPushError ? { xero_push_error: "push failed" } : { success: true }),
    );
    if (scenario.issueError) {
      await assertRejects(invoke, Error, "issue failed");
    } else {
      const result = await invoke();
      assertEquals(result.gate_confirmed, scenario.confirmed);
      assertEquals(result.issued, 1);
    }
    assertEquals(calls, scenario.confirmed || scenario.rpcError
      ? [["sweep_gate_confirm", { p_name: "job-work-order-auto-issue", p_token: token }]]
      : []);
  }
});

Deno.test("work order sweep with gate off makes one switch read and no confirmation call", async () => {
  let switchReads = 0;
  const calls: unknown[] = [];
  const client = {
    from: (table: string) => {
      assertEquals(table, "feature_flags");
      switchReads++;
      return { select: () => ({ in: (_column: string, names: string[]) => {
        assertEquals(names.includes("sweep_gate_v1"), true);
        return Promise.resolve({ data: [], error: null });
      } }) };
    },
    rpc: (name: string, args: unknown) => {
      calls.push([name, args]);
      return Promise.resolve({ error: null });
    },
  };
  const empty = () => Promise.resolve({});
  const result = await run(
    client,
    new URL(`https://example.invalid/?gate=job-work-order-auto-issue&gate_token=${"a".repeat(32)}`),
    "api_key", true, { method: "POST" }, {}, (value: unknown) => value,
    readSwitches, empty, empty, (fn: () => unknown) => fn(),
    () => Promise.resolve({ issued: 1 }), empty, empty,
    () => Promise.resolve(["invoice-fixture"]),
    () => Promise.resolve({ success: true }),
  );
  assertEquals(result.issued, 1);
  assertEquals(result.group_releases, [{ invoice_id: "invoice-fixture", success: true }]);
  assertEquals(result.gate_confirmed, false);
  assertEquals(switchReads, 1);
  assertEquals(calls, []);
});
