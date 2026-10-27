// Paid close-out (13 Oct 2026): a GHL stage event can never pull a card out of Get Review
// or off the archive. Before get_review and archived were ranked, both read as rank 0, so
// any mapped GHL stage counted as a forward move.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type GhlWebhookDeps, handleGhlWebhook } from "./handler.ts";

const SECRET = "test-webhook-secret";
const PATIO_EXECUTION = "SxayUz0KRDlCUk58apCC";
const GHL_GET_GOOGLE_REVIEW = "9ea58244-5fb3-4242-8a8c-27e1f323b5ca"; // maps to complete
const GHL_INVOICE_SENT = "0276706b-faeb-44ff-b049-efce11a96a7f"; // maps to invoiced

function stageChange(stageId: string): Request {
  return new Request("http://ghl-webhook.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": SECRET },
    body: JSON.stringify({
      type: "OpportunityStageUpdate",
      opportunityId: "opp-1",
      pipelineId: PATIO_EXECUTION,
      pipelineStageId: stageId,
    }),
  });
}

// supabase-js query builders are thenables with no .catch, so the fake insert is too.
function builder<T>(result: T): PromiseLike<T> {
  return {
    then: (onFulfilled, onRejected) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
}

function deps(
  jobStatus: string,
  events: unknown[],
  jobEventsError: { message: string } | null = null,
): GhlWebhookDeps {
  const table = (name: string) => ({
    insert: (row: unknown) => {
      if (name === "job_events") events.push(row);
      return builder({ error: name === "job_events" ? jobEventsError : null });
    },
    select: () => ({
      eq: () => ({
        limit: () =>
          Promise.resolve({
            data: [{
              id: "job-1",
              status: jobStatus,
              type: "patio",
              ghl_opportunity_id: "opp-1",
            }],
            error: null,
          }),
      }),
    }),
  });
  return {
    env: (name) => (name === "GHL_WEBHOOK_SECRET" ? SECRET : undefined),
    createSupabase: () => ({ from: table }),
  };
}

for (const status of ["get_review", "archived"]) {
  for (const stage of [GHL_GET_GOOGLE_REVIEW, GHL_INVOICE_SENT]) {
    Deno.test(`a GHL stage event cannot move a ${status} card backwards (${stage.slice(0, 8)})`, async () => {
      const events: unknown[] = [];
      const res = await handleGhlWebhook(
        stageChange(stage),
        deps(status, events),
      );
      const body = await res.json();
      assertEquals(body.action, "conflict_logged");
      assertEquals(body.current, status);
      assertEquals(events.length, 1);
    });
  }
}

// Deposit advance (26 Oct 2026): awaiting_deposit and order_materials used to be unranked
// (0), so GHL's "Job Accepted Ready for Execution" (mapped to accepted) read as a forward
// move and pulled the card back to Accepted.
const GHL_PATIO_READY_TO_EXECUTE = "66742bf8-4917-406c-a1c1-33ac271cfe09"; // maps to accepted
for (
  const status of [
    "awaiting_deposit",
    "deposit",
    "approvals",
    "order_materials",
    "processing",
    "awaiting_supplier",
    "order_confirmed",
    "schedule_install",
  ]
) {
  Deno.test(`a GHL stage mapped to accepted cannot pull a ${status} card back`, async () => {
    const events: unknown[] = [];
    const res = await handleGhlWebhook(
      stageChange(GHL_PATIO_READY_TO_EXECUTE),
      deps(status, events),
    );
    const body = await res.json();
    assertEquals(body.action, "conflict_logged");
    assertEquals(body.current, status);
    assertEquals(events.length, 1);
  });
}

Deno.test("every stored job status has a rank", async () => {
  const { STATUS_RANK } = await import("./handler.ts");
  const { STATUS_MAP } = await import(
    "../_shared/stage-gate/job-state-machine.ts"
  );
  for (const status of Object.keys(STATUS_MAP)) {
    assertEquals(
      typeof STATUS_RANK[status],
      "number",
      `unranked status ${status}`,
    );
  }
});

Deno.test("a backward move writes its ghl_conflict event and answers 200", async () => {
  const events: { event_type?: string }[] = [];
  const res = await handleGhlWebhook(
    stageChange(GHL_PATIO_READY_TO_EXECUTE),
    deps("order_materials", events),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).action, "conflict_logged");
  assertEquals(events.map((e) => e.event_type), ["ghl_conflict"]);
});

Deno.test("a failed ghl_conflict write is logged and the card still stays put with a 200", async () => {
  const events: unknown[] = [];
  const res = await handleGhlWebhook(
    stageChange(GHL_PATIO_READY_TO_EXECUTE),
    deps("awaiting_deposit", events, { message: "insert refused" }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "conflict_logged");
  assertEquals(body.current, "awaiting_deposit");
});
