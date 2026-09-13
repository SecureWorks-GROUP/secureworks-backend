/**
 * First-slice persist proof: case + draft through the real handler, then reload.
 * Uses digest case ids only. No provider writes.
 */
import { persistDraft, createMemoryBookingDb, type BookingActor } from "./sales_booking.ts";

const ACTOR: BookingActor = {
  org_id: "00000000-0000-0000-0000-000000000001",
  user_id: "slice1-operator",
  role: "admin",
};

const CASE_ID = "fe37f9c57a85130f";
const TEXT = "AI-proposed Thursday 1:00pm. Customer date unspecified.";

const db = createMemoryBookingDb();
await db.upsert("sales_booking_cases", {
  id: CASE_ID,
  org_id: ACTOR.org_id,
  resource_id: "nithin",
  opportunity_id: CASE_ID,
  status: "needs_decision",
  display_name: "Enquiry",
});
const saved = await persistDraft(db, {
  case_id: CASE_ID,
  text: TEXT,
  human_edited: true,
  sender: "+61489267774",
  expected_revision: 0,
}, ACTOR) as { revision: number; text: string; case_id: string };
if (saved.revision !== 1 || saved.text !== TEXT) {
  throw new Error("first persist did not acknowledge revision 1");
}
let conflicted = false;
try {
  await persistDraft(db, { case_id: CASE_ID, text: TEXT, expected_revision: 0 }, ACTOR);
} catch (e) {
  conflicted = (e as { code?: string }).code === "cas_conflict";
}
if (!conflicted) throw new Error("stale expected_revision 0 did not CAS-conflict");
const reloaded = (await db.selectMatch("sales_booking_drafts", { case_id: CASE_ID, org_id: ACTOR.org_id })).data[0];
if (!reloaded || reloaded.text !== TEXT || Number(reloaded.revision) !== 1) {
  throw new Error("reload lost acknowledged draft");
}
const proof = {
  ok: true,
  handler: "persistDraft",
  case_id: CASE_ID,
  revision: saved.revision,
  cas_conflict_on_stale: true,
  reloaded_text_matches: true,
  send: "held",
};
console.log(JSON.stringify(proof));
