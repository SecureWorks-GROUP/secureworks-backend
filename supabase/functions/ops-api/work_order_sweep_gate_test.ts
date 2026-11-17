import { readSwitches } from "../_shared/switch_cache.ts";
import { autoIssueJobWorkOrderForJob } from "./job_work_orders.ts";
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Execute the production action with local sweep dependencies and no server.
const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const action = source.split("case 'auto_issue_job_work_orders': {")[1]
  .split(/\n      case '/)[0];
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
      () => Promise.resolve(scenario.releaseError ? { error: "release failed" } : { success: true }),
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

Deno.test("work order sweep does not confirm a swallowed automatic issue failure", async () => {
  const failed = await autoIssueJobWorkOrderForJob({
    from: () => { throw new Error("fixture job read failed"); },
  }, "11111111-1111-4111-8111-111111111111", { flagOn: true });
  assertEquals(failed.reason, "issue_failed");
  const issued = { issued: 0, not_issued: { issue_failed: 1 }, results: [failed] };
  const calls: unknown[] = [];
  const empty = () => Promise.resolve({});
  const result = await run(
    { rpc: (name: string) => { calls.push(name); return { error: null }; } },
    new URL(`https://example.invalid/?gate=job-work-order-auto-issue&gate_token=${"a".repeat(32)}`),
    "api_key", true, { method: "POST" }, {}, (value: unknown) => value,
    () => Promise.resolve({ sweep_gate_v1: true }), empty, empty,
    (fn: () => unknown) => fn(), () => Promise.resolve(issued), empty, empty,
    () => Promise.resolve([]), empty,
  );
  assertEquals(result.results, [failed]);
  assertEquals(result.gate_confirmed, false);
  assertEquals(calls, []);
});

Deno.test("work order sweep does not confirm a returned Xero push error", async () => {
  const calls: unknown[] = [];
  const empty = () => Promise.resolve({});
  const release = { released: false, xero_push_error: "fixture release not recorded" };
  const result = await run(
    { rpc: (name: string) => { calls.push(name); return { error: null }; } },
    new URL(`https://example.invalid/?gate=job-work-order-auto-issue&gate_token=${"a".repeat(32)}`),
    "api_key", true, { method: "POST" }, {}, (value: unknown) => value,
    () => Promise.resolve({ sweep_gate_v1: true }), empty, empty,
    (fn: () => unknown) => fn(), empty, empty, empty,
    () => Promise.resolve(["invoice-fixture"]), () => Promise.resolve(release),
  );
  assertEquals(result.group_releases, [{ invoice_id: "invoice-fixture", ...release }]);
  assertEquals(result.gate_confirmed, false);
  assertEquals(calls, []);
});

for (const scenario of [
  { name: "own unconfirmed bill", release: { released: true, xero_push: "unconfirmed" }, confirms: false },
  { name: "sibling push error", release: { released: true, crew_bills: [{ xero_push_error: "fixture failure" }] }, confirms: false },
  { name: "sibling unconfirmed bill", release: { released: true, crew_bills: [{ xero_push: "unconfirmed" }] }, confirms: false },
  { name: "held crew", release: { released: false, hold: ["awaiting_submission"] }, confirms: true },
  { name: "confirmed crew", release: { released: true, xero_push: { success: true }, crew_bills: [{ xero_push: { success: true } }] }, confirms: true },
]) {
  Deno.test(`work order sweep classifies ${scenario.name} without changing release calls`, async () => {
    for (const gateOn of [true, false]) {
      const confirmations: unknown[] = [];
      const pushes: unknown[] = [];
      const empty = () => Promise.resolve({});
      const issue = { issued: 0, results: [{ reason: "owner_approval_required" }] };
      const client = { rpc: (name: string) => { confirmations.push(name); return { error: null }; } };
      const result = await run(
        client,
        new URL(`https://example.invalid/?gate=job-work-order-auto-issue&gate_token=${"a".repeat(32)}`),
        "api_key", true, { method: "POST" }, {}, (value: unknown) => value,
        () => Promise.resolve({ sweep_gate_v1: gateOn }), empty, empty,
        (fn: () => unknown) => fn(), () => Promise.resolve(issue), empty, empty,
        () => Promise.resolve(["invoice-fixture", "invoice-next"]),
        (...args: unknown[]) => { pushes.push(args); return Promise.resolve(scenario.release); },
      );
      assertEquals(result, {
        ...issue,
        group_releases: ["invoice-fixture", "invoice-next"].map(invoice_id => ({ invoice_id, ...scenario.release })),
        patio_drafts: {}, patio_groups: {}, fence_drafts: {}, fence_groups: {},
        gate_confirmed: gateOn && scenario.confirms,
      });
      assertEquals(pushes, [
        [client, "invoice-fixture", "group-release-sweep"],
        [client, "invoice-next", "group-release-sweep"],
      ]);
      assertEquals(confirmations, gateOn && scenario.confirms ? ["sweep_gate_confirm"] : []);
    }
  });
}
