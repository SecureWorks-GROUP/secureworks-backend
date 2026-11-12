// An accepted quote moves the GHL opportunity on. The opportunity sits in the trade's SALES pipeline,
// and the accept used to send ghl-proxy move_stage { status: 'accepted' }, which resolves to an
// EXECUTION pipeline stage. GHL refuses a stage from another pipeline (400 OPPORTUNITY_STAGE_ID_INVALID),
// ghl-proxy answers HTTP 200 { success: false }, and the accept never read the reply, so it logged
// "GHL stage pushed to accepted" while the opportunity stayed at Quote Sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ghlMoveStageOutcome,
  QUOTE_ACCEPTED_STAGE_ID,
  QUOTE_SENT_STAGE_ID,
  quoteAcceptedStageId,
} from "./ghl_email_note.ts";

const SEND_QUOTE = new URL("./index.ts", import.meta.url);
const GHL_PROXY = new URL("../ghl-proxy/index.ts", import.meta.url);

/** The accept path's stage push, as the source reads. */
async function acceptStagePush(): Promise<string> {
  const src = await Deno.readTextFile(SEND_QUOTE);
  const start = src.indexOf("// Push GHL stage (only when fully accepted)");
  assert(start > 0, "the accept path's stage push is found");
  const end = src.indexOf("// ── Send client comms trigger: quote_accepted", start);
  assert(end > start, "the stage push ends before the comms trigger");
  return src.slice(start, end);
}

Deno.test("an accepted quote moves to the trade's SALES accepted stage, not an Execution stage", () => {
  assertEquals(quoteAcceptedStageId("fencing"), "338b7dd7-7220-4abc-bc0b-b8d9ea44f40e");
  assertEquals(quoteAcceptedStageId("patio"), "a0f3002f-db71-4b69-842a-12930bdd7591");
  assertEquals(quoteAcceptedStageId("decking"), QUOTE_ACCEPTED_STAGE_ID.patio);
  assertEquals(quoteAcceptedStageId("miscellaneous"), null);
  assertEquals(quoteAcceptedStageId(null), null);
});

Deno.test("the accepted stage is not one of ghl-proxy's Execution stages (the stage GHL refused)", async () => {
  const proxy = await Deno.readTextFile(GHL_PROXY);
  const start = proxy.indexOf("const PRODUCTION_OPS_TO_GHL_STAGES");
  const table = proxy.slice(start, proxy.indexOf("\n}\n", start));
  assert(table.includes("c1615373-9140-4e49-92aa-aa0cfa8e9793"), "Execution 'accepted' stage is in the table");
  for (const id of Object.values(QUOTE_ACCEPTED_STAGE_ID)) {
    assert(!table.includes(id), `${id} is a sales stage, not an Execution stage`);
  }
  for (const t of ["fencing", "patio"] as const) {
    const sent: string[] = Object.values(QUOTE_SENT_STAGE_ID);
    assert(!sent.includes(QUOTE_ACCEPTED_STAGE_ID[t]), `${t}: accepted is not Quote Sent`);
  }
});

Deno.test("the accept sends the sales stage id, never status 'accepted'", async () => {
  const push = await acceptStagePush();
  assert(push.includes("quoteAcceptedStageId(job?.type)"), "the stage comes from the accepted-stage table");
  assert(push.includes("stageId: acceptedStageId"), "move_stage is given the stage id");
  assertEquals(push.includes("status: 'accepted'"), false, "no Execution-stage status lookup");
});

Deno.test("the accept reads the move_stage reply and never logs a refusal as a move", async () => {
  const push = await acceptStagePush();
  assert(push.includes("ghlMoveStageOutcome(stageRes.status"), "the reply is read");
  assertEquals(push.includes("GHL stage pushed to accepted"), false, "no unconditional success line");
  assert(/if \(stageOutcome\.moved\)[\s\S]*refused/.test(push), "a refusal is logged as refused");
});

Deno.test("ghl-proxy's in-band refusal (HTTP 200, success false) is not a move", () => {
  // The reply GHL's 400 produced on the live accept, as ghl-proxy relayed it.
  const refused = ghlMoveStageOutcome(200, {
    success: false,
    error: 'GHL 400: {"statusCode":400,"message":"stageId must be one of the following values: ...","code":"OPPORTUNITY_STAGE_ID_INVALID"}',
  });
  assertEquals(refused.moved, false);
  assert(refused.reason?.includes("OPPORTUNITY_STAGE_ID_INVALID"));
  assertEquals(ghlMoveStageOutcome(200, { success: true, stageId: "x" }), { moved: true, reason: null });
  assertEquals(ghlMoveStageOutcome(400, { error: "No GHL stage" }).moved, false);
  assertEquals(ghlMoveStageOutcome(200, null), { moved: false, reason: "HTTP 200" });
});
