import {
  _resetAutomationLaneCacheForTest,
  automationLaneEnabled,
  contextActionLane,
  LANE_ANSWER_TTL_MS,
} from "./automation_switch.ts";
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`${actual} != ${expected}`);
}
function countingClient(
  answers: Array<{ data: unknown; error: unknown } | "throw">,
) {
  const client = {
    calls: 0,
    rpc: () => {
      const answer = answers[Math.min(client.calls, answers.length - 1)];
      client.calls++;
      if (answer === "throw") throw Error("transport");
      return Promise.resolve(answer);
    },
  };
  return client;
}
Deno.test("lane reads fail closed on errors and nonboolean values", async () => {
  for (const data of [null, undefined, "true", 1, {}, []]) {
    equal(
      await automationLaneEnabled({
        rpc: () => Promise.resolve({ data, error: null }),
      }, "capture"),
      false,
    );
  }
  equal(
    await automationLaneEnabled({
      rpc: () => Promise.resolve({ data: true, error: {} }),
    }, "attribution"),
    false,
  );
  equal(
    await automationLaneEnabled({
      rpc: () => {
        throw Error("transport");
      },
    }, "extraction"),
    false,
  );
});
Deno.test("ops capture action gate is bounded", () => {
  for (
    const action of ["backfill_ghl_conversations", "backfill_call_transcripts"]
  ) equal(contextActionLane(action), "capture");
  for (
    const action of [
      "job_detail",
      "invoice_context",
      "sync_suppliers",
      "send_payment_link",
    ]
  ) equal(contextActionLane(action), null);
  equal(contextActionLane("trigger_xero_sync"), null);
});

Deno.test("lane answer: two calls with the same client and lane make one rpc", async () => {
  const client = countingClient([{ data: true, error: null }]);
  equal(await automationLaneEnabled(client, "capture", 1_000), true);
  equal(await automationLaneEnabled(client, "capture", 1_000 + 44_999), true);
  equal(client.calls, 1);
});
Deno.test("lane answer: a call 45,001 ms later asks again", async () => {
  const client = countingClient([
    { data: true, error: null },
    { data: false, error: null },
  ]);
  equal(await automationLaneEnabled(client, "capture", 1_000), true);
  equal(
    await automationLaneEnabled(
      client,
      "capture",
      1_000 + LANE_ANSWER_TTL_MS + 1,
    ),
    false,
  );
  equal(client.calls, 2);
});
Deno.test("lane answer: an rpc error or throw reads off and is not remembered", async () => {
  const client = countingClient([
    { data: true, error: { message: "boom" } },
    "throw",
    { data: true, error: null },
  ]);
  equal(await automationLaneEnabled(client, "capture", 1_000), false);
  equal(await automationLaneEnabled(client, "capture", 1_001), false);
  equal(await automationLaneEnabled(client, "capture", 1_002), true);
  equal(client.calls, 3);
});
Deno.test("lane answer: off is remembered as off for 45 seconds", async () => {
  const client = countingClient([
    { data: false, error: null },
    { data: true, error: null },
  ]);
  equal(await automationLaneEnabled(client, "closeout", 1_000), false);
  equal(await automationLaneEnabled(client, "closeout", 1_000 + 44_999), false);
  equal(client.calls, 1);
  equal(await automationLaneEnabled(client, "closeout", 1_000 + 45_000), true);
  equal(client.calls, 2);
});
Deno.test("lane answer: lanes are remembered separately", async () => {
  const client = countingClient([{ data: true, error: null }]);
  await automationLaneEnabled(client, "capture", 1_000);
  await automationLaneEnabled(client, "attribution", 1_000);
  equal(client.calls, 2);
});
Deno.test("lane answer: two clients do not share an answer without EdgeRuntime", async () => {
  // deno-lint-ignore no-explicit-any
  equal("EdgeRuntime" in (globalThis as any), false);
  const a = countingClient([{ data: true, error: null }]);
  const b = countingClient([{ data: false, error: null }]);
  equal(await automationLaneEnabled(a, "capture", 1_000), true);
  equal(await automationLaneEnabled(b, "capture", 1_000), false);
  equal(a.calls, 1);
  equal(b.calls, 1);
});
Deno.test("lane answer: inside EdgeRuntime one answer is shared by every client", async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  g.EdgeRuntime = { waitUntil: () => {} };
  _resetAutomationLaneCacheForTest();
  try {
    const a = countingClient([{ data: true, error: null }]);
    const b = countingClient([{ data: false, error: null }]);
    equal(await automationLaneEnabled(a, "capture", 1_000), true);
    equal(await automationLaneEnabled(b, "capture", 1_001), true);
    equal(b.calls, 0);
  } finally {
    delete g.EdgeRuntime;
    _resetAutomationLaneCacheForTest();
  }
});
