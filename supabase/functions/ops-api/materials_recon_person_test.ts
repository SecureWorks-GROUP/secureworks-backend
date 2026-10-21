// JP-12 (20261021173000): only a signed-in session places, splits or marks a
// bill in Bills to place.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveRequestActor } from "../_shared/request_actor.ts";
import {
  billPlacementPerson,
  billPlacementRefusal,
  RECORDED_PERSON_REQUIRED,
} from "./materials_recon_person.ts";

const USER = "00000000-0000-4000-8000-00000000a001";

function headers(actor?: string): Headers {
  const h = new Headers();
  if (actor !== undefined) h.set("x-sw-actor", actor);
  return h;
}

Deno.test("a signed-in session is the person, as user:<id>", () => {
  const actor = resolveRequestActor({
    verifiedUserId: USER,
    headers: headers("ops_dashboard"),
    trustActorHeader: false,
  });
  assertEquals(billPlacementPerson(actor, "jwt"), `user:${USER}`);
});

Deno.test("a server key with x-sw-actor is a claim, never a person, whatever it names", () => {
  for (
    const claimed of [
      `user:${USER}`,
      "marnin@secureworkswa.com.au",
      "ops_dashboard",
      "xero-sync",
      "cfo_agent",
      "Marnin",
      `person:${USER}`,
    ]
  ) {
    const actor = resolveRequestActor({
      headers: headers(claimed),
      trustActorHeader: true,
    });
    assertEquals(billPlacementPerson(actor, "api_key"), null, claimed);
  }
});

Deno.test("no actor, a malformed header, a routine and an agent read are refused", () => {
  const none = resolveRequestActor({
    headers: headers(),
    trustActorHeader: true,
  });
  assertEquals(billPlacementPerson(none, "api_key"), null);
  const bad = resolveRequestActor({
    headers: headers("Marnin Stobbe"),
    trustActorHeader: true,
  });
  assertEquals(billPlacementPerson(bad, "api_key"), null);
  const routine = resolveRequestActor({
    headers: headers(),
    trustActorHeader: false,
  });
  assertEquals(billPlacementPerson(routine, "routine"), null);
  assertEquals(billPlacementPerson(routine, "agent_read"), null);
  assertEquals(billPlacementPerson(routine, "none"), null);
});

Deno.test("a jwt mode with a non-session actor is refused (defence in depth)", () => {
  assertEquals(
    billPlacementPerson({
      actor: `user:${USER}`,
      source: "header",
      missing: false,
    }, "jwt"),
    null,
  );
  assertEquals(
    billPlacementPerson({
      actor: "actor_missing",
      source: "none",
      missing: true,
    }, "jwt"),
    null,
  );
  assertEquals(
    billPlacementPerson({
      actor: "user:not-a-uuid",
      source: "jwt",
      missing: false,
    }, "jwt"),
    null,
  );
});

Deno.test("the refusal names the action and its code, and says nothing was written", () => {
  const r = billPlacementRefusal("materials_recon_split");
  assertEquals(r.ok, false);
  assertEquals(r.code, RECORDED_PERSON_REQUIRED);
  assertEquals(r.error.includes("materials_recon_split"), true);
  assertEquals(r.error.includes("Nothing was written"), true);
});
