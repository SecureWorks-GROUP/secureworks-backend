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

function deps(jobStatus: string, events: unknown[]): GhlWebhookDeps {
  const table = (name: string) => ({
    insert: (row: unknown) => {
      if (name === "job_events") events.push(row);
      return Promise.resolve({ error: null });
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
